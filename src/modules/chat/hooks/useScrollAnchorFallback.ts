import { useEffect } from 'react';
import type { RefObject } from 'react';

/** A scroll quieter than this long has ended, momentum included. */
const SCROLL_IDLE_MS = 150;
/** Within this distance of the bottom the transcript follows new output instead. */
const NEAR_BOTTOM_PX = 50;

type Anchor = { row: Element; timestamp: string | null; offset: number };

const supportsNativeScrollAnchoring = (): boolean =>
  typeof CSS !== 'undefined'
  && typeof CSS.supports === 'function'
  && CSS.supports('overflow-anchor', 'auto');

/**
 * Safari, and so every iOS and iPadOS browser. Its own scroll anchoring, where
 * it has any, did not keep the transcript still, so it is not relied on.
 */
const isAppleWebKit = (): boolean =>
  typeof navigator !== 'undefined' && /^Apple/.test(navigator.vendor ?? '');

/**
 * Used by ChatMessagesPane, which renders rows before measuring them wherever
 * this fallback runs, so that no estimated height has to be corrected.
 */
export const usesScrollAnchorFallback = (): boolean =>
  typeof ResizeObserver !== 'undefined' && (isAppleWebKit() || !supportsNativeScrollAnchoring());

type ScrollActivity = { isAtRest: () => boolean; restWaiters: Array<() => void>; requestRestCheck: () => void };

/** Per transcript scroller, while the fallback runs on it. */
const scrollActivityByContainer = new WeakMap<HTMLElement, ScrollActivity>();

/**
 * Used by useChatSessionState to add a page of older messages only once the
 * transcript has stopped moving: correcting for it then is invisible, where
 * mid-fling it either stops iOS momentum or has to be held back. Resolves at
 * once where the fallback does not run.
 */
export function waitForScrollRest(container: HTMLElement): Promise<void> {
  const activity = scrollActivityByContainer.get(container);
  if (!activity || activity.isAtRest()) return Promise.resolve();
  return new Promise((resolve) => {
    activity.restWaiters.push(resolve);
    activity.requestRestCheck();
  });
}

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
  return {
    row,
    timestamp: row.getAttribute('data-message-timestamp'),
    offset: row.getBoundingClientRect().top - containerTop,
  };
}

/**
 * The anchor row as it is now. Older messages arriving can re-key, and so
 * remount, the rows already on screen; the same message is then found again
 * by its timestamp.
 */
function resolveAnchorRow(content: HTMLElement, anchor: Anchor): Element | null {
  if (anchor.row.isConnected) return anchor.row;
  if (!anchor.timestamp) return null;
  return content.querySelector(`:scope > [data-message-timestamp="${CSS.escape(anchor.timestamp)}"]`);
}

/**
 * Used by ChatMessagesPane to keep what the reader is looking at in place when
 * rows above it change height: older rows mounting with their real height,
 * a prepended page settling, the loading row coming and going.
 *
 * Chrome and Firefox do this themselves (CSS scroll anchoring), so there it is
 * a no-op. Safari long had no scroll anchoring, and its newer one still let
 * each of those changes push the transcript up or down under the reader's
 * thumb, so on Safari this takes over and the browser's own is switched off
 * for the transcript; two corrections for one shift would be a jump again.
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

    container.style.overflowAnchor = 'none';
    // Turns off estimated message heights for this transcript (index.css).
    container.dataset.scrollAnchorFallback = '';
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

    const isScrolling = () => isTouching || Date.now() - lastScrollAt < SCROLL_IDLE_MS;
    const restWaiters: Array<() => void> = [];

    const scheduleFlush = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (isScrolling()) {
          scheduleFlush();
          return;
        }
        flushPendingShift();
        for (const resolve of restWaiters.splice(0)) resolve();
      }, SCROLL_IDLE_MS);
    };

    scrollActivityByContainer.set(container, {
      isAtRest: () => !isScrolling() && pendingShift === 0,
      restWaiters,
      requestRestCheck: scheduleFlush,
    });

    const handleScroll = () => {
      lastScrollAt = Date.now();
      recordAnchor();
      if (pendingShift !== 0 || restWaiters.length > 0) scheduleFlush();
    };
    const handleTouchStart = () => { isTouching = true; };
    const handleTouchEnd = () => {
      isTouching = false;
      if (pendingShift !== 0 || restWaiters.length > 0) scheduleFlush();
    };

    const resizeObserver = new ResizeObserver(() => {
      // A hidden Chat tab measures as zero; that says nothing about the rows.
      if (container.clientHeight === 0) {
        anchor = null;
        return;
      }
      // At the bottom the transcript is following new output, which the chat
      // state already scrolls to; holding a row in place would fight it.
      const anchorRow = anchor ? resolveAnchorRow(content, anchor) : null;
      if (wasNearBottom || !anchor || !anchorRow) {
        recordAnchor();
        return;
      }
      const offset = anchorRow.getBoundingClientRect().top - container.getBoundingClientRect().top;
      const shift = offset - anchor.offset;
      if (Math.abs(shift) < 0.5) return;

      if (isScrolling()) {
        pendingShift += shift;
        content.style.transform = `translateY(${-pendingShift}px)`;
        scheduleFlush();
      } else {
        container.scrollTop += shift;
      }
      recordAnchor();
    });

    // Everything in the scroller that can move the rows: the rows themselves,
    // and what sits above them (the background-tasks strip comes and goes).
    const observeScrollerChildren = () => {
      for (const child of Array.from(container.children)) resizeObserver.observe(child);
    };
    const childListObserver = new MutationObserver(observeScrollerChildren);

    recordAnchor();
    observeScrollerChildren();
    childListObserver.observe(container, { childList: true });
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      resizeObserver.disconnect();
      childListObserver.disconnect();
      scrollActivityByContainer.delete(container);
      for (const resolve of restWaiters.splice(0)) resolve();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      if (idleTimer) clearTimeout(idleTimer);
      content.style.transform = '';
      container.style.overflowAnchor = '';
      delete container.dataset.scrollAnchorFallback;
    };
  }, [scrollContainerRef, contentRef]);
}
