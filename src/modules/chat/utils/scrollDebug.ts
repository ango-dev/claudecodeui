/**
 * Opt-in scroll log for diagnosing transcript jumps on devices that cannot be
 * attached to a debugger (iPhone, iPad). Open the app once with `?scrolldebug`
 * in the address to turn it on (it is remembered); the panel's Off button
 * turns it off again. When off, every export here is a no-op.
 */

const STORAGE_KEY = 'cloudcli-scroll-debug';
const MAX_LINES = 400;
const VISIBLE_LINES = 12;

let enabledCache: boolean | null = null;
const lines: string[] = [];
const startedAt = Date.now();
let render: (() => void) | null = null;

function isEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  try {
    if (new URLSearchParams(window.location.search).has('scrolldebug')) {
      window.localStorage.setItem(STORAGE_KEY, '1');
    }
    enabledCache = window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

/** Used by the chat transcript's scroll code to note what it just did. */
export function scrollDebugLog(message: string): void {
  if (!isEnabled()) return;
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
  lines.push(`${seconds} ${message}`);
  if (lines.length > MAX_LINES) lines.shift();
  render?.();
}

/** The two frames that called into the scrollTop setter, as file:line:col. */
function describeCaller(): string {
  const frames = (new Error().stack ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  // Drop the Error line (Chrome) and this function plus the setter.
  const callers = frames.filter((frame) => !/^Error/.test(frame)).slice(2, 4);
  return callers
    .map((frame) => {
      const name = frame.replace(/^at /, '').split(/[@ (]/)[0] || '?';
      const location = frame.match(/([^/]+):(\d+):(\d+)\)?$/);
      return location ? `${name}@${location[1]}:${location[2]}:${location[3]}` : name;
    })
    .join(' < ');
}

/**
 * Used by ChatMessagesPane: logs every scrollTop write on the transcript with
 * who made it, touches, and large position changes, and shows the log in a
 * small panel with Copy and Off buttons. Returns the cleanup.
 */
export function attachScrollDebug(container: HTMLElement): (() => void) | undefined {
  if (!isEnabled()) return undefined;

  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (descriptor?.get && descriptor.set) {
    const { get, set } = descriptor;
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get() { return get.call(this); },
      set(value: number) {
        const before = get.call(this) as number;
        set.call(this, value);
        const after = get.call(this) as number;
        scrollDebugLog(`set ${Math.round(before)}→${Math.round(after)} (h ${container.scrollHeight}) ${describeCaller()}`);
      },
    });
  }

  let lastTop = container.scrollTop;
  const handleScroll = () => {
    const top = container.scrollTop;
    if (Math.abs(top - lastTop) > 400) {
      scrollDebugLog(`scroll moved ${Math.round(lastTop)}→${Math.round(top)} in one event`);
    }
    lastTop = top;
  };
  const handleTouchStart = () => scrollDebugLog(`touchstart at ${Math.round(container.scrollTop)}`);
  const handleTouchEnd = () => scrollDebugLog(`touchend at ${Math.round(container.scrollTop)}`);
  container.addEventListener('scroll', handleScroll, { passive: true });
  container.addEventListener('touchstart', handleTouchStart, { passive: true });
  container.addEventListener('touchend', handleTouchEnd, { passive: true });

  const panel = document.createElement('div');
  panel.setAttribute('style', [
    'position:fixed', 'left:8px', 'right:8px', 'top:calc(env(safe-area-inset-top) + 8px)', 'z-index:2147483647',
    'background:rgba(0,0,0,.82)', 'color:#fff', 'font:10px/1.35 ui-monospace,monospace', 'padding:6px 8px',
    'border-radius:8px', 'pointer-events:none', 'max-height:40vh', 'overflow:hidden', 'white-space:pre-wrap',
    'word-break:break-all',
  ].join(';'));
  const buttons = document.createElement('div');
  buttons.setAttribute('style', 'display:flex;gap:8px;margin-bottom:4px');
  const text = document.createElement('div');
  const makeButton = (label: string, onClick: () => void) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('style', 'background:#fff;color:#000;border-radius:4px;padding:2px 8px;font:inherit;pointer-events:auto');
    button.addEventListener('click', onClick);
    buttons.appendChild(button);
  };
  makeButton('Copy log', () => {
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => scrollDebugLog('(copied)'));
  });
  makeButton('Clear', () => { lines.length = 0; render?.(); });
  makeButton('Off', () => {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    enabledCache = false;
    cleanup();
  });
  panel.append(buttons, text);
  document.body.appendChild(panel);
  render = () => { text.textContent = lines.slice(-VISIBLE_LINES).join('\n'); };
  scrollDebugLog(`attached; ${navigator.userAgent.match(/Version\/[\d.]+|OS [\d_]+/g)?.join(' ') ?? ''}`);

  function cleanup() {
    render = null;
    panel.remove();
    delete (container as { scrollTop?: number }).scrollTop;
    container.removeEventListener('scroll', handleScroll);
    container.removeEventListener('touchstart', handleTouchStart);
    container.removeEventListener('touchend', handleTouchEnd);
  }
  return cleanup;
}
