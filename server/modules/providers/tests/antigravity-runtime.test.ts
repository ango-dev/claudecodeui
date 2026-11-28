import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { ProviderPermissionDecision, ProviderRuntimeContext } from '@/shared/types.js';

import { installFakeAgy } from './fixtures/fake-agy-environment.js';

/**
 * Drives the Antigravity runtime against the fake `agy acp`
 * (fixtures/fake-agy.ts) on PATH: streaming, permission round trips, modes,
 * model and effort switching, cancel, steering and failures.
 */

// Read when the runtime module loads.
process.env.ANTIGRAVITY_TOOL_APPROVAL_TIMEOUT_MS = '2000';
const {
  antigravityRuntime,
  buildAntigravityPrompt,
  planAntigravityModelSelection,
  resolveAntigravityMode,
  selectAntigravityPermissionOutcome,
} = await import('@/modules/providers/list/antigravity/antigravity-runtime.provider.js');

type Frame = Record<string, any>;

let env: Awaited<ReturnType<typeof installFakeAgy>>;
let appCounter = 0;

before(async () => {
  env = await installFakeAgy('agy-runtime');
});

after(async () => {
  await env.restore();
});

type TurnOptions = {
  scenario: Record<string, unknown>;
  appSessionId?: string;
  resumeSessionId?: string | null;
  command?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  onFrame?: (frame: Frame, frames: Frame[]) => ProviderPermissionDecision | void;
};

