import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  isAntigravityAuthRequiredError,
  parseAntigravitySessionState,
  withAntigravityAcp,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  AntigravitySessionState,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel, errorMessage } from '@/shared/utils.js';

/**
 * Model catalog for Antigravity.
 *
 * agy has no model listing that works without a session, and its list depends
 * on the signed-in account's plan, so the catalog is read from agy itself:
 *
 * 1. `session/new` over ACP in an empty scratch directory, then
 *    `session/close`. Verified against agy 1.5.19: a session that was never
 *    prompted is not listed by `session/list`, so this leaves nothing in the
 *    user's conversation list. Its result names every model with the effort
 *    baked in (`gemini-4-neon-high`) and a `model` config option naming the
 *    families (`gemini-4-neon`), which is how the picker shows them: one row
 *    per family, with the family's levels as reasoning effort.
 * 2. `agy models` (one `<id>\t<name>` line per model), when ACP fails.
 * 3. A fixed list of what agy 1.5.19 offered a Google AI Pro account, when
 *    agy is not installed or not signed in, so the picker is never empty.
 *
 * The answer is cached for ten minutes (thirty seconds after a failure) per
 * home directory, the scope agy keeps its sign-in in.
 */

/** Reasoning-effort levels agy encodes as model id suffixes, weakest first. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const EFFORT_SUFFIX_PATTERN = /^(.+)-(low|medium|high|xhigh|max)$/;
const EFFORT_LABEL_SUFFIX_PATTERN = /\s*\((low|medium|high|xhigh|max)\)\s*$/i;

const CATALOG_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 30_000;
const MODELS_COMMAND_TIMEOUT_MS = 30_000;

type CachedCatalog = {
  home: string;
  expiresAt: number;
  catalog: ProviderModelsDefinition;
  tierName: string | null;
  /** False for the built-in fallback list. */
  fromAgy: boolean;
};

let cachedCatalog: CachedCatalog | null = null;
let inFlightDiscovery: Promise<CachedCatalog> | null = null;

/**
 * What agy 1.5.19 offered a signed-in Google AI Pro account (observed
 * 2026-11-28). Used only while agy cannot be asked.
 */
