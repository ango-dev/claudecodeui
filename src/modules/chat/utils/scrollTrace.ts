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
/** The transcript row being drawn right now, written before it renders. */
const ROW_KEY = 'cloudcli-scroll-trace-row';
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
  dirty: boolean;
  timers: Array<ReturnType<typeof setInterval>>;
};

let state: TraceState | null = null;

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
  if (!state || !state.dirty) return;
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
  if (gap > STALL_MS) push(`STALL main thread blocked ~${Math.round(gap - BEAT_MS)}ms`);
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
  ['pagehide', () => { push('pagehide'); if (state) state.dirty = true; persist(); }],
  ['visibilitychange', () => { push(`visibility ${document.visibilityState}`); persist(); }],
];

const start = () => {
  if (state || typeof window === 'undefined') return;
  const now = performance.now();
  state = { lines: [], counters: new Map(), startedAt: now, lastBeat: now, lastSummary: now, dirty: true, timers: [] };
  state.timers.push(setInterval(beat, BEAT_MS), setInterval(persist, PERSIST_MS));
  push(`start ${new Date().toISOString()} ${navigator.userAgent}`);
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
function initScrollTrace() {
  let last = readStorage(CURRENT_KEY);
  const lastRow = readStorage(ROW_KEY);
  if (last && lastRow) {
    // The row a freeze stopped in: drawn last, so written after everything else.
    try {
      const parsed = JSON.parse(last) as { lastBeat?: number; lines?: string[] };
      parsed.lines = [...(parsed.lines ?? []), `last row drawn: ${lastRow}`];
      last = JSON.stringify(parsed);
    } catch {
      // An unreadable log stays as it is.
    }
  }
  writeStorage(ROW_KEY, null);
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
export function markScrollRow(label: string) {
  if (!state) return;
  writeStorage(ROW_KEY, `${((performance.now() - state.startedAt) / 1000).toFixed(3)} ${label}`);
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
  writeStorage(CURRENT_KEY, null);
  if (state) {
    state.lines = [];
    state.dirty = true;
    push('cleared');
    persist();
  }
}

if (typeof window !== 'undefined') initScrollTrace();
