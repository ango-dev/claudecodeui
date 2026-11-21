import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  queryClaudeSDK,
  steerClaudeSDKSession,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * A file attached to a message (a long paste goes as `Pasted text.txt`) is
 * listed in the prompt's `<files_input>` block for Claude to Read. It lives in
 * the upload store, outside the project, where Claude Code asks before every
 * Read; the runtime lets the Read tool open exactly those files without a
 * prompt. Any other path, or any other tool, still asks. These drive
 * `queryClaudeSDK` with a scripted SDK stream and call the `canUseTool` it
 * started the query with.
 */

const SESSION_ID = 'app-attached-read-session';
const NATIVE_ID = 'native-attached-read-session';
const STEER_ID = '7a1c3f8e-6d1a-4c2b-9e7f-1a2b3c4d5e6f';
const ATTACHED = '/home/u/.cloudcli/assets/1-Pasted_text.txt';
const STEERED = '/home/u/.cloudcli/assets/2-Pasted_text.txt';

type CanUseTool = (toolName: string, input: unknown, context?: { signal?: AbortSignal }) => Promise<AnyRecord>;

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  stdin: AnyRecord[];
  options: () => AnyRecord | null;
};

function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let startedWith: AnyRecord | null = null;
  const stdin: AnyRecord[] = [];
  const script: Scripted = {
    emit: (message) => { queue.push(message); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    stdin,
    options: () => startedWith,
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    startedWith = options;
    void (async () => {
      for await (const message of prompt) {
        stdin.push(message as AnyRecord);
      }
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
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  return { createQuery, script };
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

async function withRun(
  runOptions: AnyRecord,
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; canUseTool: CanUseTool }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-attached-read-'));
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
    const done = queryClaudeSDK('what is in the paste?', { sessionId: SESSION_ID, cwd, ...runOptions }, writer as never, context);
    await waitFor(() => script.stdin.length > 0);
    script.emit({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
    await settle();
    const canUseTool = script.options()?.canUseTool as CanUseTool;
    await runTest({ script, sent, canUseTool });
    script.emit({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });
    script.end();
    await done;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Calls canUseTool for a call that should ask, then cancels the prompt it raised. */
async function asksFirst(canUseTool: CanUseTool, sent: NormalizedMessage[], toolName: string, input: AnyRecord) {
  const before = sent.filter((message) => message.kind === 'permission_request').length;
  const controller = new AbortController();
  const decision = canUseTool(toolName, input, { signal: controller.signal });
  await waitFor(() => sent.filter((message) => message.kind === 'permission_request').length === before + 1);
  controller.abort();
  assert.equal((await decision).behavior, 'deny');
}

test('Read of a file attached to the prompt is allowed without a permission prompt', async () => {
  await withRun({ files: [{ path: ATTACHED, name: 'Pasted text.txt' }] }, async ({ sent, canUseTool }) => {
    const decision = await canUseTool('Read', { file_path: ATTACHED });
    assert.deepEqual(decision, { behavior: 'allow', updatedInput: { file_path: ATTACHED } });
    assert.equal(sent.filter((message) => message.kind === 'permission_request').length, 0);
  });
});

test('any other path, or another tool on the attached path, still asks', async () => {
  await withRun({ files: [{ path: ATTACHED, name: 'Pasted text.txt' }] }, async ({ sent, canUseTool }) => {
    await asksFirst(canUseTool, sent, 'Read', { file_path: '/home/u/.cloudcli/assets/someone-elses.txt' });
    await asksFirst(canUseTool, sent, 'Read', { file_path: '/home/u/.ssh/id_rsa' });
    await asksFirst(canUseTool, sent, 'Bash', { command: `cat ${ATTACHED}` });
    await asksFirst(canUseTool, sent, 'Write', { file_path: ATTACHED, content: 'x' });
  });
});

test('a run with no attachments allows no Read without asking', async () => {
  await withRun({}, async ({ sent, canUseTool }) => {
    await asksFirst(canUseTool, sent, 'Read', { file_path: ATTACHED });
  });
});

test('a Read the user disallowed stays denied even for an attached file', async () => {
  await withRun(
    { files: [{ path: ATTACHED }], toolsSettings: { allowedTools: [], disallowedTools: ['Read'] } },
    async ({ canUseTool }) => {
      const decision = await canUseTool('Read', { file_path: ATTACHED });
      assert.equal(decision.behavior, 'deny');
    },
  );
});

test('a file attached to a steered message can be read without asking too', async () => {
  await withRun({}, async ({ script, sent, canUseTool }) => {
    assert.equal(
      await steerClaudeSDKSession(SESSION_ID, 'and this one', { messageId: STEER_ID, files: [{ path: STEERED }] }),
      true,
    );
    await waitFor(() => script.stdin.length === 2);
    const decision = await canUseTool('Read', { file_path: STEERED });
    assert.equal(decision.behavior, 'allow');
    assert.equal(sent.filter((message) => message.kind === 'permission_request').length, 0);
  });
});