const FALLBACK_MODELS: Array<{ modelId: string; name: string }> = [
  ...['low', 'medium', 'high', 'xhigh'].map((level) => ({ modelId: `gemini-4-neon-${level}`, name: 'Gemini 4 Neon' })),
  ...['low', 'medium', 'high'].map((level) => ({ modelId: `gemini-4-carbon-${level}`, name: 'Gemini 4 Carbon' })),
  ...['low', 'medium', 'high'].map((level) => ({ modelId: `gemini-4-argon-${level}`, name: 'Gemini 4 Argon' })),
  ...['low', 'medium', 'high', 'xhigh'].map((level) => ({ modelId: `gemini-4-hydrogen-${level}`, name: 'Gemini 4 Hydrogen' })),
  { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
  { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { modelId: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)' },
  ...['low', 'medium', 'high'].map((level) => ({ modelId: `gemini-3.8-flash-${level}`, name: 'Gemini 3.8 Flash' })),
  ...['low', 'medium', 'high'].map((level) => ({ modelId: `claude-opus-5-5-${level}`, name: 'Claude Opus 5.5' })),
  ...['low', 'medium', 'high'].map((level) => ({ modelId: `claude-sonnet-5-5-${level}`, name: 'Claude Sonnet 5.5' })),
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

const FALLBACK_DEFAULT_FAMILY = 'gemini-4-neon';

/**
 * Builds the picker catalog from what agy reported: one option per model
 * family, whose effort values are the levels agy offers for it (`low` ... `max`,
 * the suffixes of its model ids). A family agy offers at one fixed level
 * (`gpt-oss-120b-medium`) or without levels (`gemini-pro-orchestrator`) has
 * no effort. The current family is the default and gets agy's current level
 * as its default effort.
 *
 * Families come from the `model` config option when agy sends one, else from
 * grouping the model ids by their effort suffix.
 *
 * Exported for tests only.
 */
export function buildAntigravityModelCatalog(
  state: Pick<AntigravitySessionState, 'availableModels' | 'configOptions' | 'currentModelId'>,
): ProviderModelsDefinition {
  const modelIds = new Set(state.availableModels.map((model) => model.modelId));
  const modelOption = state.configOptions.find((option) => option.category === 'model' || option.id === 'model');
  const thoughtOption = state.configOptions.find(
    (option) => option.category === 'thought_level' || option.id === 'thought_level',
  );

  type Family = { value: string; label: string };
  const families: Family[] = [];
  const seenFamilies = new Set<string>();
  const addFamily = (value: string, label: string) => {
    if (!seenFamilies.has(value)) {
      seenFamilies.add(value);
      families.push({ value, label });
    }
  };

  if (modelOption && modelOption.options.length > 0) {
    for (const option of modelOption.options) {
      addFamily(option.value, option.name);
    }
  } else {
    for (const model of state.availableModels) {
      const match = EFFORT_SUFFIX_PATTERN.exec(model.modelId);
      const familyId = match ? match[1] : model.modelId;
      const label = match ? model.name.replace(EFFORT_LABEL_SUFFIX_PATTERN, '') : model.name;
      addFamily(familyId, label);
    }
  }

  const currentMatch = state.currentModelId ? EFFORT_SUFFIX_PATTERN.exec(state.currentModelId) : null;
  const currentFamily = modelOption?.currentValue
    || (currentMatch ? currentMatch[1] : state.currentModelId)
    || families[0]?.value
    || FALLBACK_DEFAULT_FAMILY;
  const currentLevel = thoughtOption?.currentValue || (currentMatch ? currentMatch[2] : null);

  const options: ProviderModelOption[] = families.map((family) => {
    const levels = EFFORT_ORDER.filter((level) => modelIds.has(`${family.value}-${level}`));
    // A family that is itself a model id and has a single suffixed sibling
    // is still one fixed model, not a choice of one level.
    const offersLevels = levels.length > 0 && !(levels.length === 1 && modelIds.has(family.value));
    if (!offersLevels) {
      return { value: family.value, label: family.label };
    }
    const defaultLevel = family.value === currentFamily && currentLevel && levels.includes(currentLevel as typeof levels[number])
      ? currentLevel
      : undefined;
    return {
      value: family.value,
      label: family.label,
      effort: {
        ...(defaultLevel ? { default: defaultLevel } : {}),
        values: levels.map((level) => ({ value: level })),
      },
    };
  });

  return {
    OPTIONS: options,
    DEFAULT: options.some((option) => option.value === currentFamily) ? currentFamily : options[0]?.value ?? FALLBACK_DEFAULT_FAMILY,
  };
}

/**
 * Parses `agy models` output: a "Fetching available models..." banner, then
 * one `<model id>\t<name>` line per model. Exported for tests only.
 */
export function parseAgyModelsOutput(output: string): Array<{ modelId: string; name: string }> {
  const models: Array<{ modelId: string; name: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const [modelId, ...nameParts] = line.split('\t');
    const id = modelId?.trim();
    if (!id || nameParts.length === 0 || /\s/.test(id)) {
      continue;
    }
    models.push({ modelId: id, name: nameParts.join('\t').trim() || id });
  }
  return models;
}

function runAgyModels(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, ['models'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), MODELS_COMMAND_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

/**
 * The catalog shown while agy cannot be asked (not installed, not signed in).
 * Used by this provider and by the providers tests that check every curated
 * catalog against the capability matrix's effort levels.
 */
export const ANTIGRAVITY_PREDEFINED_MODELS: ProviderModelsDefinition = buildAntigravityModelCatalog({
  availableModels: FALLBACK_MODELS,
  configOptions: [],
  currentModelId: `${FALLBACK_DEFAULT_FAMILY}-high`,
});

async function discoverCatalog(home: string): Promise<CachedCatalog> {
  const fallback = (): CachedCatalog => ({
    home,
    expiresAt: Date.now() + FAILURE_TTL_MS,
    catalog: ANTIGRAVITY_PREDEFINED_MODELS,
    tierName: null,
    fromAgy: false,
  });

  const cli = resolveAntigravityCli();
  if (!cli) {
    return fallback();
  }

  try {
    // An empty directory of its own, so agy finds no project customizations
    // to load for a session nobody prompts.
    const scratchDir = path.join(os.tmpdir(), 'cloudcli-antigravity-models');
    await mkdir(scratchDir, { recursive: true });
    const state = await withAntigravityAcp({ cwd: scratchDir }, async (connection) => {
      const result = await connection.request('session/new', { cwd: scratchDir, mcpServers: [] }, { timeoutMs: 90_000 });
      const parsed = parseAntigravitySessionState(result);
      if (parsed.sessionId) {
        await connection.request('session/close', { sessionId: parsed.sessionId }, { timeoutMs: 10_000 }).catch(() => undefined);
      }
      return parsed;
    });
    if (state.availableModels.length > 0) {
      return {
        home,
        expiresAt: Date.now() + CATALOG_TTL_MS,
        catalog: buildAntigravityModelCatalog(state),
        tierName: state.tierName,
        fromAgy: true,
      };
    }
  } catch (error) {
    if (isAntigravityAuthRequiredError(error)) {
      // `agy models` needs the same sign-in; nothing more to ask.
      return fallback();
    }
    console.warn('[Antigravity] Could not read models over ACP, trying `agy models`:', errorMessage(error));
  }

  const listed = parseAgyModelsOutput(await runAgyModels(cli.command));
  if (listed.length > 0) {
    return {
      home,
      expiresAt: Date.now() + CATALOG_TTL_MS,
      catalog: buildAntigravityModelCatalog({ availableModels: listed, configOptions: [], currentModelId: listed[0].modelId }),
      tierName: null,
      fromAgy: true,
    };
  }
  return fallback();
}

async function loadCatalog(): Promise<CachedCatalog> {
  const home = os.homedir();
  if (cachedCatalog && cachedCatalog.home === home && cachedCatalog.expiresAt > Date.now()) {
    return cachedCatalog;
  }
  inFlightDiscovery ??= discoverCatalog(home)
    .then((catalog) => {
      cachedCatalog = catalog;
      return catalog;
    })
    .finally(() => {
      inFlightDiscovery = null;
    });
  return inFlightDiscovery;
}

/**
 * The account plan agy reported with the last model discovery ("Google AI
 * Pro"), or null. Used by the Antigravity auth facet to label the sign-in
 * without reading any credential.
 */
export function readCachedAntigravityTierName(): string | null {
  return cachedCatalog && cachedCatalog.home === os.homedir() ? cachedCatalog.tierName : null;
}

/**
 * Drops a cached catalog that no longer fits the sign-in: the built-in
 * fallback once agy is signed in, or agy's own list once it is signed out.
 * Used by the Antigravity auth facet after each sign-in check.
 */
export function syncAntigravityModelCatalogWithSignIn(authenticated: boolean): void {
  if (cachedCatalog && cachedCatalog.fromAgy !== authenticated) {
    cachedCatalog = null;
  }
}

export class AntigravityProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const { catalog } = await loadCatalog();
    return { OPTIONS: catalog.OPTIONS.map((option) => ({ ...option })), DEFAULT: catalog.DEFAULT };
  }

  /**
   * agy does not keep a session's model across processes (verified: a
   * reloaded session reports agy's default again), so the catalog default is
   * the only answer; the session row holds the real choice.
   */
  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}

