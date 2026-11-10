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
 * "Every single time the prompt completes it plays the complete sound more
 * than once." Since every socket that has a session open watches each of its
 * runs, a session open in two tabs (or on a laptop and a phone) got the run's
 * `complete` on both, and both pages dinged. A run's `complete` now carries
 * the run's `runId`, reaches each socket once, and exactly one socket's copy
 * says `playSound: true` — the page in front of the user, by its last
 * `chat.presence` frame.
 */

const SESSION_A = 'sound-session-a';

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

/** Lets a test hold a run open between its first event and its `complete`. */
let releaseRun: () => void = () => {};
let holdRuns = false;

const runtime = {
  hasRuntime: () => true,
  hasBackgroundWork: () => false,
  getPendingApprovalsForSession: () => [],
  abort: async () => true,
  run: async (_provider: string, command: string, _options: unknown, writer: { send: (message: unknown) => void }) => {
    writer.send({ kind: 'stream_delta', provider: 'claude', sessionId: 'native', content: `reply to ${command}` });
    if (holdRuns) {
      await new Promise<void>((resolve) => { releaseRun = resolve; });
    }
    writer.send({ kind: 'complete', provider: 'claude', sessionId: 'native', exitCode: 0 });
  },
};

const dependencies = { runtime: runtime as never };

async function withSession(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-completion-sound-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  holdRuns = false;
  try {
    sessionsDb.createAppSession(SESSION_A, 'claude', tempDirectory);
    await runTest();
  } finally {
    holdRuns = false;
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

/** The socket listener does not await the async handlers. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

function subscribe(socket: FakeSocket, lastSeq = 0): void {
  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_A, lastSeq }] }));
}

function reportPresence(socket: FakeSocket, presence: { visible: boolean; focused: boolean }): void {
  socket.emit('message', JSON.stringify({ type: 'chat.presence', ...presence }));
}

/** A browser tab with the session open, optionally reporting where its page stands. */
async function openTab(presence?: { visible: boolean; focused: boolean }): Promise<FakeSocket> {
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, dependencies);
  if (presence) {
    reportPresence(socket, presence);
  }
  subscribe(socket);
  await settle();
  return socket;
}

function send(socket: FakeSocket, content: string): void {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_A, content }));
}

const completes = (socket: FakeSocket) => socket.frames.filter((frame) => frame.kind === 'complete');

test('the sending tab, also a viewer, gets one complete carrying the run id and the sound', async () => {
  await withSession(async () => {
    const tab = await openTab({ visible: true, focused: true });
    send(tab, 'hello');
    await settle();

    const [complete, ...extra] = completes(tab);
    assert.deepEqual(extra, []);
    assert.match(String(complete.runId), /^[0-9a-f-]{36}$/);
    assert.equal(complete.playSound, true);
    // `chat.presence` is acknowledged by nothing, and never refused.
    assert.equal(tab.frames.some((frame) => frame.kind === 'protocol_error'), false);
  });
});

test('every run has its own id', async () => {
  await withSession(async () => {
    const tab = await openTab();
    send(tab, 'first');
    await settle();
    send(tab, 'second');
    await settle();

    const runIds = completes(tab).map((frame) => frame.runId);
    assert.equal(runIds.length, 2);
    assert.notEqual(runIds[0], runIds[1]);
  });
});

test('re-subscribing mid-run and after the end delivers the complete once', async () => {
  await withSession(async () => {
    holdRuns = true;
    const tab = await openTab();
    send(tab, 'long turn');
    await settle();

    // The page re-subscribes while the run is going (its session object was
    // refreshed), even with a stale lastSeq: the run is replayed, its end is not.
    subscribe(tab, 0);
    subscribe(tab, 1);
    await settle();
    assert.deepEqual(completes(tab), []);

    releaseRun();
    await settle();
    // After the end, a re-subscribe (the transcript sync, a reconnect) replays nothing.
    subscribe(tab, 0);
    await settle();

    assert.equal(completes(tab).length, 1);
  });
});

