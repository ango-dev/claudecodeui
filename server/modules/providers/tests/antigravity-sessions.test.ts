import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { withAntigravityAcp } from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import {
  AntigravitySessionsProvider,
  AntigravityUpdateNormalizer,
  describeAntigravityToolCall,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';

import { installFakeAgy } from './fixtures/fake-agy-environment.js';

/**
 * Antigravity session updates → chat messages (live and history), tool-name
 * mapping, history through session/load replay, and session indexing from
 * session/list.
 */

let env: Awaited<ReturnType<typeof installFakeAgy>>;
const previousDatabasePath = process.env.DATABASE_PATH;

before(async () => {
  env = await installFakeAgy('agy-sessions');
  closeConnection();
  process.env.DATABASE_PATH = path.join(env.root, 'auth.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await env.restore();
});

/** The `run ls` turn as real agy 1.5.19 streamed it (ids shortened). */
const REAL_LS_TURN = [
  { sessionUpdate: 'usage_update', used: 10108, size: 1048576 },
  {
    sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'run_command',
    args: { CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'List directory contents' },
    status: 'in_progress', kind: 'execute', title: 'ls',
    rawInput: { CommandLine: 'ls', WaitMsBeforeAsync: 5000, toolSummary: 'List directory contents' },
  },
  {
    sessionUpdate: 'tool_call_update', toolCallId: 'call_1', name: 'run_command',
    args: { CommandLine: 'ls' }, status: 'pending', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' },
  },
  {
    sessionUpdate: 'tool_call_update', toolCallId: 'call_1', name: 'run_command', status: 'completed', kind: 'execute', title: 'ls',
    rawInput: { CommandLine: 'ls', toolSummary: 'List directory contents' },
    rawOutput: {
      output: 'Created At: 2026-11-28T20:03:40Z\nCompleted At: 2026-11-28T20:03:40Z\nCommand exited with code 0.\n\nCommand output:\na.txt\r\n',
      exit_code: 0,
    },
    content: [{ type: 'content', content: { type: 'text', text: 'Created At: …\n\nCommand output:\na.txt\r\n' } }],
  },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a.' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'txt' } },
  { sessionUpdate: 'usage_update', used: 10190, size: 1048576 },
];

test('live: tool call then streamed text, as the chat renders Claude', () => {
  const normalizer = new AntigravityUpdateNormalizer({ mode: 'live', sessionId: 'app-1', idPrefix: 'p' });
  const messages = REAL_LS_TURN.flatMap((update) => normalizer.push(update)).concat(normalizer.flush());
  assert.deepEqual(messages.map((message) => message.kind), ['tool_use', 'tool_result', 'stream_delta', 'stream_delta', 'stream_end']);
  const [toolUse, toolResult, firstDelta] = messages;
  assert.equal(toolUse.toolName, 'Bash');
  assert.deepEqual(toolUse.toolInput, { command: 'ls', description: 'List directory contents' });
  assert.equal(toolUse.toolId, 'call_1');
  assert.equal(toolResult.toolId, 'call_1');
  assert.equal(toolResult.content, 'a.txt');
  assert.equal(toolResult.isError, false);
  assert.equal(firstDelta.content, 'a.');
  assert.equal(messages.every((message) => message.sessionId === 'app-1' && message.provider === 'antigravity'), true);
  assert.deepEqual(normalizer.usage, { used: 10190, size: 1048576 });
});

test('live: thoughts become one thinking row, plans a TodoWrite checklist, user echoes are dropped', () => {
  const normalizer = new AntigravityUpdateNormalizer({ mode: 'live', sessionId: 's', idPrefix: 'p' });
  const messages = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking ' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hard' } },
    { sessionUpdate: 'plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }, { content: 'Write', priority: 'low', status: 'in_progress' }] },
    { sessionUpdate: 'session_info_update', title: 'A title' },
    { sessionUpdate: 'available_commands_update', availableCommands: [] },
  ].flatMap((update) => normalizer.push(update)).concat(normalizer.flush());
  assert.deepEqual(messages.map((message) => message.kind), ['thinking', 'tool_use']);
  assert.equal(messages[0].content, 'Thinking hard');
  assert.equal(messages[1].toolName, 'TodoWrite');
  assert.deepEqual(messages[1].toolInput, {
    todos: [{ content: 'Read', status: 'completed', priority: 'high' }, { content: 'Write', status: 'in_progress', priority: 'low' }],
  });
  assert.equal(normalizer.title, 'A title');
});

