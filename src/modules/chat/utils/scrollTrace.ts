/**
 * A flight recorder for the transcript's scrolling and paging, switched on
 * from Settings > About (ScrollDiagnostics) to catch a freeze on a real
 * device that no emulator reproduces.
 *
 * Every event lands in a ring buffer that is written to localStorage within
 * half a second, and at once for the paging steps, so the last moments before
 * a freeze survive the refresh that ends it. A heartbeat notes main-thread
 * stalls and, each second, how often the busy paths ran (scroll events,
 * resize corrections, lazy rows mounting), which is what a runaway loop shows
 * up as. Off, every call here returns at once.
 */

const ENABLED_KEY = 'cloudcli-scroll-trace';
const CURRENT_KEY = 'cloudcli-scroll-trace-log';
const PREVIOUS_KEY = 'cloudcli-scroll-trace-previous';
/** The transcript row being drawn right now and its steps, written as they happen. */
const ROW_KEY = 'cloudcli-scroll-trace-row';
/** Rows a page froze while drawing; shown as a placeholder until drawn on request. */
const SKIPPED_KEY = 'cloudcli-scroll-trace-skipped';
const MAX_STEPS = 24;
/** The last heartbeat, kept apart from the log so it stays current while nothing is logged. */
const BEAT_KEY = 'cloudcli-scroll-trace-beat';
/** Earlier pages kept, so refreshing twice after a freeze does not lose it. */
const PREVIOUS_RUNS = 3;
const MAX_LINES = 600;
const PERSIST_MS = 500;
const BEAT_MS = 200;
/** A heartbeat this late means the main thread was blocked for that long. */
const STALL_MS = 600;

type TraceValue = string | number | boolean | null | undefined;

type TraceState = {
  lines: string[];
  counters: Map<string, number>;
  startedAt: number;
  lastBeat: number;
  lastSummary: number;
  /** The page was hidden at some point since the last heartbeat; see beat(). */
  hiddenSinceBeat: boolean;
  dirty: boolean;
  timers: Array<ReturnType<typeof setInterval>>;
};

let state: TraceState | null = null;

type RowMark = { at: number; label: string; timestamp?: string; steps: string[] };
let rowMark: RowMark | null = null;
let skippedRows: Array<{ timestamp: string; label: string }> = [];

const readStorage = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the in-memory log still shows in the panel.
  }
};

