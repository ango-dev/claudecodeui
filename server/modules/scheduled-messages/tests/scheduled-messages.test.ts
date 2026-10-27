import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  scheduledMessagesDb,
  sessionDraftsDb,
  sessionsDb,
  userDb,
  userPreferencesDb,
} from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
  planQueuedTurn,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry, connectedClients } from '@/modules/websocket/index.js';
import type { SendBackgroundWorkImpact } from '@/shared/types.js';

const SESSION_ID = 'scheduled-session';

async function withIsolatedDatabase(runTest: (userId: number) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const user = userDb.createUser('scheduler', 'hash');
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Scheduled session');
    await runTest(Number(user.id));
  } finally {
    chatRunRegistry.clearAll();
    connectedClients.clear();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The contents of the session's queue, oldest first. */
function contents(userId: number): string[] {
  return (sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? []).map((message) => (message as { content: string }).content);
}

/** Sets the user's "Combine queued messages" toggle the way the client stores it. */
function setCombineQueuedMessages(userId: number, value: boolean | string): void {
  userPreferencesDb.savePreferences(userId, { uiPreferences: { combineQueuedMessages: value } });
}

type RunCall = { provider: string; command: string; options: Record<string, unknown> };

type BackgroundWorkStubs = {
  /** Answers the dispatcher's "would this send stop the work?"; never by default. */
  wouldStopBackgroundWork?: (provider: string, sessionId: string, options: Record<string, unknown>) => Promise<SendBackgroundWorkImpact>;
  /** Receives the listener the dispatcher registers for the end of held work. */
  onBackgroundWorkEnded?: (listener: (sessionId: string) => void) => () => void;
};

function createRuntime(
  runs: RunCall[],
  behaviour: 'ok' | 'throw' = 'ok',
  aborts: string[] = [],
  hasBackgroundWork: (sessionId: string) => boolean = () => false,
  stubs: BackgroundWorkStubs = {},
) {
  return {
    hasRuntime: () => true,
    hasBackgroundWork,
    wouldStopBackgroundWork: stubs.wouldStopBackgroundWork ?? (async () => ({ stops: false })),
    onBackgroundWorkEnded: stubs.onBackgroundWorkEnded ?? (() => () => {}),
    run: async (provider: string, command: string, options: Record<string, unknown>) => {
      if (behaviour === 'throw') {
        throw new Error('provider exploded');
      }
      runs.push({ provider, command, options });
    },
    abort: async (_provider: string, sessionId: string) => {
      aborts.push(sessionId);
      return true;
    },
  } as never;
}

/** A chat socket that records what it is sent, standing in for an open browser tab. */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  /** The scheduled-message announcements among everything this socket received. */
  announcements(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === 'scheduled_messages_changed');
  }
}

function openTab(): FakeConnection {
  const connection = new FakeConnection();
  connectedClients.add(connection as never);
  return connection;
}

test('a message due in the past is sent on the next pass, not skipped', async () => {
  await withIsolatedDatabase(async (userId) => {
    // The server was down when this came due.
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const sent = await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(sent, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'run the nightly checks');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a queued message is sent by the server without a browser connection', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{
        content: 'continue on the VPS',
        options: { model: 'claude-opus-5' },
        attachments: [{ path: '/tmp/upload.png' }],
      }],
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'continue on the VPS');
    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.deepEqual(runs[0].options.attachments, []);
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

test('a queued message stays pending while its session is busy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'send after this run' }],
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(contents(userId), ['send after this run']);
  });
});

test('a queued message goes as soon as the reply it waited on ends, not on the next poll', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'and then this' }],
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    initializeScheduledMessageDispatcher(createRuntime(runs));
    try {
      // The first pass finds the session busy.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(runs.length, 0);

      chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
      // Well inside the 30s poll interval.
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      assert.equal(runs.length, 1);
      assert.equal(runs[0].command, 'and then this');
      assert.deepEqual(sessionDraftsDb.getDrafts(userId)[0]?.queuedMessages ?? [], []);
    } finally {
      closeScheduledMessageDispatcher();
    }
  });
});