test('history: chunks join into whole rows and tool results attach to their call', () => {
  const normalizer = new AntigravityUpdateNormalizer({ mode: 'history', sessionId: 's', idPrefix: 'h' });
  const messages = [
    // session/load as real agy replayed it: user and agent messages as single
    // chunks, a finished tool call as one `tool_call`.
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run ls' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'resource_link', uri: 'file:///tmp/notes.md', name: 'notes.md' } },
    { ...REAL_LS_TURN[3], sessionUpdate: 'tool_call' },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a.txt' } },
  ].flatMap((update) => normalizer.push(update)).concat(normalizer.flush());
  assert.deepEqual(messages.map((message) => [message.kind, message.role ?? null]), [
    ['text', 'user'], ['tool_use', null], ['text', 'assistant'],
  ]);
  assert.equal(messages[0].content, 'run ls');
  assert.deepEqual(messages[0].files, [{ path: '/tmp/notes.md', name: 'notes.md' }]);
  assert.deepEqual(messages[1].toolResult, { content: 'a.txt', isError: false });
  assert.equal(messages[1].id, 'agy_tool_call_1');
});

test('tool names map onto the chat tool rows', () => {
  const describe = (toolCall: Record<string, unknown>) => {
    const described = describeAntigravityToolCall({ toolCallId: 't', ...toolCall });
    return described && { toolName: described.toolName, toolInput: described.toolInput };
  };
  assert.deepEqual(describe({ name: 'view_file', kind: 'read', rawInput: { AbsolutePath: '/a.ts', StartLine: 3, EndLine: 5 } }), {
    toolName: 'Read', toolInput: { file_path: '/a.ts', offset: 3, limit: 3 },
  });
  assert.deepEqual(describe({ name: 'write_to_file', kind: 'edit', rawInput: { TargetFile: '/n.ts', CodeContent: 'x' } }), {
    toolName: 'Write', toolInput: { file_path: '/n.ts', content: 'x' },
  });
  assert.deepEqual(describe({ name: 'replace_file_content', kind: 'edit', content: [{ type: 'diff', path: '/e.ts', oldText: 'a', newText: 'b' }] }), {
    toolName: 'Edit', toolInput: { file_path: '/e.ts', old_string: 'a', new_string: 'b' },
  });
  // An ACP diff without old text is a new file.
  assert.equal(describe({ kind: 'edit', content: [{ type: 'diff', path: '/new.ts', oldText: null, newText: 'b' }] })?.toolName, 'Write');
  assert.deepEqual(describe({ name: 'grep_search', kind: 'search', rawInput: { Query: 'TODO', SearchPath: '/src' } }), {
    toolName: 'Grep', toolInput: { pattern: 'TODO', path: '/src' },
  });
  assert.deepEqual(describe({ name: 'find_by_name', rawInput: { Pattern: '*.ts', SearchDirectory: '/src' } }), {
    toolName: 'Glob', toolInput: { pattern: '*.ts', path: '/src' },
  });
  assert.deepEqual(describe({ name: 'read_url_content', kind: 'fetch', rawInput: { Url: 'https://x.dev' } }), {
    toolName: 'WebFetch', toolInput: { url: 'https://x.dev' },
  });
  assert.equal(describe({ name: 'search_web', rawInput: { query: 'acp' } })?.toolName, 'WebSearch');
  assert.equal(describe({ name: 'invoke_subagent', title: 'Research', rawInput: { Prompt: 'go' } })?.toolName, 'Task');
  // Standard ACP kinds from an agent that names tools differently.
  assert.equal(describe({ kind: 'execute', rawInput: { command: 'pwd' } })?.toolName, 'Bash');
  // An unknown tool keeps agy's own name and input.
  assert.deepEqual(describe({ name: 'browser_click', kind: 'other', title: 'Click', rawInput: { Selector: '#a' } }), {
    toolName: 'browser_click', toolInput: { Selector: '#a', title: 'Click' },
  });
});

