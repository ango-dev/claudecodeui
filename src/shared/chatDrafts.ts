import { api, readApiErrorMessage } from '@/shared/api';
import type { QueuedSendOptions } from '@/shared/types';

/**
 * Unsent composer text and queued messages, stored in `auth.db` rather than in
 * the browser.
 *
 * This is what lets a message half-typed on a laptop be finished on a phone —
 * the case the composer previously could not serve at all, because a draft only
 * existed on the machine it was typed on. As with the preference store, a
 * localStorage mirror is kept purely so a reload shows the draft on the first
 * paint instead of a blank composer that fills in a moment later.
 *
 * A scope is a session id, or `project:<projectId>` for a chat that has not
 * been sent yet and so has no session. Drafts used to be keyed by project
 * alone, which meant every session in a project shared one draft.
 */

/** A queued message as it is stored: text plus the send options it was composed under. */
export type StoredQueuedMessage = {
  /** Chosen by the client that queued it; the server gives one to a message stored before ids existed. */
  id: string;
  content: string;
  options?: QueuedSendOptions;
  /** Legacy image-only descriptors retained for queued draft compatibility. */
  images?: unknown[];
  /**
   * JSON-safe descriptors returned by POST /api/assets/files. Unlike browser
   * File objects, they can follow a queued message across session switches.
   */
  attachments?: unknown[];
};

type DraftRecord = {
  text: string;
  /** Messages waiting for the session, oldest first; the server sends them one per turn. */
  queuedMessages: StoredQueuedMessage[];
};

/** Fired after any draft changes, from a local write or from a hydrate. */
export const CHAT_DRAFTS_CHANGED_EVENT = 'chat-drafts:changed';

const MIRROR_STORAGE_KEY = 'chat-drafts';

/**
 * Longer than the preference debounce: this fires on every keystroke, and a
 * draft is only ever read back on a reload or a device switch, so trading a
 * little latency for far fewer requests is the right side of the trade.
 */
const SERVER_WRITE_DEBOUNCE_MS = 1_000;

const EMPTY_DRAFT: DraftRecord = { text: '', queuedMessages: [] };

const listeners = new Set<() => void>();

let drafts = new Map<string, DraftRecord>();
const pendingScopes = new Set<string>();
let serverWriteTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Counts local changes; `changedAt` records the count at each scope's last
 * one. A hydrate whose request left before a scope changed here carries a
 * copy older than what this tab holds, so it keeps the local one.
 */
let changeCount = 0;
const changedAt = new Map<string, number>();
/**
 * Requests per scope still on their way to the server. Until they land, the
 * server's copy may not include them, so a hydrate keeps the local one.
 */
const inFlight = new Map<string, number>();

/**
 * The last queue request per scope. Queue changes for one scope go out one
 * after another, so a removal can never overtake the append it undoes and
 * leave that message queued.
 */
const queueRequestChains = new Map<string, Promise<unknown>>();

function sendQueueRequestInOrder<T>(scope: string, send: () => Promise<T>): Promise<T> {
  const previous = queueRequestChains.get(scope) ?? Promise.resolve();
  const request = previous.catch(() => undefined).then(send);
  queueRequestChains.set(scope, request);
  void request.finally(() => {
    if (queueRequestChains.get(scope) === request) {
      queueRequestChains.delete(scope);
    }
  }).catch(() => undefined);
  return request;
}

