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
let dispatchInFlight = false;
// A pass was asked for while one ran; it runs again when that one ends.
let dispatchRequested = false;
let unsubscribeRunCompleted: (() => void) | null = null;
let unsubscribeBackgroundWorkEnded: (() => void) | null = null;

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
 */
async function isSessionBusy(
  sessionId: string,
  turn: QueuedChatMessage | null,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  if (chatRunRegistry.isProcessing(sessionId)) {
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
 */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    const plan = planQueuedTurn(
      candidate.queuedMessages,
      isQueuedMessageCombiningEnabled(candidate.userId),
    );
    if (plan.count === 0 || await isSessionBusy(candidate.sessionId, plan.turn, runtime)) {
      return;
    }
    // Claimed against the copy the plan was made from, so a queue edited
    // meanwhile is left for the next pass to plan afresh.
    const taken = sessionDraftsDb.claimQueuedMessages(candidate, plan.count);
    if (taken === null) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedTurn(candidate, taken, plan.turn, runtime);
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
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // The claim already recorded them as sent, so their banners come down now,
  // as the turns start, rather than once the last turn has finished.
  for (const sessionId of new Set(due.map((row) => row.session_id))) {
    announceScheduledMessagesChanged(sessionId);
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
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
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not. One asked for
    // meanwhile (a run just ended) runs once this one is done.
    if (dispatchInFlight) {
      dispatchRequested = true;
      return;
    }
    dispatchInFlight = true;
    dispatchRequested = false;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
        if (dispatchRequested) {
          poll();
        }
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // A message queued behind a reply goes when that reply ends, not up to a
  // poll interval later; the next one in the queue goes when its own turn
  // ends. The poll still covers a missed or failed pass.
  unsubscribeRunCompleted = chatRunRegistry.onRunCompleted(() => {
    setTimeout(poll, AFTER_RUN_DELAY_MS).unref?.();
  });
  // A turn that waited for background work rather than stop it goes when the
  // process holding that work ends; no run completes then, since that run's
  // `complete` went out when its turn did.
  unsubscribeBackgroundWorkEnded = runtime.onBackgroundWorkEnded(() => {
    setTimeout(poll, AFTER_RUN_DELAY_MS).unref?.();
  });

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  unsubscribeRunCompleted?.();
  unsubscribeRunCompleted = null;
  unsubscribeBackgroundWorkEnded?.();
  unsubscribeBackgroundWorkEnded = null;
}