test('with combining off, queued messages go one per turn, oldest first', async () => {
  await withIsolatedDatabase(async (userId) => {
    setCombineQueuedMessages(userId, false);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: 'still typing',
      queuedMessages: [{ content: 'first' }, { content: 'second' }, { content: 'third' }],
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['first']);
    assert.deepEqual(contents(userId), ['second', 'third']);

    // The turn the first one started is still running: the rest wait for it.
    const running = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    assert.equal(await dispatchQueuedMessages(runtime), 0);

    running!.writer.sendComplete({ exitCode: 0 });
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['first', 'second', 'third']);

    // The draft text was never part of the queue and is kept.
    assert.deepEqual(sessionDraftsDb.getDrafts(userId).map((draft) => [draft.text, draft.queuedMessages.length]), [['still typing', 0]]);
  });
});

test('a queue edited after it was listed is not claimed from the stale copy', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessages: [{ content: 'old' }] });
    const [stale] = sessionDraftsDb.listQueuedMessages();
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessages: [{ content: 'edited' }] });

    assert.equal(sessionDraftsDb.claimQueuedMessages(stale!, 1), null);
    assert.deepEqual(contents(userId), ['edited']);
  });
});

test('turns put back after a lost race go ahead of what was queued meanwhile, in order', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'a' }, { content: 'b' }, { content: 'c' }],
    });
    const [candidate] = sessionDraftsDb.listQueuedMessages();
    const claimed = sessionDraftsDb.claimQueuedMessages(candidate!, 2);
    assert.deepEqual(claimed!.map((message) => (message as { content: string }).content), ['a', 'b']);
    assert.deepEqual(contents(userId), ['c']);
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { id: 'd', content: 'd' }, 50);

    sessionDraftsDb.restoreQueuedMessages(userId, SESSION_ID, claimed!);
    assert.deepEqual(contents(userId), ['a', 'b', 'c', 'd']);
  });
});

test('a combined turn that loses the race to another run is put back whole, ahead of later messages', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'a' }, { content: 'b' }, { content: '/compact' }],
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    // A run that starts between the dispatcher's busy check and its own
    // reservation: it appears while the queue is claimed, and a message is
    // queued behind meanwhile.
    const originalClaim = sessionDraftsDb.claimQueuedMessages;
    sessionDraftsDb.claimQueuedMessages = (candidate, count) => {
      const taken = originalClaim(candidate, count);
      chatRunRegistry.startRun({
        appSessionId: SESSION_ID,
        provider: 'claude',
        providerSessionId: null,
        connection: null,
        userId,
      });
      sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { id: 'late', content: 'late' }, 50);
      return taken;
    };
    try {
      assert.equal(await dispatchQueuedMessages(runtime), 1);
    } finally {
      sessionDraftsDb.claimQueuedMessages = originalClaim;
    }

    assert.equal(runs.length, 0);
    assert.deepEqual(contents(userId), ['a', 'b', '/compact', 'late']);
  });
});

test('a queued message does not wait for background work its session\'s last turn left running', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'send while the background job runs' }],
    });
    // Turn A ended, so its run is completed, but it backgrounded a command
    // that is still running under A's CLI process. That process takes the
    // next turn itself, so the command keeps running.
    const runA = chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });
    runA!.writer.sendComplete({ exitCode: 0 });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], (sessionId) => sessionId === SESSION_ID);

    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs[0]?.command, 'send while the background job runs');
    assert.equal(sessionDraftsDb.getDrafts(userId).length, 0);
  });
});

/** Ends a turn whose session keeps background work going under its held process. */
function completeTurnLeavingBackgroundWork(userId: number): void {
  const run = chatRunRegistry.startRun({
    appSessionId: SESSION_ID,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId,
  });
  run!.writer.sendComplete({ exitCode: 0 });
}

