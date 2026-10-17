import { scheduledMessagesDb, sessionDraftsDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, checkSendStopsBackgroundWork, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

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

type StoredQueuedMessage = {
  content: string;
  options: Record<string, unknown>;
  attachments: unknown[];
};

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

function readQueuedMessage(value: unknown): StoredQueuedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const content = typeof record.content === 'string' ? record.content : '';
  const attachments = Array.isArray(record.attachments)
    ? record.attachments
    : Array.isArray(record.images)
      ? record.images
      : [];
  if (!content.trim() && attachments.length === 0) {
    return null;
  }
  const options = record.options && typeof record.options === 'object' && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return { content, options, attachments };
}

/** The options a queued turn is sent with — and previewed with, so both agree. */
function queuedTurnOptions(message: StoredQueuedMessage): Record<string, unknown> {
  return { ...message.options, attachments: message.attachments };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  claimed: unknown,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedMessage(claimed);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: queuedTurnOptions(message),
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back at the front so the next pass
  // tries it again before anything queued behind it.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate.userId, candidate.sessionId, claimed);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether the session's next queued turn (`head`, the oldest) has to keep
 * waiting: while a turn is running, and while sending it would stop the
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
 * Only the head is asked about: the queue goes in order, so nothing behind it
 * may overtake it.
 */
async function isSessionBusy(
  sessionId: string,
  head: StoredQueuedMessage | null,
  runtime: ProviderRuntimeGateway,
): Promise<boolean> {
  if (chatRunRegistry.isProcessing(sessionId)) {
    return true;
  }
  // A malformed head is claimed only to be dropped; it sends nothing.
  if (!head || !runtime.hasBackgroundWork(sessionId)) {
    return false;
  }
  try {
    const impact = await checkSendStopsBackgroundWork(
      { sessionId, options: queuedTurnOptions(head) },
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
 * Sends the oldest queued turn of every session that is currently idle. One
 * per session per pass: the turn it starts makes the session busy, and the
 * next in line goes when that turn ends.
 */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    const head = readQueuedMessage(candidate.queuedMessages[0]);
    if (await isSessionBusy(candidate.sessionId, head, runtime)) {
      return;
    }
    const next = sessionDraftsDb.claimNextQueuedMessage(candidate);
    if (next === null) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, next, runtime);
  }));

  return claimed;
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
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
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
