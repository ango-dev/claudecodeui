import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * "Every single time the prompt completes it plays the complete sound more
 * than once." A finished turn dings once: a `complete` this page has already
 * acted on (same `runId`) is ignored outright, and when the session is open in
 * several places only the page the server marked `playSound: true` plays —
 * every page still shows the title indicator.
 */

const SOUND = vi.hoisted(() => ({ plays: 0, titleIndicators: 0 }));

vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  playChatCompletionSound: async () => { SOUND.plays += 1; },
}));

vi.mock('@/modules/chat/utils/pageTitleNotification', () => ({
  showCompletionTitleIndicator: () => { SOUND.titleIndicators += 1; },
}));

const SESSION_ID = 'viewed-session';

beforeEach(() => {
  SOUND.plays = 0;
  SOUND.titleIndicators = 0;
});

/** One page: the realtime handler with a listener the test feeds frames into. */
const renderPage = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const stored: NormalizedMessage[] = [];
  const idled: string[] = [];
  const syncs: string[] = [];

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
    onSessionProcessing: () => {},
    onSessionIdle: (sessionId) => { if (sessionId) idled.push(sessionId); },
    onSessionBackground: (sessionId) => { idled.push(sessionId); },
    requestLatestMessages: async (sessionId) => { syncs.push(sessionId); },
    sessionStore: {
      appendRealtime: (_sessionId: string, message: NormalizedMessage) => { stored.push(message); },
      getMessages: () => stored,
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  const dispatch = (event: ServerEvent) => listener?.(event);
  return { dispatch, idled, syncs };
};

const complete = (fields: Record<string, unknown> = {}): ServerEvent => ({
  kind: 'complete',
  id: `complete-${Math.random()}`,
  sessionId: SESSION_ID,
  provider: 'claude',
  timestamp: '2026-11-10T10:00:00.000Z',
  exitCode: 0,
  success: true,
  seq: 4,
  runId: 'run-1',
  playSound: true,
  ...fields,
} as unknown as ServerEvent);

test('a complete that reaches the page twice plays the sound once and settles the session once', () => {
  const { dispatch, idled, syncs } = renderPage();

  dispatch(complete());
  dispatch(complete());

  assert.equal(SOUND.plays, 1);
  assert.equal(SOUND.titleIndicators, 1);
  assert.deepEqual(idled, [SESSION_ID]);
  assert.deepEqual(syncs, [SESSION_ID]);
});

test('a replayed complete of an earlier run is ignored after a newer run ended', () => {
  const { dispatch } = renderPage();

  dispatch(complete({ runId: 'run-1' }));
  dispatch(complete({ runId: 'run-2' }));
  dispatch(complete({ runId: 'run-1' }));

  assert.equal(SOUND.plays, 2, 'one per finished turn');
});

test('each finished turn dings, even when every run restarts its seq', () => {
  const { dispatch } = renderPage();

  for (const runId of ['run-1', 'run-2', 'run-3']) {
    dispatch(complete({ runId, seq: 4 }));
  }

  assert.equal(SOUND.plays, 3);
});

test('a page the server did not choose shows the indicator but stays silent', () => {
  const { dispatch, idled } = renderPage();

  dispatch(complete({ playSound: false }));

  assert.equal(SOUND.plays, 0);
  assert.equal(SOUND.titleIndicators, 1);
  assert.deepEqual(idled, [SESSION_ID], 'the turn still settles');
});

test('two tabs on one session: the turn dings once, in the tab the server chose', () => {
  const front = renderPage();
  const background = renderPage();

  // The same run's `complete`, as each socket received it.
  front.dispatch(complete({ playSound: true }));
  background.dispatch(complete({ playSound: false }));

  assert.equal(SOUND.plays, 1);
  assert.equal(SOUND.titleIndicators, 2);
});

test('a complete without a run id or a sound choice still plays, as it always did', () => {
  const { dispatch } = renderPage();

  dispatch(complete({ runId: undefined, playSound: undefined }));

  assert.equal(SOUND.plays, 1);
});

test('failed and aborted turns stay silent', () => {
  const { dispatch } = renderPage();

  dispatch(complete({ runId: 'run-failed', success: false }));
  dispatch(complete({ runId: 'run-aborted', aborted: true }));

  assert.equal(SOUND.plays, 0);
});