test('a queued message that would stop background work waits for it, and holds back the queue behind it', async () => {
  await withIsolatedDatabase(async (userId) => {
    // One per turn, so the head is a turn of its own.
    setCombineQueuedMessages(userId, false);
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [
        { content: 'think harder about it', options: { effort: 'max' } },
        { content: 'the held process could take this one' },
      ],
    });
    completeTurnLeavingBackgroundWork(userId);

    // The held process was started at another effort, so it could not take
    // the head turn: a new process would, stopping the work.
    let workRunning = true;
    const asked: Array<Record<string, unknown>> = [];
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], () => workRunning, {
      wouldStopBackgroundWork: async (_provider, _sessionId, options) => {
        asked.push(options);
        return workRunning && options.effort === 'max' ? { stops: true, reason: 'effort' } : { stops: false };
      },
    });

    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(contents(userId), ['think harder about it', 'the held process could take this one']);
    // Asked about the head only, with the options the send would run with.
    assert.equal(asked.length, 1);
    assert.equal(asked[0].effort, 'max');
    assert.equal(asked[0].sessionId, SESSION_ID);
    assert.equal(asked[0].cwd, sessionsDb.getSessionById(SESSION_ID)?.project_path);

    // The work is over: nothing is left to stop.
    workRunning = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['think harder about it']);
    assert.deepEqual(contents(userId), ['the held process could take this one']);
  });
});

test('a waiting queued message goes once the held process could take it', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'check on the job' }],
    });
    completeTurnLeavingBackgroundWork(userId);

    let wouldStop = true;
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], () => true, {
      wouldStopBackgroundWork: async () => (wouldStop ? { stops: true, reason: 'unavailable' } : { stops: false }),
    });

    assert.equal(await dispatchQueuedMessages(runtime), 0);
    wouldStop = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.equal(runs[0]?.command, 'check on the job');
  });
});

test('a queued message that waited for background work goes when the held process ends, not on the next poll', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'now in a fresh process', options: { effort: 'low' } }],
    });
    completeTurnLeavingBackgroundWork(userId);

    let workRunning = true;
    const ended = new Set<(sessionId: string) => void>();
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], () => workRunning, {
      wouldStopBackgroundWork: async () => (workRunning ? { stops: true, reason: 'effort' } : { stops: false }),
      onBackgroundWorkEnded: (listener) => {
        ended.add(listener);
        return () => { ended.delete(listener); };
      },
    });

    initializeScheduledMessageDispatcher(runtime);
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(runs.length, 0, 'it waits while the work runs');

      // No run completes when held work ends; the runtime says so itself.
      workRunning = false;
      for (const listener of ended) {
        listener(SESSION_ID);
      }
      // Well inside the 30s poll interval.
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      assert.equal(runs.length, 1);
      assert.equal(runs[0].command, 'now in a fresh process');
    } finally {
      closeScheduledMessageDispatcher();
    }
    assert.equal(ended.size, 0, 'closing the dispatcher unsubscribes');
  });
});

test('combining is on by default: queued follow-ups go as one turn', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [
        // Relative paths are anchored in the upload store, so they survive the
        // send's attachment check.
        { id: 'q1', content: 'A', options: { model: 'first-model' }, attachments: [{ path: 'one.png' }] },
        { id: 'q2', content: '', options: { model: 'second-model' }, attachments: [{ path: 'two.png' }] },
        { id: 'q3', content: 'B', attachments: [] },
        { id: 'q4', content: 'C', options: { model: 'last-model', effort: 'high' }, attachments: [{ path: 'three.txt' }] },
      ],
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.equal(runs.length, 1);
    // The attachments-only message adds its file but no blank line.
    assert.equal(runs[0].command, 'A\n\nB\n\nC');
    assert.deepEqual(
      (runs[0].options.attachments as Array<{ path: string }>).map((attachment) => path.basename(attachment.path)),
      ['one.png', 'two.png', 'three.txt'],
    );
    // The most recent composer settings win.
    assert.equal(runs[0].options.model, 'last-model');
    assert.equal(runs[0].options.effort, 'high');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('combining turned off as the string \'false\' is honoured', async () => {
  await withIsolatedDatabase(async (userId) => {
    setCombineQueuedMessages(userId, 'false');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'one' }, { content: 'two' }],
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map((run) => run.command), ['one']);
    assert.deepEqual(contents(userId), ['two']);
  });
});