function trackRequest(scope: string, request: Promise<unknown>): Promise<unknown> {
  inFlight.set(scope, (inFlight.get(scope) ?? 0) + 1);
  return request.finally(() => {
    const remaining = (inFlight.get(scope) ?? 1) - 1;
    if (remaining > 0) {
      inFlight.set(scope, remaining);
    } else {
      inFlight.delete(scope);
    }
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isEmptyDraft = (draft: DraftRecord): boolean => (
  draft.text === '' && draft.queuedMessages.length === 0
);

/**
 * A stored queue, from the server or the mirror. Both held one
 * `queuedMessage` before the queue took several, which reads as a queue of one.
 */
function readStoredQueue(value: { queuedMessages?: unknown; queuedMessage?: unknown }): StoredQueuedMessage[] {
  if (Array.isArray(value.queuedMessages)) {
    return value.queuedMessages.filter(isRecord) as StoredQueuedMessage[];
  }
  return isRecord(value.queuedMessage) ? [value.queuedMessage as StoredQueuedMessage] : [];
}

/** Whether two queues hold the same messages, so a hydrate that changes nothing notifies nobody. */
function sameQueue(left: StoredQueuedMessage[], right: StoredQueuedMessage[]): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** A queued message's attachments, from the current field or the legacy image-only one. */
function readAttachments(message: StoredQueuedMessage): unknown[] {
  return Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(message.images)
      ? message.images
      : [];
}

function readMirror(): Map<string, DraftRecord> {
  try {
    const raw = localStorage.getItem(MIRROR_STORAGE_KEY);
    if (!raw) {
      return new Map();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return new Map();
    }

    const restored = new Map<string, DraftRecord>();
    for (const [scope, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      restored.set(scope, {
        text: typeof value.text === 'string' ? value.text : '',
        queuedMessages: readStoredQueue(value),
      });
    }
    return restored;
  } catch {
    return new Map();
  }
}

function writeMirror(): void {
  try {
    localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
  } catch {
    // A full localStorage costs the first-paint restore, not the draft: the
    // server copy is authoritative and arrives on hydrate.
  }
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_DRAFTS_CHANGED_EVENT));
  }
}

function flushServerWrites(): void {
  serverWriteTimer = null;
  const scopes = [...pendingScopes];
  pendingScopes.clear();

  for (const scope of scopes) {
    const draft = drafts.get(scope);

    // A save that fails must never surface as an unhandled rejection out of a
    // timer callback: the mirror already holds the draft, and the next
    // keystroke re-sends it. Only the text is sent: the queue changes one
    // message at a time (see appendQueuedMessage), and the server drops the
    // row once both are empty.
    try {
      void trackRequest(scope, api.user.saveDraft(scope, { text: draft?.text ?? '' })).catch((error: unknown) => {
        console.error('Failed to save chat draft:', error);
      });
    } catch (error) {
      console.error('Failed to save chat draft:', error);
    }
  }
}

function queueServerWrite(scope: string): void {
  pendingScopes.add(scope);

  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
  }
  serverWriteTimer = setTimeout(flushServerWrites, SERVER_WRITE_DEBOUNCE_MS);
}

/** Applies a local change to one scope; returns false when nothing changed. */
function setDraft(scope: string, update: Partial<DraftRecord>): boolean {
  const current = drafts.get(scope) ?? EMPTY_DRAFT;
  const next: DraftRecord = { ...current, ...update };

  if (next.text === current.text && sameQueue(next.queuedMessages, current.queuedMessages)) {
    return false;
  }

  const nextDrafts = new Map(drafts);
  if (isEmptyDraft(next)) {
    nextDrafts.delete(scope);
  } else {
    nextDrafts.set(scope, next);
  }
  drafts = nextDrafts;
  changeCount += 1;
  changedAt.set(scope, changeCount);

  writeMirror();
  notifyListeners();
  return true;
}

/** Reads one scope's composer text, synchronously, for the first render. */
export function readDraftText(scope: string): string {
  return drafts.get(scope)?.text ?? '';
}

export function writeDraftText(scope: string, text: string): void {
  if (setDraft(scope, { text })) {
    queueServerWrite(scope);
  }
}

/**
 * One scope's queued messages, oldest first, each with its attachments in
 * the current field. A message with neither text nor attachments has nothing
 * to send and is left out.
 */
export function readQueuedMessages(scope: string): StoredQueuedMessage[] {
  return (drafts.get(scope)?.queuedMessages ?? [])
    .filter((message) => typeof message.content === 'string')
    // Only a mirror written before ids existed lacks one, until the next hydrate.
    .map((message, index) => ({ ...message, id: message.id ?? `local-${index}`, attachments: readAttachments(message) }))
    .filter((message) => message.content.trim() || message.attachments.length > 0);
}

/** How an append ended: kept, or refused with the server's reason when it gave one. */
export type QueueAppendResult = { kept: true } | { kept: false; reason: string | null };

/**
 * Adds a message to the end of one scope's queue, shown here at once and
 * sent to the server straight away rather than debounced: queueing is a
 * send-like action that must survive the tab closing. When the server will
 * not keep it, it is taken back out and the result says why.
 */