const format = (data?: Record<string, TraceValue>): string => {
  if (!data) return '';
  return Object.entries(data)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value * 10) / 10 : String(value)}`)
    .join(' ');
};

const persist = () => {
  if (!state) return;
  writeStorage(BEAT_KEY, String(state.lastBeat));
  if (!state.dirty) return;
  state.dirty = false;
  writeStorage(CURRENT_KEY, JSON.stringify({ lastBeat: state.lastBeat, lines: state.lines }));
};

const push = (line: string) => {
  if (!state) return;
  const elapsed = ((performance.now() - state.startedAt) / 1000).toFixed(3);
  state.lines.push(`${elapsed} ${line}`);
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  state.dirty = true;
};

const beat = () => {
  if (!state) return;
  const now = performance.now();
  const gap = now - state.lastBeat;
  // iOS slows a hidden page's timers to one a second and suspends it outright
  // in the background: a late heartbeat then says nothing about the page.
  const hidden = document.visibilityState === 'hidden';
  if (gap > STALL_MS && !hidden && !state.hiddenSinceBeat) {
    push(`STALL main thread blocked ~${Math.round(gap - BEAT_MS)}ms`);
  }
  state.hiddenSinceBeat = hidden;
  state.lastBeat = now;
  if (now - state.lastSummary >= 1000) {
    state.lastSummary = now;
    if (state.counters.size > 0) {
      const counts = [...state.counters.entries()].map(([name, count]) => `${name}=${count}`).join(' ');
      state.counters.clear();
      const pane = document.querySelector<HTMLElement>('.chat-messages-pane');
      push(`per-second ${counts}${pane ? ` | top=${Math.round(pane.scrollTop)} h=${pane.scrollHeight}` : ''}`);
    }
  }
};

// Errors, and the page being hidden or torn down (iOS ending a stuck tab), end up in the log too.
const pageListeners: Array<[string, (event: Event) => void]> = [
  ['error', (event) => { push(`ERROR ${(event as ErrorEvent).message}`); persist(); }],
  ['unhandledrejection', (event) => { push(`REJECTION ${String((event as PromiseRejectionEvent).reason)}`); persist(); }],
  // Leaving the page normally also clears the row mark, so one that survives
  // to the next load is from a page that froze or crashed while drawing it.
  ['pagehide', () => { push('pagehide'); if (state) state.dirty = true; persist(); writeStorage(ROW_KEY, null); }],
  ['visibilitychange', () => {
    push(`visibility ${document.visibilityState}`);
    if (state && document.visibilityState === 'hidden') state.hiddenSinceBeat = true;
    persist();
    if (document.visibilityState === 'hidden') writeStorage(ROW_KEY, null);
  }],
];

const start = () => {
  if (state || typeof window === 'undefined') return;
  const now = performance.now();
  state = {
    lines: [],
    counters: new Map(),
    startedAt: now,
    lastBeat: now,
    lastSummary: now,
    hiddenSinceBeat: document.visibilityState === 'hidden',
    dirty: true,
    timers: [],
  };
  state.timers.push(setInterval(beat, BEAT_MS), setInterval(persist, PERSIST_MS));
  push(`start ${new Date().toISOString()} ${document.visibilityState} ${navigator.userAgent}`);
  for (const [type, listener] of pageListeners) window.addEventListener(type, listener);
  persist();
};

const stop = () => {
  if (!state) return;
  for (const [type, listener] of pageListeners) window.removeEventListener(type, listener);
  for (const timer of state.timers) clearInterval(timer);
  persist();
  state = null;
};

const readPreviousRuns = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(readStorage(PREVIOUS_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((run): run is string => typeof run === 'string') : [];
  } catch {
    return [];
  }
};

/** On load: the last page's log joins the earlier runs, and recording resumes if it was on. */
const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = readStorage(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

function initScrollTrace() {
  skippedRows = readJson(SKIPPED_KEY, []);
  let last = readStorage(CURRENT_KEY);
  const lastRow = readJson<RowMark | null>(ROW_KEY, null);
  writeStorage(ROW_KEY, null);
  if (last && lastRow) {
    // The row a freeze stopped in, with how far its drawing got.
    const parsed = readJson<{ lines?: string[] }>(CURRENT_KEY, {});
    const lastBeat = Number(readStorage(BEAT_KEY) ?? 0);
    const finished = lastRow.steps.at(-1)?.endsWith('drawn; layout running') ?? false;
    // Still drawing it when the heartbeat stopped: that row froze the page.
    const froze = !finished && lastRow.at > lastBeat - 1000;
    if (froze && lastRow.timestamp && !skippedRows.some((row) => row.timestamp === lastRow.timestamp)) {
      skippedRows = [...skippedRows, { timestamp: lastRow.timestamp, label: lastRow.label }].slice(-10);
      writeStorage(SKIPPED_KEY, JSON.stringify(skippedRows));
    }
    parsed.lines = [
      ...(parsed.lines ?? []),
      `last row drawn: ${lastRow.label}`,
      ...lastRow.steps.map((step) => `  step ${step}`),
      froze ? '  -> the page froze in this row; it is skipped from now on (Draw it anyway brings it back)' : '  -> drawing finished; the page stopped later',
    ];
    last = JSON.stringify(parsed);
  }
  if (last) {
    writeStorage(PREVIOUS_KEY, JSON.stringify([last, ...readPreviousRuns()].slice(0, PREVIOUS_RUNS)));
    writeStorage(CURRENT_KEY, null);
  }
  if (readStorage(ENABLED_KEY) === '1') start();
}

export const isScrollTraceEnabled = (): boolean => state !== null;

export function setScrollTraceEnabled(enabled: boolean) {
  writeStorage(ENABLED_KEY, enabled ? '1' : null);
  if (enabled) start();
  else stop();
}

/** One event worth a line: a paging step, a correction, a touch. `flush` writes it out at once. */
export function traceScroll(name: string, data?: Record<string, TraceValue>, flush = false) {
  if (!state) return;
  push(`${name} ${format(data)}`.trimEnd());
  if (flush) persist();
}

/**
 * Names the transcript row about to be drawn, written straight to storage: a
 * row that never finishes drawing freezes the page before the log is next
 * saved, and this is how the log still says which one it was.
 */
export function markScrollRow(label: string, timestamp?: string) {
  if (!state) return;
  const elapsed = ((performance.now() - state.startedAt) / 1000).toFixed(3);
  rowMark = { at: performance.now(), label: `${elapsed} ${label}`, timestamp, steps: [] };
  writeStorage(ROW_KEY, JSON.stringify(rowMark));
}

/** A step inside the row being drawn (plan card, markdown, a code block), so a freeze names the part. */
export function markScrollStep(step: string) {
  if (!state || !rowMark) return;
  rowMark.at = performance.now();
  rowMark.steps.push(`${((rowMark.at - state.startedAt) / 1000).toFixed(3)} ${step}`);
  if (rowMark.steps.length > MAX_STEPS) rowMark.steps.splice(0, rowMark.steps.length - MAX_STEPS);
  writeStorage(ROW_KEY, JSON.stringify(rowMark));
}

/** Marks a step where it renders: placed after a subtree, it says that subtree finished drawing. */
export function TraceStep({ step }: { step: string }): null {
  markScrollStep(step);
  return null;
}

/** Whether the row with this timestamp froze a page while drawing and is skipped. */
export const isRowSkipped = (timestamp?: string): boolean => (
  Boolean(timestamp) && skippedRows.some((row) => row.timestamp === timestamp)
);

/** Draws a skipped row again (its "Draw it anyway" button). */
export function unskipRow(timestamp: string) {
  skippedRows = skippedRows.filter((row) => row.timestamp !== timestamp);
  writeStorage(SKIPPED_KEY, skippedRows.length ? JSON.stringify(skippedRows) : null);
}

/** A busy path that runs too often to log line by line; reported as a per-second count. */
export function countScroll(name: string) {
  if (!state) return;
  state.counters.set(name, (state.counters.get(name) ?? 0) + 1);
}

/** The recorded text: this page's log and the earlier pages', newest first. */
export function readScrollTrace(): { current: string; previous: string[] } {
  persist();
  const render = (raw: string | null): string => {
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw) as { lastBeat?: number; lines?: string[] };
      return (parsed.lines ?? []).join('\n');
    } catch {
      return '';
    }
  };
  return { current: render(readStorage(CURRENT_KEY)), previous: readPreviousRuns().map(render) };
}

export function clearScrollTrace() {
  writeStorage(PREVIOUS_KEY, null);
  writeStorage(ROW_KEY, null);
  writeStorage(SKIPPED_KEY, null);
  skippedRows = [];
  writeStorage(CURRENT_KEY, null);
  if (state) {
    state.lines = [];
    state.dirty = true;
    push('cleared');
    persist();
  }
}

if (typeof window !== 'undefined') initScrollTrace();