test('combining turned on explicitly merges, as the default does', async () => {
  await withIsolatedDatabase(async (userId) => {
    setCombineQueuedMessages(userId, 'true');
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [{ content: 'one' }, { content: 'two' }],
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);
    assert.deepEqual(runs.map((run) => run.command), ['one\n\ntwo']);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('slash commands split the combined queue into turns, in order', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [
        { content: 'A' },
        { content: 'B' },
        { content: '  /compact keep the plan' },
        { content: 'C' },
        { content: 'D' },
        { content: '/clear' },
        { content: '/cost' },
      ],
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    const passes: string[][] = [];
    for (let pass = 0; pass < 6; pass += 1) {
      assert.equal(await dispatchQueuedMessages(runtime), pass < 5 ? 1 : 0);
      passes.push(contents(userId));
    }

    assert.deepEqual(runs.map((run) => run.command), ['A\n\nB', '  /compact keep the plan', 'C\n\nD', '/clear', '/cost']);
    assert.deepEqual(passes, [
      ['  /compact keep the plan', 'C', 'D', '/clear', '/cost'],
      ['C', 'D', '/clear', '/cost'],
      ['/clear', '/cost'],
      ['/cost'],
      [],
      [],
    ]);
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('a combined turn that would stop background work is held whole, judged by its last message\'s options', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, {
      text: '',
      queuedMessages: [
        { content: 'first', options: { effort: 'low' } },
        { content: 'second', options: { effort: 'max' } },
      ],
    });
    completeTurnLeavingBackgroundWork(userId);

    let workRunning = true;
    const asked: Array<Record<string, unknown>> = [];
    const runs: RunCall[] = [];
    const runtime = createRuntime(runs, 'ok', [], () => workRunning, {
      wouldStopBackgroundWork: async (_provider, _sessionId, options) => {
        asked.push(options);
        return workRunning && options.effort === 'max' ? { stops: true, reason: 'effort' } : { stops: false };
      },
    });

    assert.equal(await dispatchQueuedMessages(runtime), 0);
    assert.equal(runs.length, 0);
    assert.deepEqual(contents(userId), ['first', 'second']);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].effort, 'max');

    workRunning = false;
    assert.equal(await dispatchQueuedMessages(runtime), 1);
    assert.deepEqual(runs.map((run) => run.command), ['first\n\nsecond']);
    assert.equal(runs[0].options.effort, 'max');
    assert.deepEqual(sessionDraftsDb.getDrafts(userId), []);
  });
});

test('planQueuedTurn joins contents with a blank line, attachments in order, last options', () => {
  const plan = planQueuedTurn([
    { content: 'A', options: { model: 'm1' }, attachments: [{ name: '1' }] },
    { content: 'B', attachments: [{ name: '2' }, { name: '3' }] },
    { content: 'C', options: { model: 'm3' }, attachments: [] },
  ], true);
  assert.deepEqual(plan, {
    count: 3,
    turn: {
      content: 'A\n\nB\n\nC',
      options: { model: 'm3' },
      attachments: [{ name: '1' }, { name: '2' }, { name: '3' }],
    },
  });
});

test('planQueuedTurn adds no blank lines for an attachments-only message', () => {
  assert.equal(planQueuedTurn([
    { content: '', attachments: [{ name: 'lead' }] },
    { content: 'A' },
    { content: '   ', attachments: [{ name: 'middle' }] },
    { content: 'B' },
    { content: '', attachments: [{ name: 'tail' }] },
  ], true).turn?.content, 'A\n\nB');

  const onlyAttachments = planQueuedTurn([
    { content: '', attachments: [{ name: '1' }] },
    { content: '', attachments: [{ name: '2' }] },
  ], true);
  assert.deepEqual(onlyAttachments.turn, { content: '', attachments: [{ name: '1' }, { name: '2' }] });
});

test('planQueuedTurn sends a leading command alone and stops a run before a command', () => {
  const queue = [{ content: '/compact' }, { content: 'A' }];
  assert.deepEqual(planQueuedTurn(queue, true), { count: 1, turn: { content: '/compact', attachments: [] } });
  assert.equal(planQueuedTurn([{ content: 'A' }, { content: 'B' }, { content: ' /cost' }, { content: 'C' }], true).count, 2);
  // The last message before the command supplies the options, not the command.
  assert.equal(
    planQueuedTurn([{ content: 'A', options: { model: 'a' } }, { content: '/cost', options: { model: 'cmd' } }], true).turn?.options?.model,
    'a',
  );
});

