import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createUserRouter } from '../user.routes.js';
import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];
type DraftCall = [string, ...unknown[]];

const USER_ID = 7;

/** Serves the user routes over a service whose drafts store only records what it was asked to do. */
async function withUserServer(run: (baseUrl: string, calls: DraftCall[]) => Promise<void>): Promise<void> {
  const calls: DraftCall[] = [];
  const unexpected = () => {
    throw new Error('Unexpected user service call');
  };
  const dependencies: UserDependencies = {
    users: {
      getGitConfig: unexpected,
      updateGitConfig: unexpected,
      completeOnboarding: unexpected,
      hasCompletedOnboarding: unexpected,
    },
    preferences: { getPreferences: unexpected, savePreferences: unexpected },
    drafts: {
      getDrafts: () => [],
      saveDraft: (...args) => { calls.push(['saveDraft', ...args]); },
      appendQueuedMessage: (...args) => {
        calls.push(['appendQueuedMessage', ...args]);
        // Stands in for a scope whose queue is already full.
        return args[1] !== 'session-full';
      },
      removeQueuedMessage: (...args) => { calls.push(['removeQueuedMessage', ...args]); },
      deleteDraft: (...args) => { calls.push(['deleteDraft', ...args]); },
    },
    readSystemGitConfig: unexpected,
    applyGlobalGitConfig: unexpected,
    logInfo: () => undefined,
    logError: () => undefined,
  };
  const service = createUserService(dependencies);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: USER_ID };
    next();
  });
  app.use('/api/user', createUserRouter(service));
  app.use((error: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const send = (url: string, method: string, body: unknown) => fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('POST /drafts/queue appends the message for the signed-in user', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queue`, 'POST', {
      scope: 'session-a',
      message: { id: 'q1', content: 'B', options: { model: 'opus' }, attachments: [] },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assert.deepEqual(calls, [[
      'appendQueuedMessage', USER_ID, 'session-a', { id: 'q1', content: 'B', options: { model: 'opus' }, attachments: [] }, 50,
    ]]);
  });
});

test('POST /drafts/queue refuses a message with nothing to send', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queue`, 'POST', {
      scope: 'session-a',
      message: { id: 'q1', content: '   ', attachments: [] },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'INVALID_QUEUED_MESSAGE' });
    assert.deepEqual(calls, []);
  });
});

test('POST /drafts/queue answers 413 when the queue is full', async () => {
  await withUserServer(async (baseUrl) => {
    const response = await send(`${baseUrl}/api/user/drafts/queue`, 'POST', {
      scope: 'session-full',
      message: { id: 'q51', content: 'one more', attachments: [] },
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { code: 'TOO_MANY_QUEUED_MESSAGES' });
  });
});

test('DELETE /drafts/queue removes one queued message by id, not the draft text', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts/queue`, 'DELETE', { scope: 'session-a', id: 'q2' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['removeQueuedMessage', USER_ID, 'session-a', 'q2']]);
  });
});

test('PUT /drafts without a queued message writes only the text', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts`, 'PUT', { scope: 'session-a', text: 'typing' });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['saveDraft', USER_ID, 'session-a', { text: 'typing', queuedMessages: undefined }]]);
  });
});

test('PUT /drafts from an older tab reads its single queued message as a queue of one', async () => {
  await withUserServer(async (baseUrl, calls) => {
    const response = await send(`${baseUrl}/api/user/drafts`, 'PUT', {
      scope: 'session-a',
      text: '',
      queuedMessage: { content: 'later' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['saveDraft', USER_ID, 'session-a', { text: '', queuedMessages: [{ content: 'later' }] }]]);
  });
});
