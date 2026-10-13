import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { agentVisibilityService } from '@/modules/providers/services/agent-visibility.service.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-visibility-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('only Claude Code is shown until the other agents are turned on', async () => {
  await withDatabase(async () => {
    assert.equal(agentVisibilityService.showOtherAgents(), false);
    assert.equal(agentVisibilityService.isVisible('claude'), true);
    assert.equal(agentVisibilityService.isVisible('codex'), false);
  });
});

test('a hidden agent\'s session files are not indexed', async () => {
  await withDatabase(async () => {
    const result = await sessionSynchronizerService.synchronizeProviderFile('codex', '/nonexistent/rollout.jsonl');
    assert.deepEqual(result, { provider: 'codex', indexed: false, sessionId: null });
  });
});

test('turning the others off again hides them', async () => {
  await withDatabase(async () => {
    // Off to off: no scan, nothing changes.
    assert.equal(await agentVisibilityService.setShowOtherAgents(false), false);
    assert.equal(agentVisibilityService.isVisible('cursor'), false);
  });
});
