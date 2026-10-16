/**
 * Themed stand-ins for `window.confirm` and `window.alert`.
 *
 * The browser's own dialogs ignore the app's theme, and on iOS they render as
 * the system sheet. These return the same answers through a promise, drawn by
 * the one `AppDialogHost` the app mounts. Requests made while another dialog
 * is open wait their turn. With no host mounted (unit tests, or a render
 * failure above it) they fall back to the browser's dialogs, so a question is
 * never silently skipped.
 */

/** One pending dialog, as `AppDialogHost` draws it. */
export type AppDialogRequest = {
  id: number;
  kind: 'confirm' | 'alert';
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  resolve: (confirmed: boolean) => void;
};

/** Options for `confirmDialog`: button wording, and whether confirming destroys something. */
export type ConfirmDialogOptions = {
  confirmLabel?: string;
  cancelLabel?: string;
  /** Shows the confirm button in the destructive colour, for deletes and discards. */
  destructive?: boolean;
};

let queue: AppDialogRequest[] = [];
let nextRequestId = 1;
let mountedHosts = 0;
const listeners = new Set<() => void>();

function publish(next: AppDialogRequest[]): void {
  queue = next;
  for (const listener of listeners) listener();
}

/** Subscribes AppDialogHost to queue changes; returns the unsubscribe function. */
export function subscribeToDialogRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The request AppDialogHost should show now, or null when none is waiting. */
export function readCurrentDialogRequest(): AppDialogRequest | null {
  return queue[0] ?? null;
}

/**
 * Records that an AppDialogHost is mounted, so requests go to it rather than
 * to the browser's dialogs; returns the matching unregister.
 */
export function registerDialogHost(): () => void {
  mountedHosts += 1;
  return () => {
    mountedHosts -= 1;
  };
}

/** Answers the request on screen; a stale id (already answered) is ignored. */
export function settleDialogRequest(id: number, confirmed: boolean): void {
  const current = queue[0];
  if (current?.id !== id) return;
  publish(queue.slice(1));
  current.resolve(confirmed);
}

/**
 * Asks a yes/no question in a themed dialog; resolves true when confirmed.
 * Used by the chat, code-editor, settings and mcp modules wherever they asked
 * with `window.confirm`.
 */
export function confirmDialog(message: string, options: ConfirmDialogOptions = {}): Promise<boolean> {
  if (mountedHosts === 0) {
    return Promise.resolve(window.confirm(message));
  }
  return new Promise((resolve) => {
    publish([...queue, { id: nextRequestId++, kind: 'confirm', message, ...options, resolve }]);
  });
}

/**
 * Shows a message in a themed dialog; resolves once it is dismissed. Used by
 * the project-workspace, prd-editor, task-master, sidebar and mcp modules
 * wherever they reported with `window.alert`.
 */
export function alertDialog(message: string): Promise<void> {
  if (mountedHosts === 0) {
    window.alert(message);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    publish([...queue, { id: nextRequestId++, kind: 'alert', message, resolve: () => resolve() }]);
  });
}
