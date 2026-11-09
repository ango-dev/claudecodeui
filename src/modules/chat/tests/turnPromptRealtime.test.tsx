import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * Every run now opens with its own prompt on the live stream, as a user `text`
 * row flagged `isTurnPrompt`. Before, a page that had the session open when
 * the server sent a queued or scheduled message — or that watched another tab
 * send — saw neither that message nor the reply until a reload.
 *
 * These drive the real realtime handler into the real session store, so what
 * is checked is what the transcript would draw.
 */

const SESSION_ID = 'session-1';

const sessionMessages = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const forgetSentQueuedMessages = vi.hoisted(() => vi.fn());
vi.mock('@/shared/chatDrafts', () => ({ forgetSentQueuedMessages }));

let historyRows: NormalizedMessage[] = [];

const historyRow = (id: string, role: 'user' | 'assistant', content: string, timestamp: string): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  content,
  provider: 'claude',
  sessionId: SESSION_ID,
  timestamp,
});

const EARLIER_TURN = [
  historyRow('h-u1', 'user', 'count slowly to three', '2026-11-09T10:00:00.000Z'),
  historyRow('h-a1', 'assistant', 'one, two, three', '2026-11-09T10:00:05.000Z'),
];

/** The run's opening event as the gateway sends it. */
const turnPrompt = (fields: Partial<NormalizedMessage> = {}): ServerEvent => ({
  kind: 'text',
  role: 'user',
  id: 'prompt_6f1d1a2e-0c55-4c3e-9a51-4f0f3c0b7a10',
  sessionId: SESSION_ID,
  provider: 'claude',
  timestamp: '2026-11-09T10:01:00.000Z',
  content: 'and now the queued follow-up',
  isTurnPrompt: true,
  queuedMessageIds: ['q-1'],
  seq: 1,
  ...fields,
} as unknown as ServerEvent);

beforeEach(() => {
  historyRows = [...EARLIER_TURN];
  sessionMessages.mockReset();
  sessionMessages.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: { messages: historyRows, total: historyRows.length, hasMore: false } }),
  }));
  forgetSentQueuedMessages.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/** The session store, loaded with the session's history, and the realtime handler feeding it. */
async function renderViewedSession() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const { useChatRealtimeHandlers } = await import('@/modules/chat/hooks/useChatRealtimeHandlers');

  let listener: ((event: ServerEvent) => void) | null = null;
  const processing: string[] = [];
  const steerOutcomes: Array<[string, string, string]> = [];
  const synced: string[] = [];

  const store = renderHook(() => useSessionStore());
  await act(async () => {
    await store.result.current.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: SESSION_ID } as ProjectSession,
    currentSessionId: SESSION_ID,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId) => { if (sessionId) processing.push(sessionId); },
    onSessionIdle: () => {},
    onSessionBackground: () => {},
    requestLatestMessages: async (sessionId) => { synced.push(sessionId); },
    sessionStore: store.result.current,
    onSteerOutcome: (sessionId, messageId, outcome) => { steerOutcomes.push([sessionId, messageId, outcome]); },
  }));

  const dispatch = (event: ServerEvent) => act(() => { listener?.(event); });
  const transcript = () => store.result.current.getMessages(SESSION_ID)
    .map((message) => `${message.role ?? message.kind}: ${message.content ?? ''}`);
  const refreshHistory = () => act(async () => {
    await store.result.current.fetchFromServer(SESSION_ID, { limit: 20, offset: 0 });
  });

  return { store, dispatch, transcript, refreshHistory, processing, steerOutcomes, synced };
}

