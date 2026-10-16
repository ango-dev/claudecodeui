import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

/**
 * A chat started in CloudCLI is named from its first message until Claude
 * titles it, then follows Claude's title like the VS Code panel and
 * `claude --resume` do. A name the user typed is never replaced, and a rename
 * in CloudCLI is written to the transcript so those other lists show it too.
 */

const APP_ID = 'app-session-1';
const NATIVE_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

type Harness = { cwd: string; transcriptPath: string };

async function withSession(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-session-names-'));
  const cwd = path.join(root, 'repo');
  const projectDirectory = path.join(root, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(cwd, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  await initializeDatabase();

  try {
    await runTest({ cwd, transcriptPath: path.join(projectDirectory, `${NATIVE_ID}.jsonl`) });
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

const userLine = (cwd: string, text: string) => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid: 'u1', cwd, sessionId: NATIVE_ID,
});
const aiTitle = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: NATIVE_ID });
const customTitle = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: NATIVE_ID });

/** A chat started in CloudCLI, as the session gateway and the runtime record it. */
function startAppSession(cwd: string, transcriptPath: string, firstMessage: string): void {
  sessionsDb.createAppSession(APP_ID, 'claude', cwd, firstMessage.split(' ').slice(0, 4).join(' '));
  sessionsDb.assignProviderSessionId(APP_ID, NATIVE_ID);
  getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(transcriptPath, APP_ID);
}

async function sync(transcriptPath: string, lines: string[]) {
  await writeFile(transcriptPath, `${lines.join('\n')}\n`);
  await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);
  return sessionsDb.getSessionById(APP_ID);
}

test('a CloudCLI placeholder name gives way to Claude\'s title, and keeps following it', async () => {
  await withSession(async ({ cwd, transcriptPath }) => {
    startAppSession(cwd, transcriptPath, 'Fix the login bug on the settings page');

    let row = await sync(transcriptPath, [userLine(cwd, 'Fix the login bug on the settings page')]);
    assert.equal(row?.custom_name, 'Fix the login bug', 'the placeholder stays until Claude titles the chat');

    row = await sync(transcriptPath, [userLine(cwd, 'Fix the login bug on the settings page'), aiTitle('Login bug fix')]);
    assert.equal(row?.custom_name, 'Login bug fix');
    assert.equal(row?.custom_name_auto, 1);

    // A rename from /rename or the VS Code panel lands as a custom-title.
    row = await sync(transcriptPath, [
      userLine(cwd, 'Fix the login bug on the settings page'), aiTitle('Login bug fix'), customTitle('Settings login'), aiTitle('Login bug fix'),
    ]);
    assert.equal(row?.custom_name, 'Settings login');
  });
});

test('a name the user typed is kept over Claude\'s title', async () => {
  await withSession(async ({ cwd, transcriptPath }) => {
    startAppSession(cwd, transcriptPath, 'Fix the login bug');
    sessionsDb.updateSessionNameState(APP_ID, 'My own name', false);

    const row = await sync(transcriptPath, [userLine(cwd, 'Fix the login bug'), aiTitle('Login bug fix'), customTitle('Elsewhere')]);
    assert.equal(row?.custom_name, 'My own name');
    assert.equal(row?.custom_name_auto, 0);
  });
});

test('rows from before the change are sorted by whether their name is CloudCLI\'s own', async () => {
  await withSession(async ({ cwd, transcriptPath }) => {
    startAppSession(cwd, transcriptPath, 'Fix the login bug on the settings page');
    getConnection().prepare('UPDATE sessions SET custom_name_auto = NULL WHERE session_id = ?').run(APP_ID);

    // Still the placeholder from the first message: automatic.
    let row = await sync(transcriptPath, [userLine(cwd, 'Fix the login bug on the settings page'), aiTitle('Login bug fix')]);
    assert.equal(row?.custom_name, 'Login bug fix');
    assert.equal(row?.custom_name_auto, 1);

    // Renamed in CloudCLI before the change: the user's.
    getConnection()
      .prepare('UPDATE sessions SET custom_name = ?, custom_name_auto = NULL WHERE session_id = ?')
      .run('Renamed long ago', APP_ID);
    row = await sync(transcriptPath, [userLine(cwd, 'Fix the login bug on the settings page'), aiTitle('Login bug fix')]);
    assert.equal(row?.custom_name, 'Renamed long ago');
    assert.equal(row?.custom_name_auto, 0);
  });
});

test('renaming in CloudCLI writes the name into the transcript, which sync then follows', async () => {
  await withSession(async ({ cwd, transcriptPath }) => {
    startAppSession(cwd, transcriptPath, 'Fix the login bug');
    await writeFile(transcriptPath, `${userLine(cwd, 'Fix the login bug')}\n${aiTitle('Login bug fix')}\n`);

    await sessionsService.renameSessionById(APP_ID, 'Settings login');

    const lines = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const renamed = lines.filter((line) => line.type === 'custom-title');
    assert.equal(renamed.length, 1);
    assert.equal(renamed[0].customTitle, 'Settings login');
    assert.equal(renamed[0].sessionId, NATIVE_ID);
    assert.equal(sessionsDb.getSessionById(APP_ID)?.custom_name_auto, 1, 'the transcript now carries the name');

    await new ClaudeSessionSynchronizer().synchronizeFile(transcriptPath);
    assert.equal(sessionsDb.getSessionById(APP_ID)?.custom_name, 'Settings login');
  });
});

test('a rename that cannot reach the transcript is kept as the user\'s own name', async () => {
  await withSession(async ({ cwd, transcriptPath }) => {
    startAppSession(cwd, transcriptPath, 'Fix the login bug');
    // The transcript is gone, so the SDK has nothing to retitle.

    await sessionsService.renameSessionById(APP_ID, 'Settings login');

    const row = sessionsDb.getSessionById(APP_ID);
    assert.equal(row?.custom_name, 'Settings login');
    assert.equal(row?.custom_name_auto, 0);
  });
});
