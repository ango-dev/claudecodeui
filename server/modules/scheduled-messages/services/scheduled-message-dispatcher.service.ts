import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { announceScheduledMessagesChanged } from '@/modules/scheduled-messages/services/scheduled-messages.service.js';
import { isQueuedMessageCombiningEnabled } from '@/modules/settings/index.js';
import { chatRunRegistry, checkSendStopsBackgroundWork, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { QueuedChatMessage } from '@/shared/types.js';
import { readQueuedChatMessage } from '@/shared/utils.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;
/**
 * How long after a run ends its session's next queued message is sent. The run's
 * CLI process is still exiting when its `complete` arrives; a moment's grace
 * lets it finish before the next turn resumes the same conversation.
 */
const AFTER_RUN_DELAY_MS = 1_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeRunCompleted: (() => void) | null = null;
let unsubscribeBackgroundWorkEnded: (() => void) | null = null;
/**
 * Passes scheduled for a moment after a run or held work ends. Cleared with the
 * poll on close: a pass that fired after the dispatcher was closed would still
 * send with the runtime it was started with.
 */
const pendingAfterRunPolls = new Set<ReturnType<typeof setTimeout>>();
/**
 * Sessions whose scheduled sends are still going, from this pass or an
 * earlier one: from the claim until the last turn of the session's due backlog
 * has ended (see sendUntilTurnEnds). Their next due rows stay pending (and keep
 * their banner) until then, so they neither overtake nor interrupt those
 * turns, and their queued turns wait too.
 */
const sessionsSending = new Set<string>();
/**
 * Per session, the queued turn a pass is starting: its busy check, claim and
 * run reservation. Passes overlap, so a later pass's attempt for the session
 * waits for it rather than racing it; the turn itself is not waited for.
 */
const queuedTurnStarts = new Map<string, Promise<void>>();

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The options a queued turn is sent with — and previewed with, so both agree. */
function queuedTurnOptions(message: QueuedChatMessage): Record<string, unknown> {
  return { ...message.options, attachments: message.attachments };
}

/**
 * What one pass sends from a session's queue: how many of its oldest entries
 * the turn takes, and the turn they make. `turn` is null when none of those
 * entries is a readable message; they are claimed only to be dropped.
 */
type QueuedTurnPlan = {
  count: number;
  turn: QueuedChatMessage | null;
};

/** A slash command is handed to the provider as the whole turn, so it is never merged with other text. */
function isSlashCommand(message: QueuedChatMessage): boolean {
  return message.content.trimStart().startsWith('/');
}

/**
 * Plans the next turn from a session's queue (`queue`, oldest first).
 *
 * Without `combine`, the turn is the oldest entry alone. With it, the turn is
 * the oldest entry plus those after it, up to (not including) the first slash
 * command: their contents joined by a blank line (blank contents, such as an
 * attachments-only entry's, are left out rather than adding empty lines),
 * their attachments in order, and the send options of the last of them — the
 * most recent composer settings. A command at the front goes alone, since a
 * command cannot share its turn with other text. Unreadable entries are taken
 * along wherever they fall and contribute nothing.
 *
 * Exported for the scheduled-messages tests, which check the planning
 * directly.
 */
export function planQueuedTurn(queue: unknown[], combine: boolean): QueuedTurnPlan {
  if (queue.length === 0) {
    return { count: 0, turn: null };
  }
  if (!combine) {
    return { count: 1, turn: readQueuedChatMessage(queue[0]) };
  }

  const included: QueuedChatMessage[] = [];
  let count = 0;
  for (const entry of queue) {
    const message = readQueuedChatMessage(entry);
    if (message && isSlashCommand(message)) {
      if (included.length === 0) {
        // A command at the front is its own turn.
        included.push(message);
        count += 1;
      }
      break;
    }
    count += 1;
    if (message) {
      included.push(message);
    }
  }

  if (included.length === 0) {
    return { count, turn: null };
  }
  if (included.length === 1) {
    return { count, turn: included[0] };
  }
  const options = included[included.length - 1].options;
  return {
    count,
    turn: {
      content: included
        .map((message) => message.content)
        .filter((content) => content.trim())
        .join('\n\n'),
      ...(options ? { options } : {}),
      attachments: included.flatMap((message) => message.attachments),
    },
  };
}

async function sendClaimedQueuedTurn(
  candidate: QueuedSessionMessageRecord,
  claimed: unknown[],
  turn: QueuedChatMessage | null,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  if (!turn) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: turn.content,
      options: queuedTurnOptions(turn),
      // Every entry the turn took, so the cards of all of them drop as it starts.
      queuedMessageIds: claimed.flatMap((entry) => {
        const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null;
        return typeof id === 'string' && id ? [id] : [];
      }),
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put every entry the turn took back at the front, in
  // order, so the next pass tries them again before anything queued behind.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessages(candidate.userId, candidate.sessionId, claimed);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether the session's next queued turn (`turn`, as planned from the front of
 * its queue) has to keep waiting: while a turn is running, and while sending it would stop the
 * session's background work.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) keeps its CLI process open, and the next turn is handed
 * to that same process, so the work keeps running and a queued turn need not
 * wait for it. That process cannot take every turn, though — not one with
 * another reasoning effort or working directory, say — and such a turn would
 * start a new process, which stops the work. It waits until the work is over
 * instead (announced by onBackgroundWorkEnded, at worst the next poll), or
 * until it is edited into one the process can take.
 *
 * Only the next turn is asked about, with the options it would be sent with
 * (for a combined turn, its last entry's): the queue goes in order, so nothing
 * behind it may overtake it, and holding it holds back every entry it takes.
 *
 * It also waits while a scheduled send for the session is going (see
 * sessionsSending): that send can still be starting (aborting the run it
 * interrupts), or between the turns of its due backlog, and its next row would
 * interrupt a queued turn started in that gap.
 */
async function isSessionBusy(
  sessionId: string,
  turn: QueuedChatMessage | null,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  if (chatRunRegistry.isProcessing(sessionId) || sessionsSending.has(sessionId)) {
    return true;
  }
  // Malformed entries are claimed only to be dropped; they send nothing.
  if (!turn || !runtime.hasBackgroundWork(sessionId)) {
    return false;
  }
  try {
    const impact = await checkSendStopsBackgroundWork(
      { sessionId, options: queuedTurnOptions(turn) },
      { runtime },
    );
    return impact?.stops ?? false;
  } catch (error) {
    // Unsure means wait: the next pass asks again, and the work ending
    // settles it.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledMessages] Could not check a queued turn against background work', { sessionId, error: message });
    return true;
  }
}

/**
 * Sends the next queued turn of every session that is currently idle: its
 * oldest message, or — with the owner's "Combine queued messages" on — its
 * queued messages merged into one turn (see planQueuedTurn). One turn per
 * session per pass: the turn it starts makes the session busy, and the next
 * goes when that turn ends. Returns the number of turns claimed.
 *
 * Sessions go side by side. A session's attempt waits for any attempt an
 * overlapping pass is still starting for it (see queuedTurnStarts), then
 * plans from the copy of the queue this pass listed: if the earlier attempt
 * claimed from it, the claim below finds the queue changed and leaves it to
 * the pass that turn's end triggers. Resolves once the turns it started have
 * settled, which for a turn handed to a process held open for background work
 * can be long after the turn itself ended; nothing waits on that.
 */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  const startQueuedTurn = async (
    candidate: QueuedSessionMessageRecord,
    previousStart: Promise<void> | undefined,
  ): Promise<{ sending: Promise<void> } | null> => {
    await previousStart;
    const plan = planQueuedTurn(
      candidate.queuedMessages,
      isQueuedMessageCombiningEnabled(candidate.userId),
    );
    if (plan.count === 0 || await isSessionBusy(candidate.sessionId, plan.turn, runtime)) {
      return null;
    }
    // Claimed against the copy the plan was made from, so a queue edited
    // meanwhile is left for the next pass to plan afresh.
    const taken = sessionDraftsDb.claimQueuedMessages(candidate, plan.count);
    if (taken === null) {
      return null;
    }
    claimed += 1;
    // runDetachedChatTurn reserves the session's run before its first await
    // (a queued turn never interrupts), so once this call returns the run is
    // registered and a later attempt's busy check sees it. Wrapped, so this
    // start resolves now rather than adopting the send, which lasts the turn.
    return { sending: sendClaimedQueuedTurn(candidate, taken, plan.turn, runtime) };
  };

  await Promise.all(candidates.map(async (candidate) => {
    const { sessionId } = candidate;
    const attempt = startQueuedTurn(candidate, queuedTurnStarts.get(sessionId));
    const started = attempt.then(() => undefined, () => undefined);
    queuedTurnStarts.set(sessionId, started);
    let start: { sending: Promise<void> } | null;
    try {
      start = await attempt;
    } finally {
      if (queuedTurnStarts.get(sessionId) === started) {
        queuedTurnStarts.delete(sessionId);
      }
    }
    await start?.sending;
  }));

  return claimed;
}

/** Records why a claimed message did not go, and shows it on its session's banner. */
function recordFailure(row: ScheduledMessageRow, reason: string): void {
  scheduledMessagesDb.markFailed(row.id, reason);
  announceScheduledMessagesChanged(row.session_id);
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options: readOptions(row.options),
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: true,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (!result.started || result.error) {
      recordFailure(row, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(row, message);
  }
}

/**
 * Sends every message whose time has come and returns how many it handled.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now, sessionsSending);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sessions side by side, since a turn can stay open a long time (see
  // runDispatchPass). A session's rows that were due at `now` go one after
  // another in this pass, each claimed only when the earlier turn ends, so
  // none is recorded as sent while it still waits and no poll gap opens
  // between them. A turn the user starts meanwhile is still interrupted, as
  // any scheduled send interrupts the active run.
  let sent = 0;
  await Promise.all(due.map(async (first) => {
    const sessionId = first.session_id;
    sessionsSending.add(sessionId);
    try {
      let row: ScheduledMessageRow | null = first;
      while (row) {
        const claimedRow: ScheduledMessageRow = row;
        await sendUntilTurnEnds(sessionId, () => sendClaimedMessage(claimedRow, runtime));
        sent += 1;
        row = scheduledMessagesDb.claimNextDue(sessionId, now);
        if (row) announceScheduledMessagesChanged(sessionId);
      }
    } catch (error) {
      logPassFailure(error);
    } finally {
      sessionsSending.delete(sessionId);
    }
  }));

  return sent;
}

/**
 * Starts a send (`send`, which runs one turn for `sessionId`) and resolves once
 * that turn is over: when the run it started completes in the registry, or
 * when the send settles, whichever comes first. The send keeps going after
 * that and still records its own outcome.
 *
 * A Claude turn that leaves background work running completes at its result,
 * but its send stays pending while the CLI process is held open for that work
 * (up to the runtime's idle ceiling). The session takes its next turn in the
 * meantime — the held process takes it when it can — so a due backlog or a
 * queued turn behind it must not wait for the hold.
 */
async function sendUntilTurnEnds(sessionId: string, send: () => Promise<void>): Promise<void> {
  // The run a scheduled send interrupts completes first; only a run registered
  // after it, which is this send's own, ends this send's turn.
  const runBefore = chatRunRegistry.getRun(sessionId);
  let unsubscribe = () => {};
  const turnEnded = new Promise<void>((resolve) => {
    unsubscribe = chatRunRegistry.onRunCompleted((completedSessionId) => {
      if (completedSessionId === sessionId && chatRunRegistry.getRun(sessionId) !== runBefore) {
        // A tick later, so a send that settles with its turn (most do) wins and
        // has recorded a failure before the session's next row is claimed.
        setImmediate(resolve);
      }
    });
  });
  try {
    await Promise.race([send(), turnEnded]);
  } finally {
    unsubscribe();
  }
}

function logPassFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
}

/**
 * One poll's work. A send waits for its whole turn, a turn the user leaves
 * waiting on a tool approval can stay open indefinitely, and a Claude send
 * whose turn leaves background work running (a Monitor, say) stays pending
 * until that work reports back, so passes must not wait on each other: claims
 * are transactional (a queued claim is a compare-and-set on the session's
 * queue), a session's sends chain across passes, and a queued turn skips a
 * session that is still busy.
 *
 * Exported so a test can drive overlapping passes.
 */
export function runDispatchPass(runtime: ProviderRuntimeGateway): Promise<void> {
  return Promise.all([
    // First, so a due send that starts a run at once has registered it before
    // the queued pass checks whether that session is busy.
    dispatchDueScheduledMessages(runtime).catch(logPassFailure),
    dispatchQueuedMessages(runtime).catch(logPassFailure),
  ]).then(() => undefined);
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // Not gated on an earlier pass: one can stay pending for as long as a turn
    // it sent is held open (see runDispatchPass).
    void runDispatchPass(runtime);
  };
  const pollAfterDelay = () => {
    const timer = setTimeout(() => {
      pendingAfterRunPolls.delete(timer);
      poll();
    }, AFTER_RUN_DELAY_MS);
    timer.unref?.();
    pendingAfterRunPolls.add(timer);
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // A message queued behind a reply goes when that reply ends, not up to a
  // poll interval later; the next one in the queue goes when its own turn
  // ends. The poll still covers a missed or failed pass.
  unsubscribeRunCompleted = chatRunRegistry.onRunCompleted(() => {
    pollAfterDelay();
  });
  // A turn that waited for background work rather than stop it goes when the
  // process holding that work ends; no run completes then, since that run's
  // `complete` went out when its turn did.
  unsubscribeBackgroundWorkEnded = runtime.onBackgroundWorkEnded(() => {
    pollAfterDelay();
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const timer of pendingAfterRunPolls) {
    clearTimeout(timer);
  }
  pendingAfterRunPolls.clear();
  unsubscribeRunCompleted?.();
  unsubscribeRunCompleted = null;
  unsubscribeBackgroundWorkEnded?.();
  unsubscribeBackgroundWorkEnded = null;
}
