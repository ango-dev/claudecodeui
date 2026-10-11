import { readFile } from 'node:fs/promises';

import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  loadClaudeCodeInitialization,
  type ClaudeCodeInitialization,
} from '@/modules/providers/list/claude/claude-initialization.provider.js';
import {
  buildDefaultProviderCurrentActiveModel,
  isPlaceholderProviderModel,
  stripAnsiSequences,
} from '@/shared/utils.js';

/**
 * Ultracode is not one of the SDK's reasoning-effort levels. Selecting it runs the turn at
 * `xhigh` effort with standing dynamic-workflow orchestration, which the Claude runtime
 * translates into the session-scoped `ultracode` setting. It is therefore only offered on
 * models this catalog already marks as xhigh-capable.
 */
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

const ULTRACODE_EFFORT_OPTION = {
  value: CLAUDE_ULTRACODE_EFFORT,
  description: 'Highest effort plus standing workflow orchestration.',
};

export const CLAUDE_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Use the recommended model for your Claude account and deployment.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'best',
      label: 'Best available',
      description: 'Use Fable 5 when available, otherwise the latest Opus model.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable 5',
      description: 'Most capable Claude model for the hardest, longest-running tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Latest Sonnet model for everyday coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'sonnet[1m]',
      label: 'Sonnet (1M context)',
      description: 'Latest Sonnet model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Latest Opus model for complex reasoning and coding tasks.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'opus[1m]',
      label: 'Opus (1M context)',
      description: 'Latest Opus model with a 1M context window.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient Claude model for simple tasks.',
    },
    {
      value: 'opusplan',
      label: 'Opus Plan',
      description: 'Use Opus while planning, then switch to Sonnet for execution.',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
          ULTRACODE_EFFORT_OPTION,
        ],
      },
    },
  ],
  DEFAULT: 'default',
};

const FULL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LEVELS_WITHOUT_XHIGH = ['low', 'medium', 'high', 'max'];

/** Order of Claude Code's model menu; aliases it does not list keep the CLI's order after these. */
const PRIMARY_MODEL_ORDER = ['default', 'opus', 'fable', 'sonnet', 'haiku'];

/**
 * Earlier models Claude Code still accepts by full id, for the menu's "More
 * models" group, in the order Claude Code lists them. Effort levels follow
 * each model's API support; Haiku 4.5 has none.
 */
const PREVIOUS_CLAUDE_MODELS: { value: string; label: string; effortLevels: string[] }[] = [
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', effortLevels: [] },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', effortLevels: FULL_EFFORT_LEVELS },
  { value: 'claude-opus-5', label: 'Opus 5', effortLevels: FULL_EFFORT_LEVELS },
  { value: 'claude-fable-5', label: 'Fable 5', effortLevels: FULL_EFFORT_LEVELS },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', effortLevels: FULL_EFFORT_LEVELS },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', effortLevels: FULL_EFFORT_LEVELS },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', effortLevels: EFFORT_LEVELS_WITHOUT_XHIGH },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effortLevels: EFFORT_LEVELS_WITHOUT_XHIGH },
];

/** Claude Code recommends `high`; a model without it recommends its strongest level below. */
const buildEffort = (levels: string[]): ProviderModelOption['effort'] => {
  if (levels.length === 0) {
    return undefined;
  }
  const values = levels.map((value) => ({ value }));
  if (levels.includes('xhigh')) {
    values.push(ULTRACODE_EFFORT_OPTION);
  }
  return {
    default: levels.includes('high') ? 'high' : levels[levels.length - 1],
    values,
  };
};

/** "claude-opus-4-8" reads "Opus 4.8"; anything else is returned as is. */
const readableClaudeModelName = (model: string): string => {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|$)/.exec(model);
  if (!match) {
    return model;
  }
  const [, family, major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
};

/** A model id without its `[1m]` context suffix, so variants of one model compare equal. */
const baseModelId = (model: string): string => model.replace(/\[1m\]$/i, '');

type ClaudeCodeModel = ModelInfo & { resolvedModel?: string };

/**
 * Splits a Claude Code model entry into the name a person picks it by and a
 * short summary. Claude Code versions differ: some describe an alias as
 * "Opus 5.5 · Best for everyday, complex tasks", others give the name as
 * `displayName` and only the summary as `description`.
 */