describe('a turn the server starts while the session is open', () => {
  it('shows the prompt at once, then streams the reply under it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = await renderViewedSession();

    view.dispatch(turnPrompt());
    assert.deepEqual(view.transcript(), [
      'user: count slowly to three',
      'assistant: one, two, three',
      'user: and now the queued follow-up',
    ]);
    // Busy now, not at the next running-sessions poll; its queue card drops.
    assert.deepEqual(view.processing, [SESSION_ID]);
    assert.deepEqual(forgetSentQueuedMessages.mock.calls, [[SESSION_ID, ['q-1']]]);
    // Not a steered message, so the composer is not told one was delivered.
    assert.deepEqual(view.steerOutcomes, []);

    view.dispatch({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'PINE', seq: 2 } as ServerEvent);
    view.dispatch({ kind: 'stream_delta', sessionId: SESSION_ID, content: 'APPLE', seq: 3 } as ServerEvent);
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    // The streaming row, drawn as the assistant's reply in progress.
    assert.equal(view.transcript().at(-1), 'stream_delta: PINEAPPLE', 'the reply streams in below the prompt');

    view.dispatch({ kind: 'stream_end', sessionId: SESSION_ID, seq: 4 } as ServerEvent);
    view.dispatch({
      kind: 'text', role: 'assistant', id: 'live-a2', sessionId: SESSION_ID, provider: 'claude',
      timestamp: '2026-11-09T10:01:03.000Z', content: 'PINEAPPLE', seq: 5,
    } as unknown as ServerEvent);
    view.dispatch({ kind: 'complete', sessionId: SESSION_ID, exitCode: 0, success: true, seq: 6 } as ServerEvent);
    assert.deepEqual(view.synced, [SESSION_ID], 'the end of the turn syncs the transcript');

    // The persisted transcript now has the turn, under its own ids.
    historyRows = [
      ...EARLIER_TURN,
      historyRow('h-u2', 'user', 'and now the queued follow-up', '2026-11-09T10:01:01.000Z'),
      historyRow('h-a2', 'assistant', 'PINEAPPLE', '2026-11-09T10:01:03.500Z'),
    ];
    await view.refreshHistory();

    assert.deepEqual(view.transcript(), [
      'user: count slowly to three',
      'assistant: one, two, three',
      'user: and now the queued follow-up',
      'assistant: PINEAPPLE',
    ], 'the live prompt and reply give way to the persisted rows, with no second copy');
  });

  it('keeps the prompt on screen while the transcript does not have it yet', async () => {
    const view = await renderViewedSession();
    view.dispatch(turnPrompt());

    // A refresh that lands before the provider has written the turn.
    await view.refreshHistory();
    assert.deepEqual(view.transcript().slice(-1), ['user: and now the queued follow-up']);
  });

  it('is not duplicated when the history already holds the prompt it replays', async () => {
    // A reload mid-run: the history read finds the prompt persisted, then the
    // subscribe replays the run from its start.
    historyRows = [
      ...EARLIER_TURN,
      historyRow('h-u2', 'user', 'and now the queued follow-up', '2026-11-09T10:01:00.400Z'),
    ];
    const view = await renderViewedSession();

    view.dispatch(turnPrompt());
    assert.equal(view.transcript().filter((line) => line === 'user: and now the queued follow-up').length, 1);
  });

  it('does not retire an ordinary live user row the way it retires a prompt', async () => {
    historyRows = [
      ...EARLIER_TURN,
      historyRow('h-u2', 'user', 'steered in', '2026-11-09T10:01:00.400Z'),
    ];
    const view = await renderViewedSession();
    // A steered message's echo carries its transcript id; it is reconciled by
    // id, not by text, and is still reported to the composer as delivered.
    view.dispatch(turnPrompt({ id: 'h-u2', content: 'steered in', isTurnPrompt: undefined, queuedMessageIds: undefined }));
    assert.equal(view.transcript().filter((line) => line === 'user: steered in').length, 1);
    assert.deepEqual(view.steerOutcomes, [[SESSION_ID, 'h-u2', 'delivered']]);
    assert.deepEqual(view.processing, []);
  });
});

describe('the tab that sent the turn', () => {
  it('keeps one row when the prompt repeats its echo id', async () => {
    const view = await renderViewedSession();
    const echoId = 'local_1762682460000_abc123';

    act(() => {
      view.store.result.current.appendRealtime(SESSION_ID, {
        id: echoId, kind: 'text', role: 'user', content: 'typed here', provider: 'claude',
        sessionId: SESSION_ID, timestamp: '2026-11-09T10:01:00.000Z',
      });
    });
    view.dispatch(turnPrompt({ id: echoId, content: 'typed here', queuedMessageIds: undefined }));

    assert.equal(view.transcript().filter((line) => line === 'user: typed here').length, 1);
    assert.deepEqual(forgetSentQueuedMessages.mock.calls, []);
  });

  it('keeps one row when the prompt arrives before the echo is flushed', async () => {
    // A brand-new chat adds its echo only once the session id is known, which
    // can be after the run's first event.
    const view = await renderViewedSession();
    const echoId = 'local_1762682460000_new001';

    view.dispatch(turnPrompt({ id: echoId, content: 'first message', queuedMessageIds: undefined }));
    act(() => {
      view.store.result.current.appendRealtime(SESSION_ID, {
        id: echoId, kind: 'text', role: 'user', content: 'first message', provider: 'claude',
        sessionId: SESSION_ID, timestamp: '2026-11-09T10:01:00.100Z',
      });
    });

    assert.equal(view.transcript().filter((line) => line === 'user: first message').length, 1);
  });
});