async function runTurn(options: TurnOptions) {
  const logPath = env.useScenario(options.scenario);
  const appSessionId = options.appSessionId ?? `app-${++appCounter}`;
  const frames: Frame[] = [];
  const writer = {
    userId: null,
    send(frame: Frame) {
      frames.push(frame);
      const decision = options.onFrame?.(frame, frames);
      if (decision && frame.kind === 'permission_request') {
        setTimeout(() => antigravityRuntime.permissions.resolve(frame.requestId, decision), 10);
      }
    },
    setSessionId() {},
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => options.resumeSessionId ?? null,
    resolveResumeModel: async (_sessionId, requested) => requested ?? undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'gemini-4-neon' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  let error: unknown = null;
  try {
    await antigravityRuntime.run(options.command ?? 'hello', {
      sessionId: appSessionId,
      projectPath: env.projectDir,
      cwd: env.projectDir,
      permissionMode: options.permissionMode,
      model: options.model,
      effort: options.effort,
    }, writer, context);
  } catch (caught) {
    error = caught;
  }
  const log = await env.readLog(logPath);
  return {
    frames,
    error,
    appSessionId,
    log,
    methods: log.map((entry) => entry.received?.method).filter(Boolean) as string[],
    received: (method: string) => log.filter((entry) => entry.received?.method === method).map((entry) => entry.received.params),
    providerSessionId: frames.find((frame) => frame.kind === 'session_created')?.newSessionId as string | undefined,
  };
}

const kinds = (frames: Frame[]) => frames.map((frame) => frame.kind);

test('a new session streams thinking and text, reports usage and completes', async () => {
  const turn = await runTurn({
    scenario: { prompts: [[{ type: 'thought', chunks: ['Let me ', 'see'] }, { type: 'text', chunks: ['o', 'k'] }, { type: 'usage', used: 1234, size: 1048576 }]] },
    model: 'gemini-3.8-flash',
    effort: 'low',
  });
  assert.equal(turn.error, null);
  // A usage report does not end the text stream; the turn's end does.
  assert.deepEqual(kinds(turn.frames), [
    'session_created', 'thinking', 'stream_delta', 'stream_delta', 'status', 'stream_end', 'status', 'complete',
  ]);
  assert.equal(turn.frames[1].content, 'Let me see');
  assert.equal(turn.frames[1].sessionId, turn.appSessionId);
  const budget = turn.frames.filter((frame) => frame.text === 'token_budget').at(-1);
  assert.deepEqual(budget?.tokenBudget, { used: 1234, total: 1048576, inputTokens: 9986, outputTokens: 1, breakdown: { input: 9986, output: 1 } });
  assert.equal(turn.frames.at(-1)?.exitCode, 0);

  // The family and the thought level go through agy's own config options; the
  // default permission mode needs no switch.
  assert.deepEqual(turn.received('session/set_config_option').map(({ configId, value }) => [configId, value]), [
    ['model', 'gemini-3.8-flash'], ['thought_level', 'low'],
  ]);
  assert.equal(turn.received('session/set_mode').length, 0);
  assert.deepEqual(turn.received('session/prompt')[0].prompt, [{ type: 'text', text: 'hello' }]);
  assert.ok(turn.log.some((entry) => entry.stdinClosed), 'agy is closed after the turn');
  assert.ok(!turn.log[0].argv.includes('--dangerously-skip-permissions'));
});

test('a permission request reaches the chat and the answer goes back as agy\'s option', async () => {
  const tool = { type: 'tool', id: 'call_9', name: 'run_command', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls', toolSummary: 'List' }, output: 'a.txt', permission: true };
  const allowed = await runTurn({
    scenario: { prompts: [[tool, { type: 'text', chunks: ['done'] }]] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true } : undefined),
  });
  const request = allowed.frames.find((frame) => frame.kind === 'permission_request');
  assert.equal(request?.toolName, 'Bash');
  assert.deepEqual(request?.input, { command: 'ls', description: 'List' });
  assert.deepEqual(request?.context, { patterns: ['ls'], always: ['Bash: ls'] });
  assert.ok(kinds(allowed.frames).includes('permission_resolved'));
  assert.deepEqual(allowed.log.find((entry) => entry.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'allow' } });
  const result = allowed.frames.find((frame) => frame.kind === 'tool_result');
  assert.equal(result?.content, 'a.txt');
  assert.equal(result?.isError, false);

  const denied = await runTurn({
    scenario: { prompts: [[tool]] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: false } : undefined),
  });
  assert.deepEqual(denied.log.find((entry) => entry.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.equal(denied.frames.find((frame) => frame.kind === 'tool_result')?.isError, true);
  assert.equal(denied.frames.at(-1)?.exitCode, 0);
});

test('"Always allow" is remembered for the chat; an unanswered request is denied at the timeout', async () => {
  const tool = { type: 'tool', id: 'call_a', name: 'run_command', kind: 'execute', title: 'npm test', rawInput: { CommandLine: 'npm test' }, output: 'pass', permission: true };
  const first = await runTurn({
    scenario: { prompts: [[tool]] },
    onFrame: (frame) => (frame.kind === 'permission_request' ? { allow: true, rememberEntry: 'always' } : undefined),
  });
  const second = await runTurn({
    appSessionId: first.appSessionId,
    resumeSessionId: first.providerSessionId,
    scenario: { prompts: [[tool]] },
  });
  assert.equal(second.frames.some((frame) => frame.kind === 'permission_request'), false);
  assert.deepEqual(second.log.find((entry) => entry.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'allow' } });
  // A resumed session is not replayed.
  assert.ok(second.methods.includes('session/resume'));
  assert.ok(!second.methods.includes('session/load'));

  const unanswered = await runTurn({ scenario: { prompts: [[{ ...tool, id: 'call_b', title: 'rm -rf x', rawInput: { CommandLine: 'rm -rf x' } }]] } });
  assert.ok(unanswered.frames.some((frame) => frame.kind === 'permission_cancelled' && frame.reason === 'timeout'));
  assert.deepEqual(unanswered.log.find((entry) => entry.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'deny' } });
});