test('two tabs on the session: both get the complete, only one is told to play the sound', async () => {
  await withSession(async () => {
    const sender = await openTab();
    const viewer = await openTab();
    send(sender, 'hello');
    await settle();

    const [senderComplete] = completes(sender);
    const [viewerComplete] = completes(viewer);
    assert.equal(completes(sender).length, 1);
    assert.equal(completes(viewer).length, 1);
    assert.equal(senderComplete.runId, viewerComplete.runId);
    // Neither page said where it stands, so the tab that sent the turn plays.
    assert.equal(senderComplete.playSound, true);
    assert.equal(viewerComplete.playSound, false);
  });
});

test('the page in front of the user plays, even when another one sent the turn', async () => {
  await withSession(async () => {
    const hiddenSender = await openTab({ visible: false, focused: false });
    const visibleViewer = await openTab({ visible: true, focused: false });
    const focusedViewer = await openTab({ visible: true, focused: true });
    send(hiddenSender, 'hello');
    await settle();

    assert.deepEqual(
      [hiddenSender, visibleViewer, focusedViewer].map((tab) => completes(tab).map((frame) => frame.playSound)),
      [[false], [false], [true]],
    );

    // The user switches to the other visible page; the next turn dings there.
    reportPresence(focusedViewer, { visible: false, focused: false });
    reportPresence(visibleViewer, { visible: true, focused: true });
    send(hiddenSender, 'again');
    await settle();
    assert.deepEqual(
      [hiddenSender, visibleViewer, focusedViewer].map((tab) => completes(tab)[1]?.playSound),
      [false, true, false],
    );
  });
});

test('with every page in the background, the one the user left last plays', async () => {
  await withSession(async () => {
    const leftFirst = await openTab({ visible: true, focused: true });
    const leftLast = await openTab({ visible: true, focused: true });
    const neverSeen = await openTab();
    reportPresence(leftFirst, { visible: false, focused: false });
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    reportPresence(leftLast, { visible: false, focused: false });
    await settle();

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'queued' }, dependencies);

    assert.deepEqual(
      [leftFirst, leftLast, neverSeen].map((tab) => completes(tab).map((frame) => frame.playSound)),
      [[false], [true], [false]],
    );
  });
});

test('a server-started turn with nobody reporting presence still dings once', async () => {
  await withSession(async () => {
    const tabs = [await openTab(), await openTab(), await openTab()];
    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'scheduled' }, dependencies);

    const sounds = tabs.flatMap((tab) => completes(tab)).filter((frame) => frame.playSound === true);
    assert.equal(sounds.length, 1);
  });
});

test('a closed page is never chosen to play the sound', async () => {
  await withSession(async () => {
    const closedButFocused = await openTab({ visible: true, focused: true });
    const open = await openTab({ visible: false, focused: false });
    // Closed without the close event seen yet: the writer must skip it.
    closedButFocused.readyState = 3;

    await runDetachedChatTurn({ sessionId: SESSION_A, userId: 1, content: 'queued' }, dependencies);

    assert.deepEqual(completes(closedButFocused), []);
    assert.deepEqual(completes(open).map((frame) => frame.playSound), [true]);
  });
});

test('an aborted run still ends with a single complete per tab', async () => {
  await withSession(async () => {
    holdRuns = true;
    const tab = await openTab({ visible: true, focused: true });
    const other = await openTab();
    send(tab, 'stop me');
    await settle();

    tab.emit('message', JSON.stringify({ type: 'chat.abort', sessionId: SESSION_A }));
    await settle();
    // The killed runtime still emits its own complete; it is dropped.
    releaseRun();
    await settle();

    assert.equal(completes(tab).length, 1);
    assert.equal(completes(other).length, 1);
    assert.equal(completes(tab)[0].aborted, true);
  });
});
