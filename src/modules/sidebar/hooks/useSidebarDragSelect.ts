import { useEffect, useRef } from 'react';

import type { SidebarSessionSelection } from '@/shared/types';

/**
 * How far a finger moves before the gesture is decided: sideways selects, up
 * or down scrolls. Below iOS's own ~10pt scroll threshold, so the decision
 * lands before Safari starts a scroll that a page can no longer stop.
 */
const START_DISTANCE_PX = 6;
/** A finger resting this long on a row starts selecting too, whichever way it then slides. */
const HOLD_MS = 300;
/** Within this distance of the list's top or bottom edge, the list scrolls under the finger. */
const EDGE_PX = 48;
/** The fastest the list scrolls at its very edge, in pixels per frame. */
const MAX_SCROLL_PER_FRAME = 14;

/**
 * The attributes a selectable row carries for drag selection: its list
 * (scope) and its id. Used by the sidebar's session rows (SidebarSessionItem,
 * SidebarRecentConversations and the Archive tab in SidebarContent).
 */
export const dragSelectRowProps = (scopeId: string, sessionId: string) => ({
  'data-select-scope': scopeId,
  'data-select-id': sessionId,
});

type UseSidebarDragSelectArgs = {
  scopeId: string;
  /** Rows that can be ticked, in display order: a drag covers the rows between where it started and the finger. */
  selectableIds: string[];
  selectedIds: ReadonlySet<string> | null;
  onSetSelection: (selection: SidebarSessionSelection) => void;
};

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  startId: string;
  /** The row the finger came down on; the list scrolled while selecting is its scroll container. */
  startRow: Element;
  /** Undecided until the finger moves or rests: sideways or resting selects; anything else is left to the browser (scroll, tap). */
  phase: 'pending' | 'selecting' | 'ignored';
  /** Ticking or unticking: the opposite of the first row's state, as in iOS. */
  mode: 'select' | 'deselect';
  /** The selection before the drag, which the dragged-over range is applied to. */
  base: Set<string>;
  lastX: number;
  lastY: number;
  scroller: HTMLElement | null;
};

