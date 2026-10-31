import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createPromptPresetsRouter } from '@/modules/prompt-presets/prompt-presets.routes.js';
import { createPromptPresetsService } from '@/modules/prompt-presets/prompt-presets.service.js';
import type { PromptPresetRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type PromptPresetsDependencies = Parameters<typeof createPromptPresetsService>[0];

const USER_ID = 7;
const OTHER_USER_ID = 8;
const PROJECT_ID = 'project-1';
const NOW = new Date('2026-03-04T05:06:07.000Z');

/** An in-memory stand-in for `promptPresetsDb`, scoped by user id the way the SQL is. */
function createMemoryPresets(): PromptPresetsDependencies['presets'] & { rows: PromptPresetRow[] } {
  const rows: PromptPresetRow[] = [];
  let nextId = 1;
  const find = (userId: number, id: string) => rows.find((row) => row.id === id && row.user_id === userId) ?? null;
  return {
    rows,
    listForProject: (userId, projectId) => rows.filter((row) => (
      row.user_id === userId && (row.project_id === projectId || row.project_id === null)
    )),
    getById: find,
    create: (input, maxPerUser, now) => {
      if (rows.filter((row) => row.user_id === input.userId).length >= maxPerUser) {
        return null;
      }
      const row: PromptPresetRow = {
        id: `preset-${nextId++}`,
        user_id: input.userId,
        project_id: input.projectId,
        title: input.title,
        content: input.content,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        last_used_at: null,
      };
      rows.push(row);
      return row;
    },
    update: (userId, id, changes, now) => {
      const row = find(userId, id);
      if (!row) {
        return null;
      }
      if (changes.title !== undefined) row.title = changes.title;
      if (changes.content !== undefined) row.content = changes.content;
      if (changes.projectId !== undefined) row.project_id = changes.projectId;
      row.updated_at = now.toISOString();
      return row;
    },
    markUsed: (userId, id, now) => {
      const row = find(userId, id);
      if (row) {
        row.last_used_at = now.toISOString();
      }
      return row;
    },
    delete: (userId, id) => {
      const index = rows.findIndex((row) => row.id === id && row.user_id === userId);
      if (index === -1) {
        return false;
      }
      rows.splice(index, 1);
      return true;
    },
  };
}

type Harness = {
  baseUrl: string;
  presets: ReturnType<typeof createMemoryPresets>;
  /** Changes which user the fake auth middleware signs requests in as; null signs nobody in. */
  signInAs(userId: number | null): void;
};

/** Serves the router behind a fake `authenticateToken` and the app's error envelope middleware. */
async function withServer(run: (harness: Harness) => Promise<void>): Promise<void> {
  const presets = createMemoryPresets();
  const service = createPromptPresetsService({
    presets,
    projectExists: (projectId) => projectId === PROJECT_ID,
    now: () => NOW,
  });
  let signedInUserId: number | null = USER_ID;

  const app = express();
  // The real app allows 50mb bodies; the 100kb default would cut off the over-long content case first.
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    if (signedInUserId !== null) {
      (req as express.Request & { user?: { id: number } }).user = { id: signedInUserId };
    }
    next();
  });
  app.use('/api/prompt-presets', createPromptPresetsRouter(service));
  // Mirrors the AppError branch of the global error middleware in server/index.ts.
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/api/prompt-presets`,
      presets,
      signInAs: (userId) => { signedInUserId = userId; },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const send = (url: string, method: string, body?: unknown) => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function readJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test('POST creates a preset for the signed-in user and answers 201 with the envelope', async () => {
  await withServer(async ({ baseUrl, presets }) => {
    const response = await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: ' Fix tests ', content: 'Please fix' });

    assert.equal(response.status, 201);
    assert.deepEqual(await readJson(response), {
      success: true,
      data: {
        preset: {
          id: 'preset-1',
          projectId: PROJECT_ID,
          title: 'Fix tests',
          content: 'Please fix',
          global: false,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          lastUsedAt: null,
        },
      },
    });
    assert.equal(presets.rows[0].user_id, USER_ID);
  });
});

test('POST with global: true stores no project', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: 'g', content: 'x', global: true });
    const body = await readJson(response);
    assert.equal(response.status, 201);
    assert.equal(body.data.preset.projectId, null);
    assert.equal(body.data.preset.global, true);
  });
});

test('POST rejects wrong transport types and invalid values with the error envelope', async () => {
  await withServer(async ({ baseUrl, presets }) => {
    const cases: Array<[unknown, number, string]> = [
      [{ projectId: PROJECT_ID, content: 'x' }, 400, 'INVALID_REQUEST_BODY'],
      [{ projectId: PROJECT_ID, title: 'x', content: 5 }, 400, 'INVALID_REQUEST_BODY'],
      [{ projectId: PROJECT_ID, title: 'x', content: 'x', global: 'yes' }, 400, 'INVALID_REQUEST_BODY'],
      [{ projectId: PROJECT_ID, title: '  ', content: 'x' }, 400, 'INVALID_PRESET_TITLE'],
      [{ title: 'x', content: 'x' }, 400, 'INVALID_PROJECT_ID'],
      [{ projectId: 'unknown', title: 'x', content: 'x' }, 404, 'PROJECT_NOT_FOUND'],
      [{ projectId: PROJECT_ID, title: 'x', content: 'a'.repeat(100_001) }, 413, 'PRESET_CONTENT_TOO_LONG'],
    ];
    for (const [payload, status, code] of cases) {
      const response = await send(baseUrl, 'POST', payload);
      const body = await readJson(response);
      assert.equal(response.status, status, JSON.stringify(payload).slice(0, 80));
      assert.equal(body.success, false);
      assert.equal(body.error.code, code);
      assert.equal(typeof body.error.message, 'string');
    }
    assert.equal(presets.rows.length, 0);
  });
});

test('GET lists the user\'s presets for the project and requires projectId', async () => {
  await withServer(async ({ baseUrl, signInAs }) => {
    await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: 'mine', content: 'x' });
    signInAs(OTHER_USER_ID);
    await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: 'theirs', content: 'x' });
    signInAs(USER_ID);

    const response = await fetch(`${baseUrl}?projectId=${encodeURIComponent(PROJECT_ID)}`);
    const body = await readJson(response);
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data.presets.map((preset: { title: string }) => preset.title), ['mine']);

    const missing = await fetch(baseUrl);
    assert.equal(missing.status, 400);
    assert.equal((await readJson(missing)).error.code, 'INVALID_PROJECT_ID');
  });
});

test('PATCH, use and DELETE act on the user\'s preset and 404 on someone else\'s', async () => {
  await withServer(async ({ baseUrl, signInAs }) => {
    const created = await readJson(await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: 't', content: 'x' }));
    const presetUrl = `${baseUrl}/${encodeURIComponent(created.data.preset.id)}`;

    signInAs(OTHER_USER_ID);
    for (const [url, method, body] of [
      [presetUrl, 'PATCH', { title: 'stolen' }],
      [`${presetUrl}/use`, 'POST', undefined],
      [presetUrl, 'DELETE', undefined],
    ] as const) {
      const response = await send(url, method, body);
      assert.equal(response.status, 404, `${method} ${url}`);
      assert.equal((await readJson(response)).error.code, 'PROMPT_PRESET_NOT_FOUND');
    }
    signInAs(USER_ID);

    const patched = await send(presetUrl, 'PATCH', { title: 'renamed', global: true });
    const patchedBody = await readJson(patched);
    assert.equal(patched.status, 200);
    assert.equal(patchedBody.data.preset.title, 'renamed');
    assert.equal(patchedBody.data.preset.global, true);

    const badPatch = await send(presetUrl, 'PATCH', { global: 1 });
    assert.equal(badPatch.status, 400);

    const used = await send(`${presetUrl}/use`, 'POST');
    assert.equal(used.status, 200);
    assert.equal((await readJson(used)).data.preset.lastUsedAt, NOW.toISOString());

    const deleted = await send(presetUrl, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(await readJson(deleted), { success: true, data: { deleted: true } });

    const again = await send(presetUrl, 'DELETE');
    assert.equal(again.status, 404);
  });
});

test('POST answers 413 once the user holds 500 presets', async () => {
  await withServer(async ({ baseUrl, presets }) => {
    for (let index = 0; index < 500; index += 1) {
      presets.create({ userId: USER_ID, projectId: null, title: `p${index}`, content: 'x' }, 500, NOW);
    }
    const response = await send(baseUrl, 'POST', { projectId: PROJECT_ID, title: 'more', content: 'x' });
    assert.equal(response.status, 413);
    assert.equal((await readJson(response)).error.code, 'TOO_MANY_PROMPT_PRESETS');
  });
});

test('a request without an authenticated user is refused with 401', async () => {
  await withServer(async ({ baseUrl, signInAs }) => {
    signInAs(null);
    const response = await fetch(`${baseUrl}?projectId=${PROJECT_ID}`);
    assert.equal(response.status, 401);
    assert.equal((await readJson(response)).error.code, 'USER_REQUIRED');
  });
});
