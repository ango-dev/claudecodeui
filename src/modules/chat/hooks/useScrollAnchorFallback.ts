import { useEffect, useRef } from 'react';
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
 * Safari, and so every iOS and iPadOS browser. Its own scroll anchoring, where
 * it has any, did not keep the transcript still, so it is not relied on.
 */
const isAppleWebKit = (): boolean =>
  typeof navigator !== 'undefined' && /^Apple/.test(navigator.vendor ?? '');

/**
 * Used by useChatSessionState, which leaves keeping the reader's place after a
 * page of older messages to this fallback wherever it runs.
 */
export const usesScrollAnchorFallback = (): boolean =>
  typeof ResizeObserver !== 'undefined' && (isAppleWebKit() || !supportsNativeScrollAnchoring());

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
 * Spare space kept above the transcript while older messages remain to load,
 * at least this much and four screens. Shifts above the reader are absorbed by
 * resizing it, so a whole page of older messages arriving moves nothing.
 */
const MIN_SLACK_PX = 4000;
const SCREENS_OF_SLACK = 4;

/**
 * Used by useChatSessionState to measure scroll distances from the top of the
 * loaded transcript rather than from the spare space above it.
 */
export function readScrollSlack(container: HTMLElement): number {
  return container.querySelector<HTMLElement>(':scope [data-scroll-slack]')?.offsetHeight ?? 0;
}

/**
 * Used by ChatMessagesPane to keep what the reader is looking at in place when
 * rows above it change height: older rows mounting with their real height,
 * a page of older messages arriving, the loading row coming and going.
 *
 * Chrome and Firefox do this themselves (CSS scroll anchoring), so there it is
 * a no-op. Safari long had no scroll anchoring, and its newer one still let
 * each of those changes push the transcript up or down under the reader's
 * thumb, so on Safari this takes over and the browser's own is switched off
 * for the transcript; two corrections for one shift would be a jump again.
 *
 * A shift is first absorbed by the spare space (`slackRef`, an empty element
 * above the rows): it gives up or takes on exactly the height the rows gained
 * or lost, so neither scrollTop nor anything on screen changes. Setting
 * scrollTop mid-fling stops iOS momentum scrolling, so what the spare space
 * cannot take while a scroll is moving is held in a transform on the content,
 * and folded into scrollTop once the scroll comes to rest, when the spare
 * space is also topped back up; both changes cancel out on screen.
 */
export function useScrollAnchorFallback(
  scrollContainerRef: RefObject<HTMLDivElement>,
  contentRef: RefObject<HTMLDivElement>,
  slackRef: RefObject<HTMLDivElement>,
  hasOlderMessages: boolean,
) {
  const hasOlderMessagesRef = useRef(hasOlderMessages);
  const requestSettleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    const slackElement = slackRef.current;
    if (!container || !content || !slackElement || !usesScrollAnchorFallback()) {
      return undefined;
    }

    container.style.overflowAnchor = 'none';
    let anchor: Anchor | null = null;
    let wasNearBottom = true;
    let isTouching = false;
    let lastScrollAt = 0;
    let slack = 0;
    // Shift absorbed by the transform and not yet moved into scrollTop.
    let pendingShift = 0;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const recordAnchor = () => {
      anchor = findAnchor(container, content);
      wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
    };

    const setSlack = (height: number) => {
      slack = height;
      slackElement.style.height = height > 0 ? `${height}px` : '';
    };

    const isScrolling = () => isTouching || Date.now() - lastScrollAt < SCROLL_IDLE_MS;

    /** Runs once a scroll has come to rest: nothing on screen moves. */
    const settle = () => {
      let scrollChange = pendingShift;
      if (pendingShift !== 0) {
        content.style.transform = '';
        pendingShift = 0;
      }
      const targetSlack = hasOlderMessagesRef.current
        ? Math.max(MIN_SLACK_PX, container.clientHeight * SCREENS_OF_SLACK)
        : 0;
      // Topped up when running low (or gone when nothing is left to load);
      // not on every rest, as each top-up is a scrollTop write.
      if ((targetSlack === 0 && slack > 0) || slack < targetSlack / 2 || slack > targetSlack * 2) {
        scrollChange += targetSlack - slack;
        setSlack(targetSlack);
      }
      if (scrollChange !== 0) {
        container.scrollTop += scrollChange;
      }
      recordAnchor();
    };

    const scheduleSettle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (isScrolling()) {
          scheduleSettle();
          return;
        }
        settle();
      }, SCROLL_IDLE_MS);
    };
    requestSettleRef.current = scheduleSettle;

    const handleScroll = () => {
      lastScrollAt = Date.now();
      recordAnchor();
      scheduleSettle();
    };
    const handleTouchStart = () => { isTouching = true; };
    const handleTouchEnd = () => {
      isTouching = false;
      scheduleSettle();
    };

    const resizeObserver = new ResizeObserver(() => {
      // A hidden Chat tab measures as zero; that says nothing about the rows.
      if (container.clientHeight === 0) {
        anchor = null;
        return;
      }
      // At the bottom the transcript is following new output, which the chat
      // state already scrolls to; holding a row in place would fight it.
      if (wasNearBottom || !anchor?.row.isConnected) {
        recordAnchor();
        return;
      }
      const offset = anchor.row.getBoundingClientRect().top - container.getBoundingClientRect().top;
      let shift = offset - anchor.offset;
      if (Math.abs(shift) < 0.5) return;

      // Rows above grew (shift > 0) or shrank: the spare space takes the
      // difference, as far as it has room.
      const absorbed = Math.min(shift, slack);
      setSlack(slack - absorbed);
      shift -= absorbed;

      if (Math.abs(shift) >= 0.5) {
        if (isScrolling()) {
          pendingShift += shift;
          content.style.transform = `translateY(${-pendingShift}px)`;
        } else {
          container.scrollTop += shift;
        }
      }
      scheduleSettle();
      recordAnchor();
    });

    // Everything in the scroller that can move the rows: the rows themselves,
    // and what sits above them (the background-tasks strip comes and goes).
    const observeScrollerChildren = () => {
      for (const child of Array.from(container.children)) {
        if (child !== slackElement) resizeObserver.observe(child);
      }
    };
    const childListObserver = new MutationObserver(observeScrollerChildren);

    recordAnchor();
    scheduleSettle();
    observeScrollerChildren();
    childListObserver.observe(container, { childList: true });
    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    return () => {
      requestSettleRef.current = null;
      resizeObserver.disconnect();
      childListObserver.disconnect();
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
      if (idleTimer) clearTimeout(idleTimer);
      content.style.transform = '';
      container.style.overflowAnchor = '';
      slackElement.style.height = '';
    };
  }, [scrollContainerRef, contentRef, slackRef]);

  // Older messages running out (or appearing) changes how much spare space
  // the transcript keeps; the change waits for the scroll to rest.
  useEffect(() => {
    hasOlderMessagesRef.current = hasOlderMessages;
    requestSettleRef.current?.();
  }, [hasOlderMessages]);
}
