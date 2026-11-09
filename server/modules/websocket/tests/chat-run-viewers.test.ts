import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A run the server starts itself — a queued message going once the previous
 * turn ends, a scheduled message coming due — or one another tab starts used
 * to reach only the socket that sent it and sockets that subscribed while it
 * was already going. A page that had the session open saw nothing of it until
 * a reload. Every socket whose latest `chat.subscribe` names the session now
 * watches each new run from its prompt on.
 */

const SESSION_A = 'viewed-session-a';
const SESSION_B = 'viewed-session-b';

type FakeSocket = EventEmitter & {
  readyState: number;
  frames: Array<Record<string, unknown>>;
  send: (data: string) => void;
};

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

/**
 * A runtime whose every run streams one delta and completes, the way a short
 * provider turn does, labelling its events with a provider-native id the
 * writer remaps.
 */
const runtime = {
  hasRuntime: () => true,
  hasBackgroundWork: () => false,
  getPendingApprovalsForSession: () => [],
  abort: async () => true,
  run: async (_provider: string, command: string, _options: unknown, writer: { send: (message: unknown) => void }) => {
    writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: `reply to ${command}` });
    writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
  },
};

const dependencies = { runtime: runtime as never };

async function withSessions(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-run-viewers-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    sessionsDb.createAppSession(SESSION_A, 'claude', tempDirectory);
    sessionsDb.createAppSession(SESSION_B, 'claude', tempDirectory);
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A browser tab: a connected chat socket that has the given sessions open. */
async function openTab(...sessionIds: string[]): Promise<FakeSocket> {
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  subscribe(socket, ...sessionIds);
  await settle();
  return socket;
}

function subscribe(socket: FakeSocket, ...sessionIds: string[]): void {
  socket.emit('message', JSON.stringify({
    type: 'chat.subscribe',
    sessions: sessionIds.map((sessionId) => ({ sessionId, lastSeq: 0 })),
  }));
}

/** The frames a run streamed, leaving out the subscribe acks. */
function runFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.frames.filter((frame) => frame.kind !== 'chat_subscribed');
}

