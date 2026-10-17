import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, scheduledMessagesDb, sessionDraftsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  closeScheduledMessageDispatcher,
  dispatchDueScheduledMessages,
  dispatchQueuedMessages,
  initializeScheduledMessageDispatcher,
} from '@/modules/scheduled-messages/services/scheduled-message-dispatcher.service.js';
import { scheduledMessagesService } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
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

test('queued messages go one per turn, oldest first', async () => {
  await withIsolatedDatabase(async (userId) => {
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

    assert.equal(sessionDraftsDb.claimNextQueuedMessage(stale!), null);
    assert.deepEqual(contents(userId), ['edited']);
  });
});

test('a turn put back after a lost race goes ahead of what was queued meanwhile', async () => {
  await withIsolatedDatabase(async (userId) => {
    sessionDraftsDb.saveDraft(userId, SESSION_ID, { text: '', queuedMessages: [{ content: 'a' }, { content: 'b' }] });
    const [candidate] = sessionDraftsDb.listQueuedMessages();
    const claimed = sessionDraftsDb.claimNextQueuedMessage(candidate!);
    assert.equal((claimed as { content: string }).content, 'a');
    sessionDraftsDb.appendQueuedMessage(userId, SESSION_ID, { id: 'c', content: 'c' }, 50);

    sessionDraftsDb.restoreQueuedMessage(userId, SESSION_ID, claimed);
    assert.deepEqual(contents(userId), ['a', 'b', 'c']);
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
