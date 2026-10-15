import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * Safari starts on the next older page several screens before the first
 * loaded message, so a fling up finds it in place (it lands in the space kept
 * above, see olderSpacerRef) instead of bouncing at the top.
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});


async function renderAt(scrollTop: number) {
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
  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollHeight', { get: () => 20000 });
  Object.defineProperty(container, 'clientHeight', { get: () => 800 });
  Object.defineProperty(container, 'scrollTop', { get: () => scrollTop, set: () => undefined });
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  act(() => { void result.current.handleScroll(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  return store;
}

it('starts the next older page several screens before the top on Safari', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
  expect((await renderAt(2500)).fetchMore).toHaveBeenCalledTimes(1);
});

it('keeps the one-screen lead where pages are added at once', async () => {
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Google Inc.');
  expect((await renderAt(2500)).fetchMore).not.toHaveBeenCalled();
  expect((await renderAt(700)).fetchMore).toHaveBeenCalledTimes(1);
});

it('shows loaded but hidden older messages a page at a time on Safari', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
  // Everything is loaded ("Load all"), more than the window shows.
  const loaded = Array.from({ length: 300 }, (_, index) => ({
    ...messages[0],
    id: `m-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 300, hasMore: false, offset: 300 };
  const store = { ...createStore(), getMessages: vi.fn(() => loaded), fetchFromServer: vi.fn(async () => slot), getSessionSlot: vi.fn(() => slot) };
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
  const shownBefore = result.current.visibleMessageCount;
  expect(shownBefore).toBeLessThan(300);

  const container = document.createElement('div');
  Object.defineProperty(container, 'scrollHeight', { get: () => 20000 });
  Object.defineProperty(container, 'clientHeight', { get: () => 800 });
  Object.defineProperty(container, 'scrollTop', { get: () => 1000, set: () => undefined });
  (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container;
  (result.current.olderSpacerRef as { current: HTMLDivElement | null }).current = document.createElement('div');

  await act(async () => { await result.current.handleScroll(); });
  expect(result.current.visibleMessageCount).toBe(shownBefore + 50);
  expect(store.fetchMore).not.toHaveBeenCalled();
});
