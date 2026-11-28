import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { AntigravityProviderAuth } from '@/modules/providers/list/antigravity/antigravity-auth.provider.js';
import {
  AntigravityProviderModels,
  buildAntigravityModelCatalog,
  parseAgyModelsOutput,
} from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

import { installFakeAgy } from './fixtures/fake-agy-environment.js';

/**
 * Antigravity auth status and model catalog: agy is asked over ACP (fake agy
 * on PATH), never through its credential files.
 */

let env: Awaited<ReturnType<typeof installFakeAgy>>;
let homeCounter = 0;

/** Auth and catalog answers are cached per home directory, so each case gets its own. */
async function useFreshHome(): Promise<string> {
  const home = path.join(env.root, `home-${++homeCounter}`);
  await mkdir(home, { recursive: true });
  env.setEnv('HOME', home);
  env.setEnv('USERPROFILE', home);
  return home;
}

before(async () => {
  env = await installFakeAgy('agy-auth-models');
});

after(async () => {
  await env.restore();
});

test('auth: installed and signed in when agy lists sessions', async () => {
  await useFreshHome();
  const logPath = env.useScenario({});
  const status = await new AntigravityProviderAuth().getStatus();
  assert.equal(status.provider, 'antigravity');
  assert.equal(status.installed, true);
  assert.equal(status.installedVersion, '1.5.19');
  assert.equal(status.authenticated, true);
  assert.equal(status.method, 'agy_sign_in');
  assert.equal(status.error, undefined);
  // The check is a session/list, which changes nothing.
  const methods = (await env.readLog(logPath)).map((entry) => entry.received?.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/list']);
});

test('auth: installed but not signed in on -32000 Authentication required', async () => {
  await useFreshHome();
  env.useScenario({ auth: 'required' });
  const status = await new AntigravityProviderAuth().getStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error ?? '', /Not signed in.*agy/);
});

test('auth: not installed without an agy on PATH or in ~/.local/bin', async () => {
  const home = await useFreshHome();
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const previous = process.env[pathKey];
  process.env[pathKey] = '';
  try {
    const auth = new AntigravityProviderAuth();
    assert.deepEqual(auth.checkInstalled(), { installed: false, exitCode: null, version: null });
    const status = await auth.getStatus();
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);

    // ~/.local/bin/agy is the installer's default location.
    if (process.platform !== 'win32') {
      await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
      const { copyFile } = await import('node:fs/promises');
      await copyFile(path.join(env.binDir, 'agy'), path.join(home, '.local', 'bin', 'agy'));
      assert.equal(auth.checkInstalled().version, '1.5.19');
    }
  } finally {
    process.env[pathKey] = previous;
  }
});

test('auth: ANTIGRAVITY_CLI_PATH overrides the lookup', async () => {
  await useFreshHome();
  env.setEnv('ANTIGRAVITY_CLI_PATH', path.join(env.root, 'missing', 'agy'));
  try {
    const status = await new AntigravityProviderAuth().getStatus();
    assert.equal(status.installed, false);
  } finally {
    env.setEnv('ANTIGRAVITY_CLI_PATH', undefined);
  }
});

/** session/new as real agy 1.5.19 answered it for a Google AI Pro account (trimmed). */
const REAL_SESSION_STATE = {
  currentModelId: 'gemini-4-neon-high',
  availableModels: [
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
    { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
    { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
    { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
  configOptions: [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon',
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
      ],
    },
    {
      id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high',
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }],
    },
  ],
};

test('catalog: one row per model family, its levels as effort', () => {
  const catalog = buildAntigravityModelCatalog(REAL_SESSION_STATE);
  assert.equal(catalog.DEFAULT, 'gemini-4-neon');
  assert.deepEqual(catalog.OPTIONS, [
    {
      value: 'gemini-4-neon',
      label: 'Gemini 4 Neon',
      effort: { default: 'high', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }] },
    },
    { value: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', effort: { values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] } },
    { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ]);
});

test('catalog: without config options the families come from the model id suffixes', () => {
  const catalog = buildAntigravityModelCatalog({ ...REAL_SESSION_STATE, configOptions: [] });
  assert.deepEqual(catalog.OPTIONS.map((option) => option.value), ['gemini-4-neon', 'gemini-pro-orchestrator', 'gemini-3.8-flash', 'gpt-oss-120b']);
  assert.equal(catalog.OPTIONS[0].label, 'Gemini 4 Neon');
  assert.deepEqual(catalog.OPTIONS[3].effort, { values: [{ value: 'medium' }] });
});

test('`agy models` output is parsed, its banner and errors skipped', () => {
  assert.deepEqual(parseAgyModelsOutput('Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'), [
    { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ]);
  assert.deepEqual(parseAgyModelsOutput('Fetching available models...\nError: Please sign in to view available models.\n'), []);
});

test('models: discovered from an unprompted, closed session/new', async () => {
  await useFreshHome();
  const logPath = env.useScenario({});
  const catalog = await new AntigravityProviderModels().getSupportedModels();
  assert.equal(catalog.DEFAULT, 'gemini-4-neon');
  assert.ok(catalog.OPTIONS.some((option) => option.value === 'gemini-3.8-flash'));
  const methods = (await env.readLog(logPath)).map((entry) => entry.received?.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/close']);
  // The auth label reuses the plan agy reported with it.
  const status = await new AntigravityProviderAuth().getStatus();
  assert.equal(status.email, 'Google AI Pro');
});

test('models: signed out falls back to the built-in list', async () => {
  await useFreshHome();
  env.useScenario({ auth: 'required' });
  const models = new AntigravityProviderModels();
  const catalog = await models.getSupportedModels();
  assert.equal(catalog.DEFAULT, 'gemini-4-neon');
  assert.ok(catalog.OPTIONS.some((option) => option.value === 'claude-opus-5-5'));
  assert.deepEqual(await models.getCurrentActiveModel(), { model: 'gemini-4-neon', isFallback: true });
});
