import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Archive, Plus, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button } from '@/shared/ui';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useTouchScreen } from '@/modules/sidebar/hooks/useTouchScreen';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  /** The sessions ticked here, or null when this project's list is not in selection mode. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  /** Archives sessions at once (the menus' Archive); stable identity. */
  onArchiveSessions?: (sessionIds: string[]) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  onArchiveSessions,
  t,
}: SidebarProjectSessionsProps) {
  const isTouchScreen = useTouchScreen();

  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  const selectableSessionIds = sessions.filter((session) => !isSessionRunning(session)).map((session) => session.id);

  // Ctrl/Cmd/Shift-click selection, as in Claude Code. The handler reads the
  // live list and selection through a ref so its identity never changes: the
  // memoized rows must not re-render when one row is ticked.
  const selectionStateRef = useRef({ selectableSessionIds, selectedSessionIds, selectedSessionId: selectedSession?.id ?? null });
  // Synced after each render, before any click can reach the handler.
  useLayoutEffect(() => {
    selectionStateRef.current = { selectableSessionIds, selectedSessionIds, selectedSessionId: selectedSession?.id ?? null };
  });
  // The row a Shift-click range starts from: the last row toggled.
  const rangeAnchorRef = useRef<string | null>(null);
  const handleModifierSelect = useCallback(
    (projectId: string, sessionId: string, mode: 'toggle' | 'range') => {
      const { selectableSessionIds: order, selectedSessionIds: current, selectedSessionId } = selectionStateRef.current;
      // A range with no toggled row yet starts at the open session, if it is listed here.
      const anchor = rangeAnchorRef.current ?? selectedSessionId;
      const anchorIndex = anchor ? order.indexOf(anchor) : -1;
      const targetIndex = order.indexOf(sessionId);
      if (mode === 'range' && anchorIndex !== -1 && targetIndex !== -1) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        onSetSessionSelection({
          projectId,
          sessionIds: new Set([...(current ?? []), ...order.slice(start, end + 1)]),
        });
        return;
      }
      rangeAnchorRef.current = sessionId;
      if (current === null) {
        onSetSessionSelection({ projectId, sessionIds: new Set([sessionId]) });
      } else {
        onToggleSessionSelected(projectId, sessionId);
      }
    },
    [onSetSessionSelection, onToggleSessionSelected],
  );

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
      onCancelSessionSelection();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelecting, onCancelSessionSelection]);

  // Where a selected row was last right-clicked: opens the bulk menu (Archive N,
  // Delete N) there, as in Claude Code. Null until the first right-click.
  const [bulkMenuAt, setBulkMenuAt] = useState<{ x: number; y: number } | null>(null);
  // Right-click on a row while selecting: an unticked row joins the selection
  // first, then the menu acts on everything ticked. Stable for the memoized rows.
  const handleBulkContextMenu = useCallback(
    (projectId: string, sessionId: string, point: { x: number; y: number }) => {
      const { selectedSessionIds: current } = selectionStateRef.current;
      if (current && !current.has(sessionId)) {
        onToggleSessionSelected(projectId, sessionId);
      }
      setBulkMenuAt(point);
    },
    [onToggleSessionSelected],
  );

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  // Re-derived from the selectable rows rather than read straight off the
  // selection, so a row that started running after it was ticked drops out of
  // the count, the button and the ids the confirmation is opened with.
  const effectiveSelectedIds = selectedSessionIds
    ? selectableSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
    : [];
  const checkedSessionIds = new Set(effectiveSelectedIds);
  const allLoadedSelected =
    selectableSessionIds.length > 0 && effectiveSelectedIds.length === selectableSessionIds.length;
  // With more sessions on the server than on screen, the button only reaches the
  // loaded rows, so it offers "Select all loaded" rather than a "Select all" it
  // could not honour. Once those rows are ticked it flips to "Clear" either way.
  const selectAllLabel = allLoadedSelected
    ? t('sessions.clearSelection')
    : hasMoreSessions
      ? t('sessions.selectAllLoaded')
      : t('sessions.selectAll');

  return (
    <div className="ml-2 space-y-0.5 pl-1">
      <Button
        variant="ghost"
        size="sm"
        className="flex h-8 w-full justify-start gap-2 px-2 text-sm font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('sessions.newSession')}
      </Button>

      {/* With a pointer, a selection (Ctrl/Cmd/Shift-click or the row menu's
          Select) is acted on through the right-click menu below. Touch screens
          have neither modifier keys nor right-click, so a selection started
          from the row menu gets this toolbar instead. */}
      {isTouchScreen && isSelecting && (
        <div className="space-y-1 px-1">
          {/* Wraps rather than clips: at the narrowest sidebar width a long
              translated "Select all loaded" leaves no room for Cancel. */}
          <div className="flex flex-wrap items-center justify-between gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                onSetSessionSelection({
                  projectId: project.projectId,
                  sessionIds: new Set(allLoadedSelected ? [] : selectableSessionIds),
                })
              }
              disabled={selectableSessionIds.length === 0}
            >
              {selectAllLabel}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={onCancelSessionSelection}
              title="Esc"
            >
              <X className="h-3 w-3" />
              {t('actions.cancel')}
            </Button>
          </div>
          {onArchiveSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start gap-2 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => {
                onArchiveSessions(effectiveSelectedIds);
                onCancelSessionSelection();
              }}
              disabled={effectiveSelectedIds.length === 0}
            >
              <Archive className="h-3.5 w-3.5" />
              {t('sessions.archiveSelected', { count: effectiveSelectedIds.length, defaultValue: 'Archive {{count}}' })}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 px-2 text-xs font-medium text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDeleteSelectedSessions(effectiveSelectedIds)}
            disabled={effectiveSelectedIds.length === 0}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('sessions.deleteSelected', { count: effectiveSelectedIds.length })}
          </Button>
        </div>
      )}

      {isSelecting && !isTouchScreen && (
        <ActionMenu
          label={t('sessions.selectedActions', { defaultValue: 'Selected sessions' })}
          hideTrigger
          portal
          openAt={bulkMenuAt}
          menuClassName="w-[220px] rounded-xl p-1.5 shadow-xl"
          items={[
            ...(onArchiveSessions ? [{
              key: 'archive',
              label: `Archive ${effectiveSelectedIds.length}`,
              disabled: effectiveSelectedIds.length === 0,
              onSelect: () => {
                onArchiveSessions(effectiveSelectedIds);
                onCancelSessionSelection();
              },
            }] : []),
            {
              key: 'delete',
              label: `Delete ${effectiveSelectedIds.length}`,
              isDanger: true,
              disabled: effectiveSelectedIds.length === 0,
              onSelect: () => onDeleteSelectedSessions(effectiveSelectedIds),
            },
            {
              key: 'clear',
              label: t('sessions.clearSelectionMenu'),
              showDividerBefore: true,
              onSelect: onCancelSessionSelection,
            },
          ]}
        />
      )}

      {/* A page emptied by deleting every loaded row still has sessions behind
          it on the server, so it keeps its "Load more" instead of "No sessions". */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !hasMoreSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {sessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={isSessionRunning(session)}
              hasBackgroundWork={backgroundSessionIds.has(session.id)}
              needsAttention={attentionSessionIds.has(session.id)}
              currentTime={currentTime}
              onRenameDraftChange={onRenameDraftChange}
              isEditing={session.id === sessionRenameId}
              renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              onForkSession={onForkSession}
              isSelecting={isSelecting}
              isChecked={checkedSessionIds.has(session.id)}
              onToggleSessionSelected={onToggleSessionSelected}
              onModifierSelect={handleModifierSelect}
              onArchiveSessions={onArchiveSessions}
              onBulkContextMenu={handleBulkContextMenu}
              t={t}
            />
          ))}

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