test('history is replayed through session/load and paginated from the tail', async () => {
  const logPath = env.useScenario({ prompts: [[{ type: 'thought', chunks: ['hm'] }, { type: 'text', chunks: ['he', 'llo'] }]] });
  const sessionId = await withAntigravityAcp({ cwd: env.projectDir }, async (connection) => {
    const result = await connection.request<any>('session/new', { cwd: env.projectDir, mcpServers: [] });
    await connection.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'hello?' }] }, { timeoutMs: 0 });
    return result.sessionId as string;
  });

  const provider = new AntigravitySessionsProvider();
  const full = await provider.fetchHistory('app-session', { providerSessionId: sessionId, projectPath: env.projectDir, limit: null });
  assert.deepEqual(full.messages.map((message) => [message.kind, message.content]), [
    ['text', 'hello?'], ['thinking', 'hm'], ['text', 'hello'],
  ]);
  assert.equal(full.messages.every((message) => message.sessionId === 'app-session'), true);
  assert.ok(full.messages[0].timestamp < full.messages[2].timestamp);
  assert.deepEqual(full.tokenUsage, { used: 10267, total: 1048576, inputTokens: 0, outputTokens: 0 });

  const page = await provider.fetchHistory('app-session', { providerSessionId: sessionId, projectPath: env.projectDir, limit: 1, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.hasMore, true);
  assert.equal(page.messages[0].content, 'hello');

  // The second read came from the cache: one session/load in total.
  const loads = (await env.readLog(logPath)).filter((entry) => entry.received?.method === 'session/load');
  assert.equal(loads.length, 1);
});

test('signed out, history is empty instead of an error', async () => {
  env.useScenario({ auth: 'required' });
  const result = await new AntigravitySessionsProvider().fetchHistory('x', { providerSessionId: 'never-seen', limit: null });
  assert.deepEqual(result, { messages: [], total: 0, hasMore: false, offset: 0, limit: null });
});

test('the synchronizer indexes listed sessions and binds a pending app session', async () => {
  env.useScenario({ prompts: [[{ type: 'title', title: 'Listed Title' }, { type: 'text', chunks: ['ok'] }]] });
  // A project of its own: the pending app row binds to the first listed
  // session of its project, as for OpenCode.
  const projectDir = path.join(env.root, 'sync-project');
  await mkdir(projectDir);
  const appSession = sessionsDb.createAppSession('app-pending', 'antigravity', projectDir, 'First message');
  assert.ok(appSession);
  const providerSessionId = await withAntigravityAcp({ cwd: projectDir }, async (connection) => {
    // An unprompted session (like CloudCLI's model lookup) is never listed.
    await connection.request<any>('session/new', { cwd: projectDir, mcpServers: [] });
    const result = await connection.request<any>('session/new', { cwd: projectDir, mcpServers: [] });
    await connection.request('session/prompt', { sessionId: result.sessionId, prompt: [{ type: 'text', text: 'x' }] }, { timeoutMs: 0 });
    return result.sessionId as string;
  });

  const synchronizer = new AntigravitySessionSynchronizer();
  assert.ok(await synchronizer.synchronize() >= 1);
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  assert.equal(row?.session_id, 'app-pending');
  assert.equal(row?.provider, 'antigravity');
  assert.equal(row?.jsonl_path, null);

  // A watcher event names the session by its store file.
  const indexed = await synchronizer.synchronizeFile(path.join(env.home, '.gemini', 'antigravity-cli', 'conversations', `${providerSessionId}.db-wal`));
  assert.equal(indexed, 'app-pending');
  assert.equal(await synchronizer.synchronizeFile('/somewhere/else.txt'), null);
  // Full listings are throttled.
  assert.equal(await synchronizer.synchronize(), 0);
});