/** The socket listener does not await the async handlers. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a tab with the session open sees a server-started turn live, prompt first', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);

    const result = await runDetachedChatTurn(
      { sessionId: SESSION_A, userId: 1, content: 'queued follow-up', queuedMessageIds: ['q1', 'q2'] },
      dependencies,
    );
    assert.equal(result.started, true);

    const frames = runFrames(tab);
    assert.deepEqual(frames.map((frame) => frame.kind), ['text', 'stream_delta', 'complete']);

    const [prompt, delta, complete] = frames;
    assert.equal(prompt.role, 'user');
    assert.equal(prompt.isTurnPrompt, true);
    assert.equal(prompt.content, 'queued follow-up');
    assert.deepEqual(prompt.queuedMessageIds, ['q1', 'q2']);
    assert.equal(prompt.sessionId, SESSION_A);
    assert.equal(typeof prompt.id, 'string');
    assert.match(String(prompt.timestamp), /^\d{4}-\d{2}-\d{2}T/);
    // Sequenced like the rest of the run, so a reconnecting tab replays it in order.
    assert.deepEqual(frames.map((frame) => frame.seq), [1, 2, 3]);
    // Provider-native ids never leave the gateway.
    assert.equal(delta.sessionId, SESSION_A);
    assert.equal(complete.sessionId, SESSION_A);
  });
});

test('a server-started turn reaches no tab that has another session open', async () => {
  await withSessions(async () => {
    const otherTab = await openTab(SESSION_B);

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'not for you' }, dependencies);

    assert.deepEqual(runFrames(otherTab), []);
  });
});

test('a tab that switched sessions gets runs of the new one, not of the one it left', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);
    subscribe(tab, SESSION_B);
    await settle();

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'left behind' }, dependencies);
    assert.deepEqual(runFrames(tab), [], 'the session it left no longer streams to it');

    await runDetachedChatTurn({ sessionId: SESSION_B, userId: 1, content: 'now open' }, dependencies);
    const frames = runFrames(tab);
    assert.equal(frames[0]?.content, 'now open');
    assert.ok(frames.every((frame) => frame.sessionId === SESSION_B));
  });
});

test('a tab that left every session gets no new runs', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);
    subscribe(tab);
    await settle();

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'nobody here' }, dependencies);
    assert.deepEqual(runFrames(tab), []);
  });
});

test('a closed socket is forgotten and added to no later run', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);
    // Only the close event: the socket still claims to be open, so nothing
    // but the cleanup on close keeps it out of the next run.
    tab.emit('close');

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'after close' }, dependencies);
    assert.deepEqual(runFrames(tab), []);
  });
});

test('a viewer that closed without its close event being seen is skipped, not written to', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);
    tab.readyState = 3; // CLOSED
    tab.send = () => { throw new Error('a closed socket must not be written to'); };

    const result = await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'still runs' }, dependencies);
    assert.equal(result.started, true);
    assert.equal(result.error, null);
  });
});

test('the tab that sends a turn gets each event once, with its echo id on the prompt', async () => {
  await withSessions(async () => {
    // Viewing the session and sending to it: both routes lead to this socket.
    const sender = await openTab(SESSION_A);
    const otherTab = await openTab(SESSION_A);

    sender.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_A,
      content: 'from tab one',
      clientMessageId: 'local_1700000000000_abc123',
    }));
    await settle();

    const senderFrames = runFrames(sender);
    assert.deepEqual(senderFrames.map((frame) => frame.kind), ['text', 'stream_delta', 'complete']);
    assert.equal(senderFrames[0].id, 'local_1700000000000_abc123');

    // The other tab watching the session sees the same run, prompt included.
    const otherFrames = runFrames(otherTab);
    assert.deepEqual(otherFrames.map((frame) => frame.kind), ['text', 'stream_delta', 'complete']);
    assert.equal(otherFrames[0].content, 'from tab one');
    assert.equal(otherFrames[0].isTurnPrompt, true);
    assert.equal(otherFrames[0].id, 'local_1700000000000_abc123');
    assert.equal(otherFrames[0].queuedMessageIds, undefined, 'a typed send took nothing from the queue');
  });
});

test('a client message id that is not a plain token is replaced by a server id', async () => {
  await withSessions(async () => {
    const sender = await openTab(SESSION_A);
    sender.emit('message', JSON.stringify({
      type: 'chat.send',
      sessionId: SESSION_A,
      content: 'hello',
      clientMessageId: '<img src=x onerror=alert(1)>',
    }));
    await settle();

    const prompt = runFrames(sender)[0];
    assert.equal(prompt.isTurnPrompt, true);
    assert.match(String(prompt.id), /^prompt_[0-9a-f-]{36}$/);
  });
});

test('the prompt carries the turn\'s verified attachments, split into images and files', async () => {
  await withSessions(async () => {
    const tab = await openTab(SESSION_A);
    // Outside the upload store, so the gateway drops it: what the provider
    // would not be given is not announced either.
    await runDetachedChatTurn({
      sessionId: SESSION_A,
      userId: 1,
      content: 'look',
      options: { attachments: [{ path: '/etc/passwd', name: 'passwd' }] },
    }, dependencies);

    const prompt = runFrames(tab)[0];
    assert.equal(prompt.images, undefined);
    assert.equal(prompt.files, undefined);
  });
});

test('a tab that subscribes mid-run replays the prompt before the rest of the run', async () => {
  await withSessions(async () => {
    let finish: () => void = () => {};
    const heldRuntime = {
      ...runtime,
      run: async (_provider: string, _command: string, _options: unknown, writer: { send: (message: unknown) => void }) => {
        writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: 'partial' });
        await new Promise<void>((resolve) => { finish = resolve; });
        writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
      },
    };
    const running = runDetachedChatTurn(
      { sessionId: SESSION_A, userId: 1, content: 'long turn' },
      { runtime: heldRuntime as never },
    );
    await settle();

    const lateTab = await openTab(SESSION_A);
    const replayed = runFrames(lateTab);
    assert.deepEqual(replayed.map((frame) => frame.kind), ['text', 'stream_delta']);
    assert.equal(replayed[0].content, 'long turn');

    finish();
    await running;
    // Attached by the subscribe, so it sees the end live too, once.
    assert.equal(runFrames(lateTab).filter((frame) => frame.kind === 'complete').length, 1);
  });
});
