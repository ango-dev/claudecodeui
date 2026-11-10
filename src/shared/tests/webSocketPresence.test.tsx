import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * A session open in several tabs or devices used to ding once per page when a
 * turn finished. The server now picks one page to play the sound — the one in
 * front of the user — from what each socket last reported in `chat.presence`.
 * The provider reports on every socket it opens and whenever the page is
 * shown, hidden, focused or blurred.
 */

vi.mock('@/modules/auth', () => {
  const user = { id: 1 };
  return { useAuth: () => ({ user, token: 'token-1', isLoading: false }) };
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const { WebSocketProvider } = await import('@/shared/context/WebSocketContext');

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

const presenceFrames = (socket: FakeWebSocket) => socket.sent.filter((frame) => frame.type === 'chat.presence');

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  visibility = 'visible';
  focused = true;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a socket reports the page\'s presence as soon as it opens, before anything else', () => {
  render(<WebSocketProvider>{null}</WebSocketProvider>);
  const socket = FakeWebSocket.instances[0];

  act(() => socket.serverOpens());

  assert.deepEqual(socket.sent[0], { type: 'chat.presence', visible: true, focused: true });
});

test('hiding, showing, blurring and focusing the page each report where it stands', () => {
  render(<WebSocketProvider>{null}</WebSocketProvider>);
  const socket = FakeWebSocket.instances[0];
  act(() => socket.serverOpens());

  focused = false;
  act(() => { window.dispatchEvent(new Event('blur')); });
  visibility = 'hidden';
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  visibility = 'visible';
  focused = true;
  act(() => { window.dispatchEvent(new Event('focus')); });

  assert.deepEqual(presenceFrames(socket).slice(1), [
    { type: 'chat.presence', visible: true, focused: false },
    { type: 'chat.presence', visible: false, focused: false },
    { type: 'chat.presence', visible: true, focused: true },
  ]);
});

test('a reconnected socket reports again; a closed one is not written to', () => {
  render(<WebSocketProvider>{null}</WebSocketProvider>);
  const first = FakeWebSocket.instances[0];
  act(() => first.serverOpens());
  act(() => first.serverDrops());

  visibility = 'hidden';
  focused = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(presenceFrames(first).length, 1, 'nothing is sent while no socket is open');

  act(() => { vi.advanceTimersByTime(3000); });
  const second = FakeWebSocket.instances[1];
  act(() => second.serverOpens());

  assert.deepEqual(presenceFrames(second), [{ type: 'chat.presence', visible: false, focused: false }]);
});
