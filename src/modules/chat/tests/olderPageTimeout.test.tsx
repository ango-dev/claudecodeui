import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * "Loading older messages" must never outlive its page: a page that does not
 * arrive in time is given up on, so the reader is never left with a spinner
 * that only a refresh clears.
 */

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION = 'session-a';
const project: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false };
const session = { id: SESSION, __provider: 'claude' } as unknown as ProjectSession;
const messages = Array.from({ length: 4 }, (_, index) => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: SESSION,
  content: `message ${index}`,
  timestamp: `2026-01-01T00:00:0${index}.000Z`,
} as NormalizedMessage));

function createStore() {
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 200, hasMore: true, offset: messages.length };
  return {
    fetchFromServer: vi.fn(async () => slot),
    // The older page never arrives.
    fetchMore: vi.fn(() => new Promise<never>(() => undefined)),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async () => ({ slot, applied: true, changed: false, deferred: false })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => messages),
    getSessionSlot: vi.fn(() => slot),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

it('stops showing "Loading older messages" when the page never arrives', async () => {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  const store = createStore();
  const { result } = renderHook(() => useChatSessionState({
    isActive: true,
    selectedProject: project,
    selectedSession: session,
    ws: null,
    sendMessage: vi.fn(),
    resetStreamingState: vi.fn(),
    statusCheckSentAtRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    sessionStore: store as never,
  }));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(result.current.hasMoreMessages).toBe(true);

  // Scrolled to the top of what is loaded.
  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollHeight', { get: () => 2000 });
  Object.defineProperty(container, 'clientHeight', { get: () => 800 });
  Object.defineProperty(container, 'scrollTop', { get: () => 0, set: () => undefined });
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;

  act(() => { void result.current.handleScroll(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(store.fetchMore).toHaveBeenCalledTimes(1);
  expect(result.current.isLoadingMoreMessages).toBe(true);

  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(result.current.isLoadingMoreMessages).toBe(false);
});