const describeClaudeCodeModel = (model: ClaudeCodeModel): { name: string; summary?: string } => {
  const description = model.description?.trim() ?? '';
  const separator = description.indexOf(' · ');
  if (separator > 0) {
    return { name: description.slice(0, separator).trim(), summary: description.slice(separator + 3).trim() };
  }
  // "Default (recommended)" and bare aliases ("Opus") say less than the model they run.
  const resolved = model.resolvedModel ? readableClaudeModelName(baseModelId(model.resolvedModel)) : null;
  const displayName = model.displayName?.trim() ?? '';
  const isGenericName = !displayName || /^default\b/i.test(displayName) || !/\d/.test(displayName);
  const name = isGenericName ? (resolved ?? (displayName || model.value)) : displayName;
  return { name, summary: description || undefined };
};

/**
 * Turns Claude Code's model list into this app's catalog, laid out like
 * Claude Code's menu: Default and the current aliases (one entry per model
 * they run), then every other model under "More models", earlier models this
 * app knows of included. Default says what it runs ("Default (Opus 5.5)").
 * Exported for tests.
 */
export function buildClaudeModelsDefinition(models: ModelInfo[]): ProviderModelsDefinition {
  const rank = (value: string) => {
    const index = PRIMARY_MODEL_ORDER.indexOf(value);
    return index === -1 ? PRIMARY_MODEL_ORDER.length : index;
  };
  const entries = (models as ClaudeCodeModel[]).map((model) => ({
    model,
    ...describeClaudeCodeModel(model),
    // The model actually run: an alias's resolved id, or the id itself.
    runs: baseModelId(model.resolvedModel ?? model.value),
  }));
  const toOption = (entry: (typeof entries)[number], group?: 'more'): ProviderModelOption => ({
    value: entry.model.value,
    label: entry.model.value === 'default' ? `Default (${entry.name})` : entry.name,
    resolvesTo: entry.model.resolvedModel ?? entry.model.value,
    ...(entry.summary ? { description: entry.summary } : {}),
    ...(group ? { group } : {}),
    effort: entry.model.supportsEffort ? buildEffort(entry.model.supportedEffortLevels ?? []) : undefined,
  });

  // Aliases (`opus`, `sonnet[1m]`, ...) make the main list, one per model run;
  // Default always stays, as it is what a new session uses.
  const primary: ProviderModelOption[] = [];
  const primaryRuns = new Set<string>();
  const aliases = entries
    .filter((entry) => !entry.model.value.startsWith('claude-'))
    .sort((first, second) => rank(first.model.value) - rank(second.model.value));
  for (const entry of aliases) {
    if (entry.model.value !== 'default' && primaryRuns.has(entry.runs)) {
      continue;
    }
    if (entry.model.value !== 'default') {
      primaryRuns.add(entry.runs);
    }
    primary.push(toOption(entry));
  }

  // Everything else goes under "More models", once per model, skipping what
  // the main list already offers: full ids Claude Code lists, then the
  // earlier models it no longer lists but still accepts.
  const more: ProviderModelOption[] = [];
  const moreRuns = new Set<string>(primaryRuns);
  const fullIds = entries.filter((entry) => entry.model.value.startsWith('claude-'));
  for (const entry of fullIds) {
    if (!moreRuns.has(entry.runs)) {
      moreRuns.add(entry.runs);
      more.push(toOption(entry, 'more'));
    }
  }
  for (const model of PREVIOUS_CLAUDE_MODELS) {
    if (!moreRuns.has(model.value)) {
      moreRuns.add(model.value);
      more.push({
        value: model.value,
        label: model.label,
        group: 'more',
        resolvesTo: model.value,
        effort: buildEffort(model.effortLevels),
      });
    }
  }

  // Claude Code's order for the models this app knows; a newer one it does
  // not know yet goes first.
  const knownOrder = PREVIOUS_CLAUDE_MODELS.map((model) => model.value);
  const orderOf = (option: ProviderModelOption) => knownOrder.indexOf(baseModelId(option.resolvesTo ?? option.value));
  more.sort((first, second) => orderOf(first) - orderOf(second));

  return {
    OPTIONS: [...primary, ...more],
    DEFAULT: primary.some((option) => option.value === 'default') ? 'default' : primary[0]?.value ?? 'default',
  };
}

export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_PREDEFINED_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderProviderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderProviderModel(messageModel) ? messageModel : null;
};

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsiSequences(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderProviderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderProviderModel(modelTag) ? modelTag : null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  constructor(
    private readonly loadInitialization: () => Promise<ClaudeCodeInitialization | null> = loadClaudeCodeInitialization,
  ) {}

  /** Claude Code's own model list for this account, or the static catalog when it cannot be read. */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const initialization = await this.loadInitialization();
    return initialization && initialization.models.length > 0
      ? buildClaudeModelsDefinition(initialization.models)
      : CLAUDE_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }
}