function scrollableAncestor(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Used by useSidebarBulkSelection for touch screens in select mode: put a
 * finger on a row and either move it sideways or rest it a moment, then slide
 * up or down, and every row passed is ticked (or unticked, when the first row
 * already was), as in iOS Photos and Files. A gesture that starts vertically
 * scrolls as usual and a tap still toggles one row; holding near the list's
 * edge scrolls it.
 */
export function useSidebarDragSelect({ scopeId, selectableIds, selectedIds, onSetSelection }: UseSidebarDragSelectArgs) {
  const isSelecting = selectedIds !== null;
  // The live list and selection, read by listeners that stay registered for the whole selection.
  const stateRef = useRef({ scopeId, selectableIds, selectedIds, onSetSelection });
  useEffect(() => {
    stateRef.current = { scopeId, selectableIds, selectedIds, onSetSelection };
  });

  useEffect(() => {
    if (!isSelecting) {
      return undefined;
    }
    let drag: Drag | null = null;
    let frame = 0;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const rowAt = (x: number, y: number): Element | null => {
      const row = document.elementFromPoint(x, y)?.closest('[data-select-id]') ?? null;
      return row && row.getAttribute('data-select-scope') === stateRef.current.scopeId ? row : null;
    };
    const rowIdAt = (x: number, y: number): string | null => rowAt(x, y)?.getAttribute('data-select-id') ?? null;

    const applyRange = (endId: string) => {
      if (!drag) return;
      const { selectableIds: order, scopeId: scope, onSetSelection: setSelection } = stateRef.current;
      const from = order.indexOf(drag.startId);
      const to = order.indexOf(endId);
      if (from === -1 || to === -1) return;
      const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
      const next = new Set(drag.base);
      for (const id of range) {
        if (drag.mode === 'select') next.add(id);
        else next.delete(id);
      }
      setSelection({ projectId: scope, sessionIds: next });
    };

    // While the finger rests near an edge, the list keeps scrolling and the row under it keeps joining.
    const autoScroll = () => {
      frame = 0;
      if (!drag || drag.phase !== 'selecting' || !drag.scroller) return;
      const bounds = drag.scroller.getBoundingClientRect();
      const overTop = bounds.top + EDGE_PX - drag.lastY;
      const overBottom = drag.lastY - (bounds.bottom - EDGE_PX);
      const step = overTop > 0
        ? -Math.ceil((Math.min(overTop, EDGE_PX) / EDGE_PX) * MAX_SCROLL_PER_FRAME)
        : overBottom > 0
          ? Math.ceil((Math.min(overBottom, EDGE_PX) / EDGE_PX) * MAX_SCROLL_PER_FRAME)
          : 0;
      if (step === 0) return;
      drag.scroller.scrollTop += step;
      const id = rowIdAt(drag.lastX, Math.min(Math.max(drag.lastY, bounds.top + 1), bounds.bottom - 1));
      if (id) applyRange(id);
      frame = requestAnimationFrame(autoScroll);
    };

    const startSelecting = () => {
      if (!drag) return;
      drag.phase = 'selecting';
      drag.scroller = scrollableAncestor(drag.startRow);
    };

    const handleTouchStart = (event: TouchEvent) => {
      clearHold();
      if (event.touches.length !== 1) {
        drag = null;
        return;
      }
      const touch = event.touches[0];
      const startRow = rowAt(touch.clientX, touch.clientY);
      const startId = startRow?.getAttribute('data-select-id');
      if (!startRow || !startId || !stateRef.current.selectableIds.includes(startId)) {
        drag = null;
        return;
      }
      const base = new Set(stateRef.current.selectedIds ?? []);
      drag = {
        pointerId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startId,
        startRow,
        phase: 'pending',
        mode: base.has(startId) ? 'deselect' : 'select',
        base,
        lastX: touch.clientX,
        lastY: touch.clientY,
        scroller: null,
      };
      // Press and hold, then slide: the first row ticks at once, as feedback.
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (drag?.phase !== 'pending') return;
        startSelecting();
        applyRange(drag.startId);
      }, HOLD_MS);
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (!drag || drag.phase === 'ignored') return;
      const touch = Array.from(event.touches).find((entry) => entry.identifier === drag?.pointerId);
      if (!touch) return;
      drag.lastX = touch.clientX;
      drag.lastY = touch.clientY;
      if (drag.phase === 'pending') {
        const dx = Math.abs(touch.clientX - drag.startX);
        const dy = Math.abs(touch.clientY - drag.startY);
        if (dx < START_DISTANCE_PX && dy < START_DISTANCE_PX) return;
        clearHold();
        if (dy >= dx) {
          // A vertical start is a scroll: the browser keeps it.
          drag.phase = 'ignored';
          return;
        }
        startSelecting();
      }
      // The finger now selects instead of scrolling the list.
      event.preventDefault();
      const id = rowIdAt(touch.clientX, touch.clientY);
      if (id) applyRange(id);
      if (!frame) frame = requestAnimationFrame(autoScroll);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      clearHold();
      if (drag?.phase === 'selecting') {
        // No click afterwards: it would toggle the row the finger lifted on.
        event.preventDefault();
      }
      drag = null;
    };

    // Capture phase: the phone drawer stops touches from bubbling up to here.
    // Not passive: once a drag selects, it has to stop the list from scrolling.
    document.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: false, capture: true });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart, { capture: true });
      document.removeEventListener('touchmove', handleTouchMove, { capture: true });
      document.removeEventListener('touchend', handleTouchEnd, { capture: true });
      document.removeEventListener('touchcancel', handleTouchEnd, { capture: true });
      if (frame) cancelAnimationFrame(frame);
      clearHold();
    };
  }, [isSelecting]);
}
