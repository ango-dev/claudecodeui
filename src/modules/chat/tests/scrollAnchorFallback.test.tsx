import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { fireEvent, render } from '@testing-library/react';

import { useScrollAnchorFallback } from '@/modules/chat/hooks/useScrollAnchorFallback';

/**
 * jsdom has neither ResizeObserver nor scroll anchoring (as in Safari), so a
 * stub stands in and its callback is fired by hand after "a row above grew".
 */
let resizeCallback: (() => void) | null = null;
class StubResizeObserver {
  constructor(callback: () => void) { resizeCallback = callback; }
  observe(): void {}
  disconnect(): void {}
}

/** Where the first row's top sits, relative to the container's top. */
let firstRowTop = -20;

function Harness() {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useScrollAnchorFallback(scrollContainerRef, contentRef);
  return (
    <div ref={scrollContainerRef} data-testid="container">
      <div ref={contentRef} data-testid="content">
        <div data-message-timestamp="1" data-testid="row" />
        <div data-message-timestamp="2" />
      </div>
    </div>
  );
}

function renderTranscript() {
  // Construct-time geometry: scrolled up from the bottom, first row on screen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.testid === 'row' ? firstRowTop : this.dataset.messageTimestamp ? firstRowTop + 100 : 0;
    return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(3000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const view = render(<Harness />);
  const container = view.getByTestId('container');
  container.scrollTop = 500;
  fireEvent.scroll(container);
  return { container, content: view.getByTestId('content') };
}

describe('useScrollAnchorFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    firstRowTop = -20;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resizeCallback = null;
  });

  it('keeps the row on screen in place when something above it grows', () => {
    const { container } = renderTranscript();
    vi.advanceTimersByTime(500); // the scroll has come to rest

    firstRowTop += 80;
    resizeCallback?.();

    expect(container.scrollTop).toBe(580);
  });

  it('holds the shift in a transform mid-scroll and moves it into scrollTop once the scroll rests', () => {
    const { container, content } = renderTranscript();

    firstRowTop += 60;
    resizeCallback?.();

    // Setting scrollTop now would stop an iOS fling.
    expect(container.scrollTop).toBe(500);
    expect(content.style.transform).toBe('translateY(-60px)');

    vi.advanceTimersByTime(400);
    expect(container.scrollTop).toBe(560);
    expect(content.style.transform).toBe('');
  });

  it('takes over on Safari even where Safari reports scroll anchoring of its own', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    const { container } = renderTranscript();
    vi.advanceTimersByTime(500);

    expect(container.style.overflowAnchor).toBe('none');
    firstRowTop += 80;
    resizeCallback?.();
    expect(container.scrollTop).toBe(580);
  });

  it('leaves browsers with working scroll anchoring to it', () => {
    vi.stubGlobal('CSS', { supports: () => true });
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Google Inc.');
    renderTranscript();

    expect(resizeCallback).toBeNull();
  });

  it('leaves a transcript that is following new output at the bottom alone', () => {
    const { container } = renderTranscript();
    container.scrollTop = 2400; // 3000 - 600: at the bottom
    fireEvent.scroll(container);
    vi.advanceTimersByTime(500);

    firstRowTop += 80;
    resizeCallback?.();

    expect(container.scrollTop).toBe(2400);
  });
});
