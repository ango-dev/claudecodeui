import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Drafts moved out of the browser and into auth.db so a message half-typed on
 * one device can be finished on another — the case the composer could not serve
 * at all before, because a draft only existed on the machine it was typed on.
 *
 * Each test loads a fresh module copy, because the store reads its localStorage
 * mirror once at module scope.
 */

type SavedDraft = { scope: string; text: string };

const savedDrafts: SavedDraft[] = [];
const deletedScopes: string[] = [];
const queueRequests: unknown[][] = [];
let serverDrafts: unknown[] = [];
let draftsRequestFailed = false;
let queueStatus = 200;
/** Holds the next queue request open until released, to test a hydrate that overtakes it. */
let holdQueueRequest: Promise<void> | null = null;

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: async () => {
        if (draftsRequestFailed) {
          throw new Error('offline');
        }
        return new Response(JSON.stringify({ success: true, drafts: serverDrafts }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      saveDraft: async (scope: string, draft: { text: string }) => {
        savedDrafts.push({ scope, ...draft });
        return new Response('{}', { status: 200 });
      },
      queueMessage: async (scope: string, message: unknown) => {
        queueRequests.push(['queue', scope, message]);
        await holdQueueRequest;
        return new Response('{}', { status: queueStatus });
      },
      unqueueMessage: async (scope: string, id: string) => {
        queueRequests.push(['unqueue', scope, id]);
        return new Response('{}', { status: 200 });
      },
      deleteDraft: async (scope: string) => {
        deletedScopes.push(scope);
        return new Response('{}', { status: 200 });
      },
    },
  },
}));

const loadStore = async () => {
  vi.resetModules();
  return import('@/shared/chatDrafts');
};

beforeEach(() => {
  localStorage.clear();
  savedDrafts.length = 0;
  deletedScopes.length = 0;
  queueRequests.length = 0;
  serverDrafts = [];
  draftsRequestFailed = false;
  queueStatus = 200;
  holdQueueRequest = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('a draft is readable synchronously and reaches the server after the debounce', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'half a thought');

  assert.equal(store.readDraftText('session-a'), 'half a thought');
  assert.deepEqual(savedDrafts, [], 'the request must not fire on every keystroke');

  await vi.advanceTimersByTimeAsync(1_500);
  assert.deepEqual(savedDrafts, [
    { scope: 'session-a', text: 'half a thought' },
  ]);
});

test('each session keeps its own draft', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'for A');
  store.writeDraftText('session-b', 'for B');

  assert.equal(store.readDraftText('session-a'), 'for A');
  assert.equal(store.readDraftText('session-b'), 'for B');
});

test('a chat with no session yet is scoped to its project', async () => {
  const store = await loadStore();

  store.writeDraftText('project:p1', 'unsent');

  assert.equal(store.readDraftText('project:p1'), 'unsent');
  assert.equal(store.readDraftText('session-a'), '');
});

test('clearing a draft saves empty text, which the server drops, without touching the queue', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'typed');
  await vi.advanceTimersByTimeAsync(1_500);
  savedDrafts.length = 0;

  store.writeDraftText('session-a', '');
  await vi.advanceTimersByTimeAsync(1_500);

  // Deleting the row would also drop messages queued from another device.
  assert.deepEqual(savedDrafts, [{ scope: 'session-a', text: '' }]);
  assert.deepEqual(deletedScopes, []);
});

test('a draft written in one page load is readable synchronously in the next', async () => {
  const first = await loadStore();
  first.writeDraftText('session-a', 'survives a reload');

  // No hydrate: this is the first paint of the next load, before any request
  // could have resolved.
  const second = await loadStore();
  assert.equal(second.readDraftText('session-a'), 'survives a reload');
});

test('hydrate brings in a draft typed on another device', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'typed on the laptop', queuedMessages: [] }];

  const store = await loadStore();
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'typed on the laptop');
});

test('hydrate removes a queued message after the server sends it', async () => {
  const store = await loadStore();
  await store.appendQueuedMessage('session-a', { id: 'q1', content: 'first' });
  await store.appendQueuedMessage('session-a', { id: 'q2', content: 'second' });

  serverDrafts = [{ scope: 'session-a', text: '', queuedMessages: [{ id: 'q2', content: 'second' }] }];
  await store.hydrateChatDrafts();

  assert.deepEqual(store.readQueuedMessages('session-a').map((message) => message.id), ['q2']);
});