test('planQueuedTurn with combining off takes the oldest message alone, unchanged', () => {
  assert.deepEqual(
    planQueuedTurn([{ content: 'A', options: { model: 'm' }, attachments: [] }, { content: 'B' }], false),
    { count: 1, turn: { content: 'A', options: { model: 'm' }, attachments: [] } },
  );
  // An unreadable message is still taken, to be dropped.
  assert.deepEqual(planQueuedTurn([{ content: '   ' }, { content: 'B' }], false), { count: 1, turn: null });
  assert.deepEqual(planQueuedTurn([], false), { count: 0, turn: null });
  assert.deepEqual(planQueuedTurn([], true), { count: 0, turn: null });
});

test('planQueuedTurn takes unreadable messages along without adding to the turn', () => {
  assert.deepEqual(planQueuedTurn([{ content: '' }, 'junk', { content: 'A' }], true), {
    count: 3,
    turn: { content: 'A', attachments: [] },
  });
  assert.deepEqual(planQueuedTurn([{ content: '' }, null], true), { count: 2, turn: null });
});

test('a draft-text save after the queued message was sent does not send it again', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { id: 'q1', content: 'send me once', attachments: [] }, 50);
    const runs: RunCall[] = [];
    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 1);

    // The composer keeps saving its text while the user types the next
    // follow-up; its copy of the queue still holds the message just sent.
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: 'typing the next one' });

    assert.equal(await dispatchQueuedMessages(createRuntime(runs)), 0);
    assert.deepEqual(runs.map((run) => run.command), ['send me once']);
  });
});

test('a due message interrupts a run in progress instead of failing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'the schedule wins',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    chatRunRegistry.startRun({
      appSessionId: SESSION_ID,
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId,
    });

    const runs: RunCall[] = [];
    const aborts: string[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs, 'ok', aborts)), 1);

    assert.deepEqual(aborts, [SESSION_ID]);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'the schedule wins');
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'sent');
  });
});

test('a message that is not due yet is left alone', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'later',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('a due message is claimed once, so overlapping passes cannot double-send it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'only once',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    const runtime = createRuntime(runs);
    await Promise.all([
      dispatchDueScheduledMessages(runtime),
      dispatchDueScheduledMessages(runtime),
    ]);

    assert.equal(runs.length, 1);
  });
});

test('the composer settings it was scheduled with travel with it', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'with options',
      options: { model: 'claude-opus-5', permissionMode: 'plan' },
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    const runs: RunCall[] = [];
    await dispatchDueScheduledMessages(createRuntime(runs));

    assert.equal(runs[0].options.model, 'claude-opus-5');
    assert.equal(runs[0].options.permissionMode, 'plan');
  });
});

test('a provider failure is recorded on the message instead of vanishing', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    const row = scheduledMessagesDb.listForSession(userId, SESSION_ID)[0];
    assert.equal(row.status, 'failed');
    assert.match(row.failure_reason ?? '', /provider exploded/);
  });
});

test('a cancelled message never fires', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'never mind',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    scheduledMessagesService.cancel(userId, scheduled.id);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 0);
    assert.equal(runs.length, 0);
  });
});

test('a failed message can be dismissed, and stays dismissed', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([], 'throw'));
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');

    scheduledMessagesService.cancel(userId, scheduled.id);

    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'cancelled');
  });
});

test('cancelling something that already fired is refused', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'gone',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    await dispatchDueScheduledMessages(createRuntime([]));

    assert.throws(
      () => scheduledMessagesService.cancel(userId, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
  });
});

test('one user cannot cancel another user\'s scheduled message', async () => {
  await withIsolatedDatabase(async (userId) => {
    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'mine',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });

    assert.throws(
      () => scheduledMessagesService.cancel(userId + 1, scheduled.id),
      (error: Error & { code?: string }) => error.code === 'SCHEDULED_MESSAGE_NOT_PENDING',
    );
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'pending');
  });
});

test('scheduling validates its input', async () => {
  await withIsolatedDatabase(async (userId) => {
    const base = { userId, sessionId: SESSION_ID, scheduledFor: new Date(Date.now() + 1000).toISOString() };

    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: '   ' }),
      (error: Error & { code?: string }) => error.code === 'CONTENT_REQUIRED',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, content: 'hi', scheduledFor: 'not a date' }),
      (error: Error & { code?: string }) => error.code === 'INVALID_SCHEDULE_TIME',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({
        ...base,
        content: 'hi',
        scheduledFor: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString(),
      }),
      (error: Error & { code?: string }) => error.code === 'SCHEDULE_TOO_FAR_AHEAD',
    );
    assert.throws(
      () => scheduledMessagesService.schedule({ ...base, sessionId: 'nope', content: 'hi' }),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});

