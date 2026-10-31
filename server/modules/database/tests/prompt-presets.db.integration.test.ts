import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
  promptPresetsDb,
  userDb,
} from '@/modules/database/index.js';

type Fixture = { userId: number; otherUserId: number; projectId: string; otherProjectId: string };

async function withDatabase(runTest: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'prompt-presets-db-'));

  closeConnection();
  const databasePath = path.join(tempDirectory, 'auth.db');
  process.env.DATABASE_PATH = databasePath;
  // An existing file stops the connection from copying the legacy install-directory database in.
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    const userId = Number(userDb.createUser('preset-owner', 'hash').id);
    const otherUserId = Number(userDb.createUser('someone-else', 'hash').id);
    const projectId = projectsDb.createProjectPath(path.join(tempDirectory, 'alpha')).project!.project_id;
    const otherProjectId = projectsDb.createProjectPath(path.join(tempDirectory, 'beta')).project!.project_id;
    await runTest({ userId, otherUserId, projectId, otherProjectId });
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

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

test('migrations create prompt_presets with its (user_id, project_id) index', async () => {
  await withDatabase(() => {
    const index = getConnection()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_prompt_presets_user_project'")
      .get() as { sql: string } | undefined;
    assert.match(index?.sql ?? '', /prompt_presets\s*\(user_id, project_id\)/);
  });
});

test('listForProject returns the project and global presets, used first, then title ignoring case', async () => {
  await withDatabase(({ userId, otherUserId, projectId, otherProjectId }) => {
    const create = (title: string, scope: string | null, owner = userId) => promptPresetsDb.create(
      { userId: owner, projectId: scope, title, content: `${title} body` },
      500,
      at(0),
    )!;
    const banana = create('banana', projectId);
    create('Apple', null);
    create('cherry', projectId);
    const usedOld = create('zeta', null);
    const usedNew = create('omega', projectId);
    create('elsewhere', otherProjectId);
    create('not mine', projectId, otherUserId);

    promptPresetsDb.markUsed(userId, usedOld.id, at(10));
    promptPresetsDb.markUsed(userId, usedNew.id, at(20));

    const titles = promptPresetsDb.listForProject(userId, projectId).map((row) => row.title);
    assert.deepEqual(titles, ['omega', 'zeta', 'Apple', 'banana', 'cherry']);
    assert.equal(promptPresetsDb.listForProject(userId, projectId)[3].id, banana.id);
  });
});

test('create stores ISO timestamps and refuses once the per-user limit is reached', async () => {
  await withDatabase(({ userId, otherUserId, projectId }) => {
    const first = promptPresetsDb.create({ userId, projectId, title: 'one', content: 'x' }, 2, at(1))!;
    assert.equal(first.created_at, at(1).toISOString());
    assert.equal(first.updated_at, at(1).toISOString());
    assert.equal(first.last_used_at, null);
    assert.equal(first.project_id, projectId);

    assert.ok(promptPresetsDb.create({ userId, projectId: null, title: 'two', content: 'x' }, 2, at(2)));
    assert.equal(promptPresetsDb.create({ userId, projectId, title: 'three', content: 'x' }, 2, at(3)), null);
    // The limit counts one user's presets only.
    assert.ok(promptPresetsDb.create({ userId: otherUserId, projectId, title: 'theirs', content: 'x' }, 2, at(3)));
  });
});

test('update, markUsed and delete only reach the owner\'s preset', async () => {
  await withDatabase(({ userId, otherUserId, projectId, otherProjectId }) => {
    const preset = promptPresetsDb.create({ userId, projectId, title: 'draft', content: 'x' }, 500, at(1))!;

    assert.equal(promptPresetsDb.update(otherUserId, preset.id, { title: 'hijack' }, at(2)), null);
    assert.equal(promptPresetsDb.markUsed(otherUserId, preset.id, at(2)), null);
    assert.equal(promptPresetsDb.delete(otherUserId, preset.id), false);
    assert.equal(promptPresetsDb.getById(otherUserId, preset.id), null);

    const moved = promptPresetsDb.update(userId, preset.id, { title: 'final', projectId: otherProjectId }, at(3))!;
    assert.equal(moved.title, 'final');
    assert.equal(moved.content, 'x');
    assert.equal(moved.project_id, otherProjectId);
    assert.equal(moved.updated_at, at(3).toISOString());

    const global = promptPresetsDb.update(userId, preset.id, { projectId: null }, at(4))!;
    assert.equal(global.project_id, null);

    const used = promptPresetsDb.markUsed(userId, preset.id, at(5))!;
    assert.equal(used.last_used_at, at(5).toISOString());
    assert.equal(used.updated_at, at(4).toISOString(), 'using a preset is not an edit');

    assert.equal(promptPresetsDb.delete(userId, preset.id), true);
    assert.equal(promptPresetsDb.getById(userId, preset.id), null);
  });
});

test('permanently deleting a project removes its presets but keeps global ones', async () => {
  await withDatabase(({ userId, projectId }) => {
    promptPresetsDb.create({ userId, projectId, title: 'project', content: 'x' }, 500, at(1));
    promptPresetsDb.create({ userId, projectId: null, title: 'global', content: 'x' }, 500, at(1));

    // Archiving only flags the project row, so its presets survive it.
    projectsDb.updateProjectIsArchivedById(projectId, true);
    assert.equal(promptPresetsDb.listForProject(userId, projectId).length, 2);

    projectsDb.deleteProjectById(projectId);
    assert.deepEqual(promptPresetsDb.listForProject(userId, projectId).map((row) => row.title), ['global']);
  });
});

test('a preset cannot point at a project that does not exist', async () => {
  await withDatabase(({ userId }) => {
    assert.throws(
      () => promptPresetsDb.create({ userId, projectId: 'no-such-project', title: 't', content: 'x' }, 500, at(1)),
      /FOREIGN KEY/,
    );
  });
});
