import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * The scroll recorder has to outlive a frozen page: what it caught must still
 * be readable after the refresh that ends the freeze.
 */

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(async () => {
  const trace = await import('@/modules/chat/utils/scrollTrace');
  trace.setScrollTraceEnabled(false);
});

it('records nothing while off', async () => {
  const trace = await import('@/modules/chat/utils/scrollTrace');
  trace.traceScroll('older:start', { top: 10 }, true);
  expect(trace.readScrollTrace().current).toBe('');
});

it('keeps the log of the page before a refresh, and resumes recording after it', async () => {
  const first = await import('@/modules/chat/utils/scrollTrace');
  first.setScrollTraceEnabled(true);
  first.traceScroll('older:start', { top: 12.34, holds: true }, true);
  expect(first.readScrollTrace().current).toMatch(/older:start top=12.3 holds=true/);

  // A refresh: the module loads again on a new page.
  vi.resetModules();
  const second = await import('@/modules/chat/utils/scrollTrace');
  expect(second.isScrollTraceEnabled()).toBe(true);
  const { current, previous } = second.readScrollTrace();
  expect(previous[0]).toMatch(/older:start top=12.3/);
  expect(current).not.toMatch(/older:start/);
});

it('keeps the last three pages, so refreshing twice after a freeze does not lose it', async () => {
  const first = await import('@/modules/chat/utils/scrollTrace');
  first.setScrollTraceEnabled(true);
  first.traceScroll('frozen-here', undefined, true);
  for (let page = 0; page < 3; page++) {
    vi.resetModules();
    await import('@/modules/chat/utils/scrollTrace');
  }
  const last = await import('@/modules/chat/utils/scrollTrace');
  const { previous } = last.readScrollTrace();
  expect(previous).toHaveLength(3);
  expect(previous[2]).toMatch(/frozen-here/);
});

it('reports busy paths as per-second counts', async () => {
  vi.useFakeTimers();
  try {
    const trace = await import('@/modules/chat/utils/scrollTrace');
    trace.setScrollTraceEnabled(true);
    for (let i = 0; i < 5; i++) trace.countScroll('row-mount');
    vi.advanceTimersByTime(1200);
    expect(trace.readScrollTrace().current).toMatch(/per-second row-mount=5/);
  } finally {
    vi.useRealTimers();
  }
});
