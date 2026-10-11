import { useEffect } from 'react';
import type { RefObject } from 'react';

/** A scroll quieter than this long has ended, momentum included. */
const SCROLL_IDLE_MS = 150;
/** Within this distance of the bottom the transcript follows new output instead. */
const NEAR_BOTTOM_PX = 50;

type Anchor = { row: Element; offset: number };

const supportsNativeScrollAnchoring = (): boolean =>
  typeof CSS !== 'undefined'
  && typeof CSS.supports === 'function'
  && CSS.supports('overflow-anchor', 'auto');

/**
 * Used by useChatSessionState, which leaves keeping the reader's place after a
 * page of older messages to this fallback wherever it runs.
 */
export const usesScrollAnchorFallback = (): boolean =>
  typeof ResizeObserver !== 'undefined' && !supportsNativeScrollAnchoring();

/**
 * The first transcript row still on screen (its bottom below the container's
 * top). Rows are in vertical order, so a binary search keeps this cheap on
 * long transcripts.
 */
function findAnchor(container: HTMLElement, content: HTMLElement): Anchor | null {
  const rows = content.querySelectorAll(':scope > [data-message-timestamp]');
  if (rows.length === 0) return null;
  const containerTop = container.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom > containerTop) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const row = rows[low];
  return { row, offset: row.getBoundingClientRect().top - containerTop };
}

/**
 * Used by ChatMessagesPane to keep what the reader is looking at in place when
 * rows above it change height: older rows mounting with their real height,
 * a prepended page settling, the loading row coming and going.
 *
 * Chrome and Firefox do this themselves (CSS scroll anchoring), so there it is
 * a no-op; Safari, and so every iOS browser, has no scroll anchoring, and each
 * of those changes pushed the transcript up or down under the reader's thumb.
 *
 * Setting scrollTop mid-fling stops iOS momentum scrolling, so while a scroll
 * is still moving the shift is cancelled with a transform on the content, and
 * folded into scrollTop once the scroll comes to rest; the two cancel out, so
 * nothing on screen moves either time.
 */
export function useScrollAnchorFallback(
  scrollContainerRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
) {
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content || !usesScrollAnchorFallback()) {
      return undefined;
    }

    let anchor: Anchor | null = null;
    let wasNearBottom = true;
    let isTouching = false;
    let lastScrollAt = 0;
    // Shift absorbed by the transform and not yet moved into scrollTop.
    let pendingShift = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const recordAnchor = () => {
      anchor = findAnchor(container, content);
      wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
    };

    const flushPendingShift = () => {
      if (pendingShift === 0) return;
      content.style.transform = '';
      container.scrollTop += pendingShift;
      pendingShift = 0;
      recordAnchor();
    };

    const scheduleFlush = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (isTouching || Date.now() - lastScrollAt < SCROLL_IDLE_MS) {
          scheduleFlush();
          return;
        }
        flushPendingShift();
      }, SCROLL_IDLE_MS);
    };

    const handleScroll = () => {
      lastScrollAt = Date.now();
      recordAnchor();
      if (pendingShift !== 0) scheduleFlush();
    };
    const handleTouchStart = () => { isTouching = true; };
    const handleTouchEnd = () => {
      isTouching = false;
      if (pendingShift !== 0) scheduleFlush();
    };

    const resizeObserver = new ResizeObserver(() => {
      // At the bottom the transcript is following new output, which the chat
      // state already scrolls to; holding a row in place would fight it.
      if (wasNearBottom || !anchor?.row.isConnected) {
        recordAnchor();
        return;
      }
      const offset = anchor.row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      const shift = offset - anchor.offset;
      if (Math.abs(shift) < 0.5) return;

      const isScrolling = isTouching || Date.now() - lastScrollAt < SCROLL_IDLE_MS;
      if (isScrolling) {
        pendingShift += shift;
        content.style.transform = `translateY(${-pendingShift}px)`;
        scheduleFlush();
      } else {
        container.scrollTop += shift;
      }
      recordAnchor();
    });

    recordAnchor();
    resizeObserver.observe(content);
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      if (idleTimer) clearTimeout(idleTimer);
      content.style.transform = '';
    };
  }, [scrollContainerRef, contentRef]);
}
