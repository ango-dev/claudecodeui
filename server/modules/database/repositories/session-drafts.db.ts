import { createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

/**
 * One chat scope's unsent state: the text still in the composer, plus the
 * messages queued behind an in-flight turn, oldest first. Both are optional —
 * a scope can hold only a draft, only queued messages, or both.
 */
export type SessionDraftRecord = {
  scope: string;
  text: string;
  queuedMessages: unknown[];
  updatedAt: string;
};

type DraftRow = {
  draft_scope: string;
  draft_text: string;
  queued_message: string | null;
  updated_at: string;
};

/**
 * A session's server-owned queued turns, oldest first, together with the exact
 * stored value its next turn is claimed against, so it is claimed only once.
 */
export type QueuedSessionMessageRecord = {
  userId: number;
  sessionId: string;
  queuedMessages: unknown[];
  claimToken: string;
};

type QueuedMessageRow = {
  user_id: number;
  draft_scope: string;
  queued_message: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * A queued message's id. Messages queued before the queue took several have
 * none, so theirs is derived from their content: the same message always
 * gets the same id, which is what lets a client remove it.
 */
function queuedMessageId(message: Record<string, unknown>): string {
  if (typeof message.id === 'string' && message.id) {
    return message.id;
  }
  return `legacy-${createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 16)}`;
}

/**
 * The queued turns stored for a scope, oldest first, each with its id. The
 * column held a single message before the queue took several, so a stored
 * object reads as a queue of one. A value that no longer parses is treated
 * as empty, not fatal.
 */
function parseQueuedMessages(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages
      .filter(isRecord)
      .map((message) => ({ ...message, id: queuedMessageId(message) }));
  } catch {
    return [];
  }
}

function serializeQueuedMessages(messages: unknown[]): string | null {
  return messages.length === 0 ? null : JSON.stringify(messages);
}

function toRecord(row: DraftRow): SessionDraftRecord {
  return {
    scope: row.draft_scope,
    text: row.draft_text,
    queuedMessages: parseQueuedMessages(row.queued_message),
    updatedAt: row.updated_at,
  };
}

export const sessionDraftsDb = {
  /**
   * Returns every draft the user has, newest first.
   *
   * The client pulls the whole set once per load: drafts are short strings, and
   * having them all up front means switching sessions restores a draft written
   * on another device without a round trip.
   */
  getDrafts(userId: number): SessionDraftRecord[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT draft_scope, draft_text, queued_message, updated_at
         FROM session_drafts
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC`
      )
      .all(userId) as DraftRow[];

    return rows.map(toRecord);
  },

  /** Lists persisted queued turns whose scopes are real chat sessions. */
  listQueuedMessages(): QueuedSessionMessageRecord[] {
    const rows = getConnection()
      .prepare(
        `SELECT drafts.user_id, drafts.draft_scope, drafts.queued_message
         FROM session_drafts AS drafts
         INNER JOIN sessions ON sessions.session_id = drafts.draft_scope
         WHERE drafts.queued_message IS NOT NULL`
      )
      .all() as QueuedMessageRow[];

    return rows.map((row) => ({
      userId: row.user_id,
      sessionId: row.draft_scope,
      queuedMessages: parseQueuedMessages(row.queued_message),
      claimToken: row.queued_message,
    }));
  },

  /**
   * Atomically takes the oldest `count` queued turns off the session's queue,
   * only if the queue has not been edited since listing. Returns them oldest
   * first, or null when the queue changed (or holds fewer than `count`) and
   * nothing was taken.
   */
  claimQueuedMessages(candidate: QueuedSessionMessageRecord, count: number): unknown[] | null {
    if (!Number.isInteger(count) || count < 1 || count > candidate.queuedMessages.length) {
      return null;
    }
    const claimed = candidate.queuedMessages.slice(0, count);
    const rest = candidate.queuedMessages.slice(count);
    const result = getConnection()
      .prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ? AND queued_message = ?`
      )
      .run(serializeQueuedMessages(rest), candidate.userId, candidate.sessionId, candidate.claimToken);
    return result.changes > 0 ? claimed : null;
  },

  /**
   * Puts claimed turns back at the front of their session's queue, in their
   * order, for the narrow race where another run starts first. Turns queued
   * meanwhile stay behind them.
   */
  restoreQueuedMessages(userId: number, scope: string, messages: unknown[]): void {
    if (messages.length === 0) {
      return;
    }
    const db = getConnection();
    db.transaction(() => {
      const row = db
        .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { queued_message: string | null } | undefined;
      const queue = serializeQueuedMessages([...messages, ...parseQueuedMessages(row?.queued_message ?? null)]);
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, scope, queue);
    })();
  },

  /**
   * Adds a turn to the end of the scope's queue. A message whose id is already
   * queued is not added twice, so a retried request is harmless. Returns false,
   * adding nothing, when the queue already holds `maxLength` turns.
   */
  appendQueuedMessage(userId: number, scope: string, message: Record<string, unknown>, maxLength: number): boolean {
    const db = getConnection();
    return db.transaction(() => {
      const row = db
        .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { queued_message: string | null } | undefined;
      const queue = parseQueuedMessages(row?.queued_message ?? null);
      if (queue.some((queued) => queued.id === message.id)) {
        return true;
      }
      if (queue.length >= maxLength) {
        return false;
      }
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
         VALUES (?, ?, '', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           queued_message = excluded.queued_message,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, scope, serializeQueuedMessages([...queue, message]));
      return true;
    })();
  },

  /**
   * Takes one turn out of the scope's queue by id, leaving the rest in order.
   * A turn the server has already sent is gone, so removing it does nothing.
   */
  removeQueuedMessage(userId: number, scope: string, id: string): void {
    const db = getConnection();
    db.transaction(() => {
      const row = db
        .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .get(userId, scope) as { queued_message: string | null } | undefined;
      const queue = parseQueuedMessages(row?.queued_message ?? null);
      const rest = queue.filter((queued) => queued.id !== id);
      if (rest.length === queue.length) {
        return;
      }
      db.prepare(
        `UPDATE session_drafts
         SET queued_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND draft_scope = ?`
      ).run(serializeQueuedMessages(rest), userId, scope);
      sessionDraftsDb.deleteEmptyDraft(userId, scope);
    })();
  },

  /** Removes the placeholder row left after its last queued turn is claimed. */
  deleteEmptyDraft(userId: number, scope: string): void {
    getConnection()
      .prepare(
        `DELETE FROM session_drafts
         WHERE user_id = ? AND draft_scope = ? AND draft_text = '' AND queued_message IS NULL`
      )
      .run(userId, scope);
  },

  /**
   * Writes one scope's composer text, or deletes the row when nothing is left
   * to keep. The queue is left as it is unless `queuedMessages` is given: it
   * changes through append and remove, so a text save from a tab that has not
   * yet seen the server send a queued turn cannot put that turn back.
   *
   * Deleting on empty is what stops the table growing a permanent row for every
   * session the user ever opened and typed a character into.
   */
  saveDraft(
    userId: number,
    scope: string,
    draft: { text: string; queuedMessages?: unknown[] }
  ): void {
    const db = getConnection();

    if (draft.queuedMessages === undefined) {
      db.prepare(
        `INSERT INTO session_drafts (user_id, draft_scope, draft_text, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id, draft_scope) DO UPDATE SET
           draft_text = excluded.draft_text,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, scope, draft.text);
      sessionDraftsDb.deleteEmptyDraft(userId, scope);
      return;
    }

    if (!draft.text && draft.queuedMessages.length === 0) {
      db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
        .run(userId, scope);
      return;
    }

    db.prepare(
      `INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, draft_scope) DO UPDATE SET
         draft_text = excluded.draft_text,
         queued_message = excluded.queued_message,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      userId,
      scope,
      draft.text,
      serializeQueuedMessages(draft.queuedMessages)
    );
  },

  deleteDraft(userId: number, scope: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .run(userId, scope);
  },
};
