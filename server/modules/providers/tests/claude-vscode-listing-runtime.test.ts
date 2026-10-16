import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  userPreferencesDb,
} from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * "Show these sessions in VS Code" end to end through the Claude runtime: the
 * stored preference is read as the run starts, and the transcript is patched
 * after the turn only while it is on. The SDK stream is scripted through
 * `context.createQuery`; the transcript and the database are temporary.
 */

const USER_ID = 1;
const NATIVE_ID = '7c2a9e41-3b6d-4f80-a1c5-9d8e7f6a5b4c';
const SDK_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, entrypoint: 'sdk-ts', sessionId: NATIVE_ID });

type Harness = { transcriptPath: string; sent: NormalizedMessage[] };

async function withRun(
  listInVsCode: boolean,
  transcript: string,
  runTest: (harness: Harness) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-vscode-runtime-'));
  const databasePath = path.join(root, 'auth.db');
  const projectDirectory = path.join(root, 'config', 'projects', '-repo');
  const transcriptPath = path.join(projectDirectory, `${NATIVE_ID}.jsonl`);
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(transcriptPath, transcript);

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  await writeFile(databasePath, '');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');
  if (listInVsCode) {
    userPreferencesDb.savePreferences(USER_ID, { showSessionsInVsCode: true });
  }

  const sent: NormalizedMessage[] = [];
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => { for await (const _message of prompt) { /* the CLI reads its stdin */ } })();
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: NATIVE_ID };
      yield { type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'done', duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(stream, { interrupt: async () => {} });
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: USER_ID };

  try {
    await queryClaudeSDK('hello', { sessionId: 'app-vscode-session', cwd: root }, writer as never, context);
    await runTest({ transcriptPath, sent });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const errors = (sent: NormalizedMessage[]) => sent.filter((message) => message.kind === 'error');

test('with the setting on, the turn ends with the transcript listed as cli', async () => {
  await withRun(true, `${SDK_LINE}\n`, async ({ transcriptPath, sent }) => {
    assert.equal(JSON.parse(await readFile(transcriptPath, 'utf8')).entrypoint, 'cli');
    assert.deepEqual(errors(sent), []);
  });
});

test('with the setting off, the transcript keeps the SDK entrypoint', async () => {
  await withRun(false, `${SDK_LINE}\n`, async ({ transcriptPath, sent }) => {
    assert.equal(await readFile(transcriptPath, 'utf8'), `${SDK_LINE}\n`);
    assert.deepEqual(errors(sent), []);
  });
});

test('with the setting on, a transcript it cannot patch shows an error in the chat', async () => {
  const renamed = SDK_LINE.replace('"entrypoint"', '"entry_point"');
  await withRun(true, `${renamed}\n`, async ({ transcriptPath, sent }) => {
    assert.equal(await readFile(transcriptPath, 'utf8'), `${renamed}\n`);
    const [error] = errors(sent);
    assert.ok(error, 'no error reached the chat');
    assert.match(String(error.content), /^Couldn't list this session in VS Code: the transcript has no "entrypoint" field/);
    assert.match(String(error.content), /Turn off "Show these sessions in VS Code" in Settings → Agents, or ask to have it fixed\.$/);
  });
});