// The composer banner is read over REST, so these announcements are the only
// way an open tab learns that its list changed without it doing anything
// (#1546): the banner of a message the timer had already sent stayed up until
// a reload.

test('a due message is announced to open tabs as it is claimed, before its turn runs', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'run the nightly checks',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const tab = openTab();

    let announcedBeforeTheTurn: Array<Record<string, unknown>> = [];
    const runtime = {
      hasRuntime: () => true,
      hasBackgroundWork: () => false,
      run: async () => {
        announcedBeforeTheTurn = tab.announcements();
      },
      abort: async () => true,
    } as never;
    assert.equal(await dispatchDueScheduledMessages(runtime), 1);

    // The banner comes down when the turn starts, not after it finishes,
    // which for a long turn can be many minutes later.
    assert.equal(announcedBeforeTheTurn.length, 1);
    assert.equal(announcedBeforeTheTurn[0].sessionId, SESSION_ID);
    assert.equal(tab.announcements().length, 1);
  });
});

test('a pass announces each session it claimed from once, however many of its messages were due', async () => {
  await withIsolatedDatabase(async (userId) => {
    const otherSessionId = 'other-scheduled-session';
    sessionsDb.createAppSession(otherSessionId, 'claude', tmpdir(), 'Other scheduled session');
    for (const [sessionId, content] of [
      [SESSION_ID, 'first for this session'],
      [SESSION_ID, 'second for this session'],
      [otherSessionId, 'only one for the other session'],
    ]) {
      scheduledMessagesService.schedule({
        userId,
        sessionId,
        content,
        scheduledFor: new Date(Date.now() - 1_000).toISOString(),
      });
    }
    const tab = openTab();

    assert.equal(await dispatchDueScheduledMessages(createRuntime([])), 3);

    // One read per session is enough: a single GET returns all of its rows.
    assert.deepEqual(tab.announcements().map((frame) => frame.sessionId).sort(), [otherSessionId, SESSION_ID]);
  });
});

test('a message that fails to send is announced again once the reason is recorded', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'will fail',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const tab = openTab();

    await dispatchDueScheduledMessages(createRuntime([], 'throw'));

    // Claimed (the banner comes down), then failed (it comes back as the
    // failure notice).
    assert.deepEqual(tab.announcements().map((frame) => frame.sessionId), [SESSION_ID, SESSION_ID]);
    assert.equal(scheduledMessagesDb.listForSession(userId, SESSION_ID)[0].status, 'failed');
  });
});

test('scheduling and cancelling are announced, so other tabs and devices follow', async () => {
  await withIsolatedDatabase(async (userId) => {
    const tab = openTab();

    const scheduled = scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'from another tab',
      scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
    });
    assert.equal(tab.announcements().length, 1);

    scheduledMessagesService.cancel(userId, scheduled.id);
    assert.equal(tab.announcements().length, 2);

    // A refused cancel changed nothing, so there is nothing to announce.
    assert.throws(() => scheduledMessagesService.cancel(userId, scheduled.id));
    assert.equal(tab.announcements().length, 2);

    // The frame names the session and nothing else: each tab reads the list
    // again through its own authenticated request.
    for (const frame of tab.announcements()) {
      assert.deepEqual(Object.keys(frame).sort(), ['kind', 'sessionId', 'timestamp']);
      assert.equal(frame.sessionId, SESSION_ID);
    }
  });
});

test('a socket that cannot be written to does not stop a claimed message from being sent', async () => {
  await withIsolatedDatabase(async (userId) => {
    scheduledMessagesService.schedule({
      userId,
      sessionId: SESSION_ID,
      content: 'still goes',
      scheduledFor: new Date(Date.now() - 1_000).toISOString(),
    });
    const closedTab = openTab();
    closedTab.readyState = 3; // CLOSED
    connectedClients.add({
      readyState: 1,
      send: () => {
        throw new Error('socket went away mid-send');
      },
    } as never);

    const runs: RunCall[] = [];
    assert.equal(await dispatchDueScheduledMessages(createRuntime(runs)), 1);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].command, 'still goes');
    assert.equal(closedTab.frames.length, 0);
  });
});
