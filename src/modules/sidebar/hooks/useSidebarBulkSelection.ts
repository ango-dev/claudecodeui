import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { SidebarSessionSelection } from '@/shared/types';
import { useSidebarDragSelect } from '@/modules/sidebar/hooks/useSidebarDragSelect';

type UseSidebarBulkSelectionArgs = {
  /** The list the selection belongs to: a project id, or a tab's scope (see sidebarSelectionScopes). */
  scopeId: string;
  /** Rows that can be ticked, in display order; a Shift-click range follows it. */
  selectableIds: string[];
  /** The ticked rows, or null when this list is not in selection mode. */
  selectedIds: ReadonlySet<string> | null;
  /** The open session, where a Shift-click range starts when nothing was ticked yet. */
  openSessionId: string | null;
  onSetSelection: (selection: SidebarSessionSelection) => void;
  onToggleSelected: (scopeId: string, sessionId: string) => void;
  onCancelSelection: () => void;
};

/**
 * Used by the sidebar's session lists (a project's sessions, the Sessions tab
 * and the Archive tab) for bulk selection as in Claude Code: Ctrl/Cmd-click
 * toggles a row, Shift-click selects a range, Escape clears, and right-click on
 * a ticked row opens the bulk menu where it was clicked.
 *
 * The handlers read the live list and selection through a ref, so their
 * identity never changes and memoized rows do not re-render when one is ticked.
 */
export function useSidebarBulkSelection({
  scopeId,
  selectableIds,
  selectedIds,
  openSessionId,
  onSetSelection,
  onToggleSelected,
  onCancelSelection,
}: UseSidebarBulkSelectionArgs) {
  const isSelecting = selectedIds !== null;
  // On touch screens, sliding a finger down the list ticks every row it passes.
  useSidebarDragSelect({ scopeId, selectableIds, selectedIds, onSetSelection });

  const stateRef = useRef({ scopeId, selectableIds, selectedIds, openSessionId });
  // Synced after each render, before any click can reach the handlers.
  useLayoutEffect(() => {
    stateRef.current = { scopeId, selectableIds, selectedIds, openSessionId };
  });

  // The row a Shift-click range starts from: the last row toggled.
  const rangeAnchorRef = useRef<string | null>(null);
  const handleModifierSelect = useCallback((sessionId: string, mode: 'toggle' | 'range') => {
    const { scopeId: scope, selectableIds: order, selectedIds: current, openSessionId: openId } = stateRef.current;
    const anchor = rangeAnchorRef.current ?? openId;
    const anchorIndex = anchor ? order.indexOf(anchor) : -1;
    const targetIndex = order.indexOf(sessionId);
    if (mode === 'range' && anchorIndex !== -1 && targetIndex !== -1) {
      const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      onSetSelection({ projectId: scope, sessionIds: new Set([...(current ?? []), ...order.slice(start, end + 1)]) });
      return;
    }
    rangeAnchorRef.current = sessionId;
    if (current === null) {
      onSetSelection({ projectId: scope, sessionIds: new Set([sessionId]) });
    } else {
      onToggleSelected(scope, sessionId);
    }
  }, [onSetSelection, onToggleSelected]);

  // Escape clears the selection, unless a field or another layer consumed it.
  useEffect(() => {
    if (!isSelecting) {
      rangeAnchorRef.current = null;
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      // The target can be the window or document, which have no closest().
      const target = event.target instanceof Element ? event.target : null;
      if (event.key !== 'Escape' || event.defaultPrevented || target?.closest('input, textarea, [contenteditable="true"]')) {
        return;
      }
      onCancelSelection();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelecting, onCancelSelection]);

  // Where a ticked row was last right-clicked: the bulk menu opens there.
  const [bulkMenuAt, setBulkMenuAt] = useState<{ x: number; y: number } | null>(null);
  // An unticked row joins the selection first, then the menu acts on all of it.
  const handleBulkContextMenu = useCallback((sessionId: string, point: { x: number; y: number }) => {
    const { scopeId: scope, selectedIds: current } = stateRef.current;
    if (current && !current.has(sessionId)) {
      onToggleSelected(scope, sessionId);
    }
    setBulkMenuAt(point);
  }, [onToggleSelected]);

  // Re-derived from the selectable rows rather than read off the selection, so
  // a row that started running after it was ticked drops out of the count, the
  // buttons and the ids an action is given.
  const effectiveSelectedIds = selectedIds ? selectableIds.filter((id) => selectedIds.has(id)) : [];
  const allSelected = selectableIds.length > 0 && effectiveSelectedIds.length === selectableIds.length;
  const toggleSelectAll = () => {
    onSetSelection({ projectId: scopeId, sessionIds: new Set(allSelected ? [] : selectableIds) });
  };
  const startSelecting = () => {
    onSetSelection({ projectId: scopeId, sessionIds: new Set() });
  };

  return {
    isSelecting,
    effectiveSelectedIds,
    checkedIds: new Set(effectiveSelectedIds),
    allSelected,
    toggleSelectAll,
    startSelecting,
    handleModifierSelect,
    handleBulkContextMenu,
    bulkMenuAt,
  };
}
