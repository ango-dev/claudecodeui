import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

/**
 * A message that froze the page while drawing (scroll diagnostics) is held
 * behind a button on the next load, so the session can be read past it.
 */
it('holds a row that froze the page behind "Draw it anyway"', async () => {
  localStorage.setItem('cloudcli-scroll-trace-skipped', JSON.stringify([{ timestamp: '2026-10-13T02:49:55.899Z', label: 'plan' }]));
  vi.resetModules();
  const { default: LazyMessageRow } = await import('@/modules/chat/transcript/LazyMessageRow');

  render(
    <>
      <LazyMessageRow lazyRows={null} timestamp="2026-10-13T02:49:55.899Z" initiallyNearViewport>
        <p>the plan</p>
      </LazyMessageRow>
      <LazyMessageRow lazyRows={null} timestamp="2026-10-13T02:50:00.000Z" initiallyNearViewport>
        <p>the next reply</p>
      </LazyMessageRow>
    </>,
  );
  expect(screen.queryByText('the plan')).toBeNull();
  expect(screen.getByText('the next reply')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Draw it anyway' }));
  expect(screen.getByText('the plan')).toBeTruthy();
  expect(localStorage.getItem('cloudcli-scroll-trace-skipped')).toBeNull();
  localStorage.clear();
});