export async function appendQueuedMessage(scope: string, message: StoredQueuedMessage): Promise<QueueAppendResult> {
  const current = drafts.get(scope)?.queuedMessages ?? [];
  setDraft(scope, { queuedMessages: [...current, message] });
  let reason: string | null = null;
  try {
    const response = await trackRequest(
      scope,
      sendQueueRequestInOrder(scope, () => api.user.queueMessage(scope, message)),
    ) as Response;
    if (response.ok) {
      return { kept: true };
    }
    reason = readApiErrorMessage(await response.json().catch(() => null));
    console.error('Failed to queue chat message:', response.status, reason);
  } catch (error) {
    console.error('Failed to queue chat message:', error);
  }
  const queue = drafts.get(scope)?.queuedMessages ?? [];
  setDraft(scope, { queuedMessages: queue.filter((queued) => queued.id !== message.id) });
  return { kept: false, reason };
}

/**
 * Takes one message out of a scope's queue, here and on the server. Sent at
 * once, because an edit or a cancel must beat the server's next dispatch; a
 * message the server has already sent is simply gone.
 */
export function removeQueuedMessage(scope: string, id: string): void {
  const queue = drafts.get(scope)?.queuedMessages ?? [];
  setDraft(scope, { queuedMessages: queue.filter((queued) => queued.id !== id) });
  void trackRequest(scope, sendQueueRequestInOrder(scope, () => api.user.unqueueMessage(scope, id))).catch((error: unknown) => {
    console.error('Failed to remove queued chat message:', error);
  });
}

/** Subscribes to any draft change; returns the unsubscribe function. */
export function subscribeToChatDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Loads the server's drafts and adopts them as the source of truth.
 *
 * A scope the client has typed into since this page loaded is left alone: the
 * user is looking at that composer right now, and replacing its contents with a
 * staler server copy would delete what they are in the middle of writing.
 */
export async function hydrateChatDrafts(): Promise<void> {
  const startedAt = changeCount;
  let serverDrafts: Array<{ scope?: unknown; text?: unknown; queuedMessages?: unknown; queuedMessage?: unknown }> = [];

  try {
    const response = await api.user.drafts();
    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as { drafts?: unknown };
    if (!Array.isArray(payload.drafts)) {
      return;
    }
    serverDrafts = payload.drafts as typeof serverDrafts;
  } catch (error) {
    // Keep the mirror: an offline load must still show what was typed here.
    console.error('Failed to load chat drafts:', error);
    return;
  }

  // A scope changed here since the request left, or with a change still on
  // its way to the server, keeps this tab's copy; the next hydrate settles it.
  const keepsLocal = (scope: string) => (
    pendingScopes.has(scope) || inFlight.has(scope) || (changedAt.get(scope) ?? 0) > startedAt
  );

  const merged = new Map<string, DraftRecord>();
  for (const draft of serverDrafts) {
    const scope = typeof draft.scope === 'string' ? draft.scope : '';
    if (!scope || keepsLocal(scope)) {
      continue;
    }

    merged.set(scope, {
      text: typeof draft.text === 'string' ? draft.text : '',
      queuedMessages: readStoredQueue(draft),
    });
  }

  // Local changes the server snapshot may not include win over it. Every
  // other missing scope was deleted remotely and must also disappear from
  // the mirror.
  for (const [scope, local] of drafts) {
    if (keepsLocal(scope)) {
      merged.set(scope, local);
    }
  }

  const unchanged = merged.size === drafts.size && [...merged].every(([scope, draft]) => {
    const local = drafts.get(scope);
    return local !== undefined && local.text === draft.text && sameQueue(local.queuedMessages, draft.queuedMessages);
  });
  if (unchanged) {
    return;
  }
  drafts = merged;
  writeMirror();
  notifyListeners();
}

/** Drops every cached draft on sign-out, so the next user sees none of them. */
export function resetChatDrafts(): void {
  drafts = new Map();
  pendingScopes.clear();
  changedAt.clear();
  if (serverWriteTimer !== null) {
    clearTimeout(serverWriteTimer);
    serverWriteTimer = null;
  }
  try {
    localStorage.removeItem(MIRROR_STORAGE_KEY);
  } catch {
    // The in-memory copy is already cleared, which is what readers use.
  }
  notifyListeners();
}

// Read at module load rather than on first use, because the composer's initial
// input value is a `useState` initializer that runs before any effect.
if (typeof localStorage !== 'undefined') {
  drafts = readMirror();
}