test('permission modes map onto agy modes; bypass starts agy with --dangerously-skip-permissions', async () => {
  const acceptEdits = await runTurn({ scenario: {}, permissionMode: 'acceptEdits' });
  assert.deepEqual(acceptEdits.received('session/set_mode').map((params) => params.modeId), ['accept-edits']);
  const plan = await runTurn({ scenario: {}, permissionMode: 'plan' });
  assert.deepEqual(plan.received('session/set_mode').map((params) => params.modeId), ['plan']);
  const auto = await runTurn({ scenario: {}, permissionMode: 'auto' });
  assert.deepEqual(auto.received('session/set_mode').map((params) => params.modeId), ['auto']);

  const bypass = await runTurn({
    scenario: { prompts: [[{ type: 'tool', id: 'c', name: 'run_command', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' }, output: 'x', permission: true }]] },
    permissionMode: 'bypassPermissions',
  });
  assert.ok(bypass.log[0].argv.includes('--dangerously-skip-permissions'));
  assert.equal(bypass.frames.some((frame) => frame.kind === 'permission_request'), false);
  assert.equal(bypass.received('session/set_mode').length, 0);
});

test('stop sends session/cancel, answers an open permission request cancelled, and leaves complete to the gateway', async () => {
  let aborting: Promise<boolean> | null = null;
  const turn = await runTurn({
    scenario: { prompts: [[{ type: 'tool', id: 'c', name: 'run_command', kind: 'execute', title: 'sleep', rawInput: { CommandLine: 'sleep 9' }, output: '', permission: true }]] },
    onFrame: (frame) => {
      if (frame.kind === 'permission_request') {
        aborting = antigravityRuntime.abort(`app-${appCounter}`);
      }
    },
  });
  assert.equal(await aborting, true);
  assert.equal(turn.error, null);
  assert.ok(kinds(turn.frames).includes('permission_cancelled'));
  assert.equal(kinds(turn.frames).includes('complete'), false);
  assert.ok(turn.methods.includes('session/cancel'));
  assert.deepEqual(turn.log.find((entry) => entry.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'cancelled' } });

  let hangAbort: Promise<boolean> | null = null;
  const hung = await runTurn({
    scenario: { prompts: [[{ type: 'text', chunks: ['working'] }, { type: 'hang' }]] },
    onFrame: (frame) => {
      if (frame.kind === 'stream_delta' && !hangAbort) {
        hangAbort = antigravityRuntime.abort(`app-${appCounter}`);
      }
    },
  });
  assert.equal(await hangAbort, true);
  assert.equal(kinds(hung.frames).includes('complete'), false);
  assert.equal(await antigravityRuntime.abort('no-such-session'), false);
});

test('a message sent during a turn is steered in as another session/prompt', async () => {
  let steered: Promise<boolean> | null = null;
  const turn = await runTurn({
    scenario: {
      prompts: [
        [{ type: 'text', chunks: ['one'] }, { type: 'delay', ms: 300 }, { type: 'text', chunks: [' two'] }],
        [{ type: 'text', chunks: ['steered'] }],
      ],
    },
    onFrame: (frame) => {
      if (frame.kind === 'stream_delta' && !steered) {
        steered = antigravityRuntime.steer(`app-${appCounter}`, 'also this', { messageId: '11111111-1111-4111-8111-111111111111' });
      }
    },
  });
  assert.equal(await steered, true);
  assert.equal(turn.received('session/prompt').length, 2);
  const echo = turn.frames.find((frame) => frame.kind === 'text' && frame.role === 'user');
  assert.equal(echo?.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(echo?.content, 'also this');
  const text = turn.frames.filter((frame) => frame.kind === 'stream_delta').map((frame) => frame.content).join('');
  assert.equal(text, 'one twosteered');
  assert.equal(kinds(turn.frames).filter((kind) => kind === 'complete').length, 1);
  assert.equal(await antigravityRuntime.steer(turn.appSessionId, 'late', {}), false);
});

test('signed out, not installed and unknown sessions fail the turn with a clear error', async () => {
  const signedOut = await runTurn({ scenario: { auth: 'required' } });
  assert.match(String(signedOut.frames.find((frame) => frame.kind === 'error')?.content), /not signed in/i);
  assert.equal(signedOut.frames.at(-1)?.kind, 'complete');
  assert.equal(signedOut.frames.at(-1)?.exitCode, 1);
  assert.ok(signedOut.error);

  const unknown = await runTurn({ scenario: {}, resumeSessionId: 'gone-session' });
  // resume fails, load is tried, and that failure is reported.
  assert.deepEqual(unknown.methods.filter((method) => method === 'session/resume' || method === 'session/load'), ['session/resume', 'session/load']);
  assert.match(String(unknown.frames.find((frame) => frame.kind === 'error')?.content), /Failed to read session/);

  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const previous = process.env[pathKey];
  process.env[pathKey] = '';
  try {
    const frames: Frame[] = [];
    await assert.rejects(antigravityRuntime.run('hi', { sessionId: 'app-x', cwd: env.projectDir }, { send: (frame: Frame) => frames.push(frame) }, {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => false,
    }));
    assert.match(String(frames.find((frame) => frame.kind === 'error')?.content), /not installed/);
  } finally {
    process.env[pathKey] = previous;
  }
});

test('images become image blocks and files embedded resources or links', async () => {
  const uploads = path.join(env.projectDir, 'uploads');
  await mkdir(uploads, { recursive: true });
  await writeFile(path.join(uploads, 'notes.md'), '# Notes\n');
  await writeFile(path.join(uploads, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(uploads, 'pic.png'), Buffer.from([137, 80, 78, 71]));
  const blocks = await buildAntigravityPrompt('look', [{ path: 'uploads/pic.png' }], [
    { path: 'uploads/notes.md', name: 'notes.md' },
    { path: 'uploads/blob.bin', name: 'blob.bin' },
    { path: '/etc/passwd' },
  ], env.projectDir);
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[0], { type: 'text', text: 'look' });
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].mimeType, 'image/png');
  assert.equal(blocks[1].data, Buffer.from([137, 80, 78, 71]).toString('base64'));
  assert.equal(blocks[2].type, 'resource');
  assert.equal(blocks[2].resource.text, '# Notes\n');
  assert.match(blocks[2].resource.uri, /^file:\/\/.*notes\.md$/);
  assert.equal(blocks[3].type, 'resource_link');
  assert.equal(blocks[3].name, 'blob.bin');
});

test('mode, model and permission-outcome planning', () => {
  const modes = ['default', 'accept-edits', 'auto', 'plan'];
  assert.deepEqual(resolveAntigravityMode('acceptEdits', modes), { modeId: 'accept-edits', skipPermissions: false });
  assert.deepEqual(resolveAntigravityMode('bypassPermissions', modes), { modeId: 'default', skipPermissions: true });
  assert.deepEqual(resolveAntigravityMode(undefined, modes), { modeId: 'default', skipPermissions: false });
  assert.deepEqual(resolveAntigravityMode('auto', ['default']), { modeId: null, skipPermissions: false });

  const state = {
    currentModelId: 'gemini-4-neon-high',
    availableModels: [{ modelId: 'gemini-4-neon-high', name: '' }, { modelId: 'gemini-3.8-flash-low', name: '' }, { modelId: 'gemini-3.8-flash-high', name: '' }],
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: '' }, { value: 'gemini-3.8-flash', name: '' }] },
      { id: 'thought_level', name: 'T', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: '' }, { value: 'high', name: '' }] },
    ],
  };
  assert.deepEqual(planAntigravityModelSelection(state, 'gemini-4-neon', 'high'), []);
  assert.deepEqual(planAntigravityModelSelection(state, 'gemini-4-neon', 'low'), [
    { method: 'session/set_config_option', params: { configId: 'thought_level', value: 'low' } },
  ]);
  assert.deepEqual(planAntigravityModelSelection(state, 'gemini-3.8-flash', 'default'), [
    { method: 'session/set_config_option', params: { configId: 'model', value: 'gemini-3.8-flash' } },
  ]);
  // Without config options, an exact (effort-suffixed) model id.
  assert.deepEqual(planAntigravityModelSelection({ ...state, configOptions: [] }, 'gemini-3.8-flash', 'low'), [
    { method: 'session/set_model', params: { modelId: 'gemini-3.8-flash-low' } },
  ]);
  assert.deepEqual(planAntigravityModelSelection(state, 'gemini-3.8-flash-high', undefined), [
    { method: 'session/set_model', params: { modelId: 'gemini-3.8-flash-high' } },
  ]);
  assert.deepEqual(planAntigravityModelSelection(state, 'not-offered', 'low'), []);

  const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }];
  assert.deepEqual(selectAntigravityPermissionOutcome(options, { allow: true, remember: true }), { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.deepEqual(
    selectAntigravityPermissionOutcome([...options, { optionId: 'always', kind: 'allow_always' }], { allow: true, remember: true }),
    { outcome: { outcome: 'selected', optionId: 'always' } },
  );
  assert.deepEqual(selectAntigravityPermissionOutcome(options, { allow: false }), { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.deepEqual(selectAntigravityPermissionOutcome([], { allow: true }), { outcome: { outcome: 'cancelled' } });
});