test('a hydrate that overtakes a queue request keeps the queued message', async () => {
  const store = await loadStore();
  let release = () => undefined as void;
  holdQueueRequest = new Promise<void>((resolve) => { release = resolve; });
  const queued = store.appendQueuedMessage('session-a', { id: 'q1', content: 'in flight' });

  // The server has not stored it yet, so its copy is missing it.
  serverDrafts = [];
  await store.hydrateChatDrafts();
  assert.deepEqual(store.readQueuedMessages('session-a').map((message) => message.id), ['q1']);

  release();
  assert.equal(await queued, true);
});

test('a message the server refuses to queue is taken back out', async () => {
  const store = await loadStore();
  queueStatus = 413;

  assert.equal(await store.appendQueuedMessage('session-a', { id: 'q1', content: 'one too many' }), false);
  assert.deepEqual(store.readQueuedMessages('session-a'), []);
});

test('hydrate does not overwrite a scope the user is typing into right now', async () => {
  serverDrafts = [{ scope: 'session-a', text: 'stale server copy', queuedMessages: [] }];

  const store = await loadStore();
  store.writeDraftText('session-a', 'what I am writing');
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'what I am writing');
});

test('a failed hydrate keeps the mirrored draft rather than blanking the composer', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'local work');
  await vi.advanceTimersByTimeAsync(1_500);

  draftsRequestFailed = true;
  await store.hydrateChatDrafts();

  assert.equal(store.readDraftText('session-a'), 'local work');
});

test('queued messages go to the server one at a time, at once, oldest first', async () => {
  const store = await loadStore();

  store.writeDraftText('session-a', 'still editing');
  await store.appendQueuedMessage('session-a', { id: 'q1', content: 'send this next', attachments: [] });
  await store.appendQueuedMessage('session-a', { id: 'q2', content: 'and then this' });

  assert.equal(store.readDraftText('session-a'), 'still editing');
  assert.deepEqual(store.readQueuedMessages('session-a'), [
    { id: 'q1', content: 'send this next', attachments: [] },
    { id: 'q2', content: 'and then this', attachments: [] },
  ]);
  assert.deepEqual(queueRequests, [
    ['queue', 'session-a', { id: 'q1', content: 'send this next', attachments: [] }],
    ['queue', 'session-a', { id: 'q2', content: 'and then this' }],
  ], 'queue actions persist without waiting for the draft debounce');
  assert.deepEqual(savedDrafts, [], 'and are not part of the text save');
});

test('a queued message with neither text nor attachments reads as absent', async () => {
  const store = await loadStore();

  await store.appendQueuedMessage('session-a', { id: 'q1', content: '   ', attachments: [] });

  assert.deepEqual(store.readQueuedMessages('session-a'), []);
});

test('a single queued message mirrored before the queue took several is read as a queue of one', async () => {
  localStorage.setItem('chat-drafts', JSON.stringify({
    'session-a': { text: '', queuedMessage: { content: '', images: [{ name: 'shot.png' }] } },
  }));
  const store = await loadStore();

  const [legacy] = store.readQueuedMessages('session-a');
  assert.deepEqual(legacy?.attachments, [{ name: 'shot.png' }], 'legacy image-only descriptors read as attachments');
});

test('removing one queued message leaves the others and the draft text alone', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'keep me');
  await store.appendQueuedMessage('session-a', { id: 'q1', content: 'one' });
  await store.appendQueuedMessage('session-a', { id: 'q2', content: 'two' });

  store.removeQueuedMessage('session-a', 'q1');

  assert.deepEqual(store.readQueuedMessages('session-a').map((message) => message.id), ['q2']);
  assert.equal(store.readDraftText('session-a'), 'keep me');
  assert.deepEqual(queueRequests.at(-1), ['unqueue', 'session-a', 'q1']);
});

test('subscribers are notified on a write', async () => {
  const store = await loadStore();
  const listener = vi.fn();
  const unsubscribe = store.subscribeToChatDrafts(listener);

  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  // Writing the same text again changes nothing, so nobody is woken.
  store.writeDraftText('session-a', 'typed');
  assert.equal(listener.mock.calls.length, 1);

  unsubscribe();
  store.writeDraftText('session-a', 'more');
  assert.equal(listener.mock.calls.length, 1);
});

test('reset clears the drafts so the next user does not see them', async () => {
  const store = await loadStore();
  store.writeDraftText('session-a', 'private');

  store.resetChatDrafts();

  assert.equal(store.readDraftText('session-a'), '');
  assert.equal(localStorage.getItem('chat-drafts'), null);
});
