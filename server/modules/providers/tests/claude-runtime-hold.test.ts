import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  /** Every prompt message the CLI read from its stdin, in order. */
  prompts: unknown[];
  /** Live switches the runtime made: `model:<id>` and `mode:<mode>`. */
  switches: string[];
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];
  const prompts: unknown[] = [];
  const switches: string[] = [];

  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    prompts,
    switches,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) { prompts.push(message); }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async (taskId: string) => { stopped.push(taskId); },
      setModel: async (model?: string) => { switches.push(`model:${model}`); },
      setPermissionMode: async (mode: string) => { switches.push(`mode:${mode}`); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown> }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  try {
    const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
    await runTest({ script, sent, done });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn that needs a fresh process stops the held process\'s tasks before letting it go', async () => {
  // Two runs on one session, each with its own scripted CLI: the first is
  // held for a background agent, the second edits an earlier message, which
  // resumes the transcript partway and so cannot go to the held process.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: first.createQuery });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    // Closing stdin alone would leave the CLI waiting for the agent, so the
    // superseded process would live on next to the new one for as long as
    // the agent runs. The stop has to reach it before stdin ends, because the
    // SDK drops control requests written to an ended stdin.
    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'u-anchor' }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.deepEqual(first.script.stopped, ['a1'], 'the held process is told to stop its agent');
    assert.equal(first.script.released(), true, 'and is then let go');
    assert.deepEqual(second.script.stopped, [], 'the new process is untouched');

    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a held process is still let go when stopping its tasks throws', async () => {
  // Stopping is best effort; a stop that throws on the spot must not keep the
  // held process alive or take the new turn down with it.
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const throwingStop: NonNullable<ProviderRuntimeContext['createQuery']> = (options) =>
    Object.assign(first.createQuery(options), {
      stopTask: () => { throw new Error('stop failed'); },
    });

  try {
    const firstRun = queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd }, writer as never, { ...context, createQuery: throwingStop });
    await settle();
    first.script.emit(init());
    first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
    first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
    first.script.emit(result());
    await waitFor(() => sent.some((message) => message.kind === 'complete'));
    assert.equal(first.script.released(), false, 'the first process is held for its agent');

    const secondRun = queryClaudeSDK('Continue', { sessionId: SESSION_ID, cwd, resumeAnchorId: 'u-anchor' }, writer as never, { ...context, createQuery: second.createQuery });
    await settle();
    assert.equal(first.script.released(), true, 'the held process is let go anyway');

    first.script.end();
    await firstRun;
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.released(), true, 'the new turn ran to completion');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});

/**
 * Two runs on one session, as the chat gateway makes them: one per message,
 * each with its own writer. Only the first gets a scripted CLI of its own;
 * a second that is handed to the held process never spawns one.
 */
async function withTwoRuns(
  runTest: (harness: {
    cwd: string;
    first: ReturnType<typeof createScriptedQuery>;
    second: ReturnType<typeof createScriptedQuery>;
    firstSent: NormalizedMessage[];
    secondSent: NormalizedMessage[];
    startFirst: (options?: Record<string, unknown>) => Promise<unknown>;
    startSecond: (options?: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const first = createScriptedQuery();
  const second = createScriptedQuery();
  const firstSent: NormalizedMessage[] = [];
  const secondSent: NormalizedMessage[] = [];
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: Omit<ProviderRuntimeContext, 'createQuery'> = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };
  const writerFor = (sent: NormalizedMessage[]) => ({ send: (message: NormalizedMessage) => { sent.push(message); }, userId: null });

  try {
    await runTest({
      cwd,
      first,
      second,
      firstSent,
      secondSent,
      startFirst: (options = {}) => queryClaudeSDK('start an agent', { sessionId: SESSION_ID, cwd, ...options }, writerFor(firstSent) as never, { ...context, createQuery: first.createQuery }),
      startSecond: (options = {}) => queryClaudeSDK('How is it going?', { sessionId: SESSION_ID, cwd, ...options }, writerFor(secondSent) as never, { ...context, createQuery: second.createQuery }),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Runs the first turn through to a `result` that leaves an agent going in the background. */
async function holdForAgent(first: ReturnType<typeof createScriptedQuery>, firstSent: NormalizedMessage[]): Promise<void> {
  await settle();
  first.script.emit(init());
  first.script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'sleep 90', subagent_type: 'general-purpose', run_in_background: true }));
  first.script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
  first.script.emit(ack('toolu_agent', 'Async agent launched successfully.', { status: 'async_launched', agentId: 'a1' }));
  first.script.emit(result());
  await waitFor(() => firstSent.some((message) => message.kind === 'complete'));
  assert.equal(first.script.released(), false, 'the first process is held for its agent');
}

const promptText = (prompt: unknown) => JSON.stringify((prompt as { message?: { content?: unknown } }).message?.content);

test('the next message goes to the held process, whose background work keeps running', async () => {
  await withTwoRuns(async ({ first, second, firstSent, secondSent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await holdForAgent(first, firstSent);

    const secondRun = startSecond();
    await waitFor(() => first.script.prompts.length === 2);
    assert.match(promptText(first.script.prompts[1]), /How is it going\?/, 'the message reaches the running CLI');
    assert.deepEqual(first.script.stopped, [], 'its agent is not stopped');
    assert.equal(first.script.released(), false, 'nor is the process let go');
    assert.equal(second.script.prompts.length, 0, 'no second process is started');

    // The turn streams to the second message's writer, and ends it.
    first.script.emit({ type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Still running.' }] } });
    first.script.emit(result());
    await secondRun;
    assert.ok(secondSent.some((message) => message.kind === 'complete'), 'the second turn completes on its own writer');
    assert.equal(firstSent.filter((message) => message.kind === 'complete').length, 1, 'the first writer hears nothing more');
    assert.equal(first.script.released(), false, 'the agent still holds the process after the second turn');

    // The agent reports back in a turn of its own, and the process is let go.
    first.script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    first.script.emit(result());
    await waitFor(() => first.script.released());
    first.script.end();
    await firstRun;
    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
  });
});

test('a model or permission change is switched on the held process', async () => {
  await withTwoRuns(async ({ first, firstSent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await holdForAgent(first, firstSent);

    const secondRun = startSecond({ model: 'best', permissionMode: 'acceptEdits' });
    await waitFor(() => first.script.prompts.length === 2);
    assert.deepEqual(first.script.switches, ['model:best', 'mode:acceptEdits']);

    first.script.emit(result());
    await secondRun;
    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    await waitFor(() => first.script.released());
    first.script.end();
    await firstRun;
  });
});

test('a held process that has been let go does not take the next message', async () => {
  await withTwoRuns(async ({ first, second, firstSent, secondSent, startFirst, startSecond }) => {
    const firstRun = startFirst();
    await holdForAgent(first, firstSent);
    // Its agent was stopped, so the process is on its way out.
    first.script.emit(taskNotification('a1', 'toolu_agent', 'stopped'));
    await waitFor(() => first.script.released());

    const secondRun = startSecond();
    await settle();
    assert.equal(first.script.prompts.length, 1, 'nothing more is sent to the closing process');
    second.script.emit(init());
    second.script.emit(result());
    second.script.end();
    await secondRun;
    assert.equal(second.script.prompts.length, 1, 'a new process takes the message');
    assert.ok(secondSent.some((message) => message.kind === 'complete'));

    first.script.end();
    await firstRun;
  });
});
