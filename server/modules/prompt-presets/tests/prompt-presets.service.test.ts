import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  promptPresetsDb,
  userDb,
} from '@/modules/database/index.js';
import { createPromptPresetsService } from '@/modules/prompt-presets/prompt-presets.service.js';

type PromptPresetsService = ReturnType<typeof createPromptPresetsService>;

type Fixture = {
  service: PromptPresetsService;
  /** Moves the service's clock forward one second and returns nothing; each write gets a distinct time. */
  tick(): void;
  userId: number;
  otherUserId: number;
  projectId: string;
  otherProjectId: string;
};

async function withService(runTest: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'prompt-presets-service-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  let clock = Date.UTC(2026, 0, 1);
  const service = createPromptPresetsService({
    presets: promptPresetsDb,
    projectExists: (projectId) => projectsDb.getProjectById(projectId) !== null,
    now: () => new Date(clock),
  });

  try {
    await runTest({
      service,
      tick: () => { clock += 1000; },
      userId: Number(userDb.createUser('owner', 'hash').id),
      otherUserId: Number(userDb.createUser('other', 'hash').id),
      projectId: projectsDb.createProjectPath(path.join(tempDirectory, 'alpha')).project!.project_id,
      otherProjectId: projectsDb.createProjectPath(path.join(tempDirectory, 'beta')).project!.project_id,
    });
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

/** Asserts that `run` throws an AppError with this status and code. */
function assertAppError(run: () => unknown, statusCode: number, code: string): void {
  assert.throws(run, (error: unknown) => {
    const appError = error as { statusCode?: number; code?: string };
    assert.equal(appError.statusCode, statusCode);
    assert.equal(appError.code, code);
    return true;
  });
}

test('create returns the client shape with string id, trimmed title and untouched content', async () => {
  await withService(({ service, userId, projectId }) => {
    const preset = service.create(userId, { projectId, title: '  Review  ', content: '  Review this diff\n', global: false });

    assert.equal(typeof preset.id, 'string');
    assert.equal(preset.title, 'Review');
    assert.equal(preset.content, '  Review this diff\n');
    assert.equal(preset.projectId, projectId);
    assert.equal(preset.global, false);
    assert.equal(preset.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(preset.updatedAt, preset.createdAt);
    assert.equal(preset.lastUsedAt, null);
  });
});

test('global: true stores no project and needs no projectId', async () => {
  await withService(({ service, userId, projectId }) => {
    assert.equal(service.create(userId, { title: 'g1', content: 'x', global: true }).projectId, null);
    const global = service.create(userId, { projectId, title: 'g2', content: 'x', global: true });
    assert.equal(global.projectId, null);
    assert.equal(global.global, true);
  });
});

test('create validates title, content and projectId', async () => {
  await withService(({ service, userId, projectId }) => {
    const valid = { projectId, title: 'ok', content: 'x', global: false };
    assertAppError(() => service.create(userId, { ...valid, title: '   ' }), 400, 'INVALID_PRESET_TITLE');
    assertAppError(() => service.create(userId, { ...valid, title: 'a'.repeat(121) }), 400, 'INVALID_PRESET_TITLE');
    assert.equal(service.create(userId, { ...valid, title: 'a'.repeat(120) }).title.length, 120);
    assertAppError(() => service.create(userId, { ...valid, content: ' \n\t' }), 400, 'INVALID_PRESET_CONTENT');
    assertAppError(() => service.create(userId, { ...valid, content: 'a'.repeat(100_001) }), 413, 'PRESET_CONTENT_TOO_LONG');
    assert.equal(service.create(userId, { ...valid, content: 'a'.repeat(100_000) }).content.length, 100_000);
    assertAppError(() => service.create(userId, { ...valid, projectId: undefined }), 400, 'INVALID_PROJECT_ID');
    assertAppError(() => service.create(userId, { ...valid, projectId: 'p'.repeat(201) }), 400, 'INVALID_PROJECT_ID');
    assertAppError(() => service.create(userId, { ...valid, projectId: 'unknown-project' }), 404, 'PROJECT_NOT_FOUND');
  });
});

test('list shows the project\'s and global presets only, most recently used first, then title', async () => {
  await withService(({ service, tick, userId, otherUserId, projectId, otherProjectId }) => {
    service.create(userId, { projectId, title: 'beta', content: 'x', global: false });
    service.create(userId, { title: 'Alpha', content: 'x', global: true });
    const older = service.create(userId, { projectId, title: 'zulu', content: 'x', global: false });
    const newer = service.create(userId, { title: 'yankee', content: 'x', global: true });
    service.create(userId, { projectId: otherProjectId, title: 'other project', content: 'x', global: false });
    service.create(otherUserId, { projectId, title: 'other user', content: 'x', global: false });

    tick();
    service.markUsed(userId, older.id);
    tick();
    service.markUsed(userId, newer.id);

    assert.deepEqual(service.list(userId, projectId).map((preset) => preset.title), ['yankee', 'zulu', 'Alpha', 'beta']);
    assert.deepEqual(service.list(userId, otherProjectId).map((preset) => preset.title), ['yankee', 'Alpha', 'other project']);
    assert.deepEqual(service.list(otherUserId, projectId).map((preset) => preset.title), ['other user']);
    assertAppError(() => service.list(userId, undefined), 400, 'INVALID_PROJECT_ID');
  });
});

test('markUsed stamps lastUsedAt without counting as an edit', async () => {
  await withService(({ service, tick, userId, projectId }) => {
    const preset = service.create(userId, { projectId, title: 't', content: 'x', global: false });
    tick();
    const used = service.markUsed(userId, preset.id);
    assert.equal(used.lastUsedAt, '2026-01-01T00:00:01.000Z');
    assert.equal(used.updatedAt, preset.updatedAt);
  });
});

test('update edits fields and moves presets between global and project scope', async () => {
  await withService(({ service, tick, userId, projectId, otherProjectId }) => {
    const preset = service.create(userId, { projectId, title: 't', content: 'x', global: false });
    tick();

    const edited = service.update(userId, preset.id, { title: ' New ', content: 'y' });
    assert.equal(edited.title, 'New');
    assert.equal(edited.content, 'y');
    assert.equal(edited.projectId, projectId);
    assert.equal(edited.updatedAt, '2026-01-01T00:00:01.000Z');

    // global: false on a project preset keeps its project.
    assert.equal(service.update(userId, preset.id, { global: false }).projectId, projectId);
    // projectId alone moves a project preset.
    assert.equal(service.update(userId, preset.id, { projectId: otherProjectId }).projectId, otherProjectId);

    const global = service.update(userId, preset.id, { global: true, projectId });
    assert.equal(global.projectId, null);
    assert.equal(global.global, true);

    // projectId alone does not scope a global preset; global: false must say so.
    assert.equal(service.update(userId, preset.id, { projectId }).projectId, null);
    assertAppError(() => service.update(userId, preset.id, { global: false }), 400, 'INVALID_PROJECT_ID');
    assertAppError(() => service.update(userId, preset.id, { global: false, projectId: 'nope' }), 404, 'PROJECT_NOT_FOUND');

    const scoped = service.update(userId, preset.id, { global: false, projectId });
    assert.equal(scoped.projectId, projectId);
    assert.equal(scoped.global, false);
  });
});

test('update validates its fields and refuses an empty change', async () => {
  await withService(({ service, userId, projectId }) => {
    const preset = service.create(userId, { projectId, title: 't', content: 'x', global: false });
    assertAppError(() => service.update(userId, preset.id, {}), 400, 'INVALID_REQUEST_BODY');
    assertAppError(() => service.update(userId, preset.id, { title: '' }), 400, 'INVALID_PRESET_TITLE');
    assertAppError(() => service.update(userId, preset.id, { content: '  ' }), 400, 'INVALID_PRESET_CONTENT');
    assert.equal(service.list(userId, projectId)[0].title, 't');
  });
});

test('another user\'s preset, or an unknown id, is 404 for every operation', async () => {
  await withService(({ service, userId, otherUserId, projectId }) => {
    const preset = service.create(userId, { projectId, title: 't', content: 'x', global: false });

    for (const id of [preset.id, 'no-such-preset']) {
      assertAppError(() => service.update(otherUserId, id, { title: 'x' }), 404, 'PROMPT_PRESET_NOT_FOUND');
      assertAppError(() => service.markUsed(otherUserId, id), 404, 'PROMPT_PRESET_NOT_FOUND');
      assertAppError(() => service.remove(otherUserId, id), 404, 'PROMPT_PRESET_NOT_FOUND');
    }
    assert.equal(service.list(userId, projectId).length, 1);

    service.remove(userId, preset.id);
    assert.equal(service.list(userId, projectId).length, 0);
    assertAppError(() => service.remove(userId, preset.id), 404, 'PROMPT_PRESET_NOT_FOUND');
  });
});

test('a user may keep at most 500 presets', async () => {
  await withService(({ service, userId, otherUserId, projectId }) => {
    for (let index = 0; index < 500; index += 1) {
      service.create(userId, { title: `preset ${index}`, content: 'x', global: true });
    }
    assertAppError(
      () => service.create(userId, { projectId, title: 'one too many', content: 'x', global: false }),
      413,
      'TOO_MANY_PROMPT_PRESETS',
    );
    assert.equal(service.create(otherUserId, { title: 'theirs', content: 'x', global: true }).title, 'theirs');
  });
});
