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

it('names the row and step a frozen page stopped in, and skips that row from then on', async () => {
  const first = await import('@/modules/chat/utils/scrollTrace');
  first.setScrollTraceEnabled(true);
  first.traceScroll('older:end', undefined, true);
  first.markScrollRow('row 48/129 ExitPlanMode(7834 chars)', '2026-10-13T02:49:55.899Z');
  first.markScrollStep('plan card: 7834 chars, streaming=false');
  first.markScrollStep('markdown: parsing (math=false)');
  // The page freezes here; the refresh that ends it fires no pagehide.
  vi.resetModules();
  const second = await import('@/modules/chat/utils/scrollTrace');
  const log = second.readScrollTrace().previous[0];
  expect(log).toMatch(/last row drawn: [\d.]+ row 48\/129 ExitPlanMode\(7834 chars\)/);
  expect(log).toMatch(/step [\d.]+ markdown: parsing \(math=false\)\n.*froze in this row/);
  expect(second.isRowSkipped('2026-10-13T02:49:55.899Z')).toBe(true);
  second.unskipRow('2026-10-13T02:49:55.899Z');
  expect(second.isRowSkipped('2026-10-13T02:49:55.899Z')).toBe(false);
});

it('does not skip a row that finished drawing', async () => {
  const first = await import('@/modules/chat/utils/scrollTrace');
  first.setScrollTraceEnabled(true);
  first.markScrollRow('row 3/10 text(20 chars)', '2026-10-13T00:00:00.000Z');
  first.markScrollStep('drawn; layout running');
  vi.resetModules();
  const second = await import('@/modules/chat/utils/scrollTrace');
  expect(second.isRowSkipped('2026-10-13T00:00:00.000Z')).toBe(false);
});

it('does not skip a row when the page was left normally', async () => {
  const first = await import('@/modules/chat/utils/scrollTrace');
  first.setScrollTraceEnabled(true);
  first.markScrollRow('row 3/10 text(20 chars)', '2026-10-13T00:00:00.000Z');
  window.dispatchEvent(new Event('pagehide'));
  vi.resetModules();
  const second = await import('@/modules/chat/utils/scrollTrace');
  expect(second.isRowSkipped('2026-10-13T00:00:00.000Z')).toBe(false);
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
