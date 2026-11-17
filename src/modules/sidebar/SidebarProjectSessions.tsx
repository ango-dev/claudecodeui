import { useCallback, useMemo, useState } from 'react';
import { Archive, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useTouchScreen } from '@/modules/sidebar/hooks/useTouchScreen';
import { useSidebarBulkSelection } from '@/modules/sidebar/hooks/useSidebarBulkSelection';
import SidebarBulkActions from '@/modules/sidebar/SidebarBulkActions';
import { buildProjectSessionTree } from '@/modules/sidebar/utils/projectSessionTree';

/** How far each fork level steps in: one chevron's width, so a child's chevron sits right of its parent's guide. */
const FORK_INDENT_PX = 14;
/** Deeper forks stop stepping in, so a long chain keeps room for its titles. */
const MAX_FORK_INDENT_DEPTH = 4;
/**
 * Where a row's chevron is centred, from the row's left edge. A fork tree's
 * rows reserve this space (SidebarSessionItem's treeRow), and the guide that
 * runs down a parent's forks hangs from the same x.
 */
const FORK_CHEVRON_CENTER_PX = 11;

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
  onArchiveSession: (sessionId: string) => void;
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
  /** View only (the Running tab): no New Session and no selecting; see SidebarProjectListProps. */
  readOnly?: boolean;
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
  onArchiveSession,
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
  readOnly = false,
  t,
}: SidebarProjectSessionsProps) {
  const isTouchScreen = useTouchScreen();

  // Forks sit under the session they branched from; off-page sources the
  // server sent as context are shown too (see projectSessionTree).
  const treeRows = useMemo(() => buildProjectSessionTree(sessions, project.projectId), [sessions, project.projectId]);
  const hasForks = treeRows.some((row) => row.hasChildren);
  const selectedSessionId = selectedSession?.id ?? null;
  // The forks above the open or renamed session: collapsed, they would hide it.
  const targetAncestors = useMemo(() => {
    const parents = new Map(treeRows.map((row) => [row.session.id, row.parentId]));
    const reveal = new Set<string>();
    for (const target of [selectedSessionId, sessionRenameId]) {
      let parentId = target ? parents.get(target) : null;
      while (parentId && !reveal.has(parentId)) {
        reveal.add(parentId);
        parentId = parents.get(parentId);
      }
    }
    return reveal;
  }, [treeRows, selectedSessionId, sessionRenameId]);
  // The parents whose forks the user folded away (view-only, so the Running
  // tab can fold too), with the targets they were last reconciled against so
  // only a new target re-opens a fold, not a title or activity update.
  const [forkTreeState, setForkTreeState] = useState(() => ({
    targetAncestors, selectedSessionId, sessionRenameId, collapsedForks: new Set<string>(),
  }));
  const { collapsedForks } = forkTreeState;
  // Adjusted during render, so a newly opened fork is never committed hidden.
  if (forkTreeState.selectedSessionId !== selectedSessionId
    || forkTreeState.sessionRenameId !== sessionRenameId
    || forkTreeState.targetAncestors.size !== targetAncestors.size
    || [...targetAncestors].some((id) => !forkTreeState.targetAncestors.has(id))) {
    setForkTreeState({
      targetAncestors, selectedSessionId, sessionRenameId,
      collapsedForks: new Set([...collapsedForks].filter((id) => !targetAncestors.has(id))),
    });
  }
  const toggleForks = useCallback((sessionId: string) => {
    setForkTreeState((previous) => {
      const next = new Set(previous.collapsedForks);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return { ...previous, collapsedForks: next };
    });
  }, []);
  // Each visible row with the ancestor depths whose guides run through it.
  const visibleRows = useMemo(() => {
    let hiddenBelowDepth = Infinity;
    const visible: (typeof treeRows[number] & { guideDepths: number[] })[] = [];
    for (const row of treeRows) {
      if (row.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = row.hasChildren && collapsedForks.has(row.session.id) ? row.depth : Infinity;
      // One guide per ancestor level, capped with the indent, so a deep chain
      // stays linear in size and its guides stay under their chevrons.
      const guideCount = Math.min(row.depth, MAX_FORK_INDENT_DEPTH);
      visible.push({ ...row, guideDepths: Array.from({ length: guideCount }, (_, depth) => depth) });
    }
    return visible;
  }, [treeRows, collapsedForks]);

  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  // Every loaded row, folded forks included: Select all reaches them, and a
  // ticked fork stays ticked when its parent is folded.
  const selectableSessionIds = treeRows.filter(({ session }) => !isSessionRunning(session)).map(({ session }) => session.id);
  // A Shift-click range or a finger drag walks the rows on screen, so it never
  // ticks a folded fork the user cannot see.
  const displayedSelectableIds = visibleRows.filter(({ session }) => !isSessionRunning(session)).map(({ session }) => session.id);
  const selection = useSidebarBulkSelection({
    scopeId: project.projectId,
    selectableIds: selectableSessionIds,
    rangeIds: displayedSelectableIds,
    selectedIds: selectedSessionIds,
    openSessionId: selectedSession?.id ?? null,
    onSetSelection: onSetSessionSelection,
    onToggleSelected: onToggleSessionSelected,
    onCancelSelection: onCancelSessionSelection,
  });
  const { isSelecting, handleModifierSelect, handleBulkContextMenu } = selection;
  // The rows report their project with each event; this list is one project.
  const handleRowModifierSelect = useCallback(
    (_projectId: string, sessionId: string, mode: 'toggle' | 'range') => handleModifierSelect(sessionId, mode),
    [handleModifierSelect],
  );
  const handleRowBulkContextMenu = useCallback(
    (_projectId: string, sessionId: string, point: { x: number; y: number }) => handleBulkContextMenu(sessionId, point),
    [handleBulkContextMenu],
  );

  if (!isExpanded) {
    return null;
  }

  const hasSessions = treeRows.length > 0;
  const { effectiveSelectedIds, checkedIds: checkedSessionIds, allSelected: allLoadedSelected } = selection;
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
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="flex h-8 w-full justify-start gap-2 px-2 text-sm font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={() => onNewSession(project)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sessions.newSession')}
        </Button>
      )}

      {/* With a pointer, a selection (Ctrl/Cmd/Shift-click or the row menu's
          Select) is acted on through the right-click menu; a touch screen
          gets a toolbar instead. */}
      {isSelecting && (
        <SidebarBulkActions
          isTouchScreen={isTouchScreen}
          selectedCount={effectiveSelectedIds.length}
          actions={[
            ...(onArchiveSessions ? [{
              key: 'archive',
              label: t('sessions.archiveSelected', { count: effectiveSelectedIds.length, defaultValue: 'Archive {{count}}' }),
              menuLabel: `Archive ${effectiveSelectedIds.length}`,
              icon: Archive,
              onSelect: () => {
                onArchiveSessions(effectiveSelectedIds);
                onCancelSessionSelection();
              },
            }] : []),
            {
              key: 'delete',
              label: t('sessions.deleteSelected', { count: effectiveSelectedIds.length }),
              menuLabel: `Delete ${effectiveSelectedIds.length}`,
              icon: Trash2,
              isDanger: true,
              onSelect: () => onDeleteSelectedSessions(effectiveSelectedIds),
            },
          ]}
          selectAllLabel={selectAllLabel}
          selectAllDisabled={selectableSessionIds.length === 0}
          onToggleSelectAll={selection.toggleSelectAll}
          onCancel={onCancelSessionSelection}
          bulkMenuAt={selection.bulkMenuAt}
          t={t}
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
          {/* Without forks the rows are spaced as before; with them, each row
              carries its own gap so the guides run unbroken from row to row. */}
          <div className={cn(!hasForks && 'space-y-0.5')} data-testid="project-session-tree">
            {visibleRows.map(({ session, parentId, depth, hasChildren, guideDepths }) => {
              const isCollapsed = collapsedForks.has(session.id);
              const indentPx = Math.min(depth, MAX_FORK_INDENT_DEPTH) * FORK_INDENT_PX;
              const isEditing = session.id === sessionRenameId;
              const sessionName = session.summary || session.name || t('projects.newSession');
              return (
                <div
                  key={session.id}
                  data-session-id={session.id}
                  data-parent-session-id={parentId ?? undefined}
                  data-fork-depth={depth}
                  data-fork-branch={hasChildren || undefined}
                  className={cn('relative min-w-0', hasForks && 'pb-0.5')}
                  style={indentPx > 0 ? { paddingLeft: `${indentPx}px` } : undefined}
                >
                  {/* Indent guides, as in an editor's file tree: one line per
                      ancestor, hanging from that ancestor's chevron. */}
                  {guideDepths.map((guideDepth) => (
                    <span
                      key={guideDepth}
                      aria-hidden="true"
                      data-fork-guide={guideDepth}
                      className="pointer-events-none absolute inset-y-0 w-px bg-border"
                      style={{ left: `${guideDepth * FORK_INDENT_PX + FORK_CHEVRON_CENTER_PX}px` }}
                    />
                  ))}
                  <SidebarSessionItem
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    isProcessing={isSessionRunning(session)}
                    hasBackgroundWork={backgroundSessionIds.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    currentTime={currentTime}
                    onRenameDraftChange={onRenameDraftChange}
                    isEditing={isEditing}
                    renameDraft={isEditing ? sessionRenameDraft : ''}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onSessionSelect={onSessionSelect}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    onForkSession={onForkSession}
                    isSelecting={isSelecting}
                    isChecked={checkedSessionIds.has(session.id)}
                    onToggleSessionSelected={onToggleSessionSelected}
                    onModifierSelect={handleRowModifierSelect}
                    onBulkContextMenu={handleRowBulkContextMenu}
                    treeRow={hasForks}
                    readOnly={readOnly}
                    t={t}
                  />
                  {/* Over the row's reserved left inset rather than inside it:
                      the row is a link, which cannot hold a button. Hidden
                      while the rename editor covers the row. */}
                  {hasChildren && !isEditing && (
                    <button
                      type="button"
                      // Centred on the 32px row, with its own hover like the row's "⋯".
                      className="absolute top-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      style={{ left: `${indentPx + FORK_CHEVRON_CENTER_PX - 10}px` }}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed
                        ? t('sessions.expandForks', { session: sessionName })
                        : t('sessions.collapseForks', { session: sessionName })}
                      onClick={() => toggleForks(session.id)}
                    >
                      <ChevronRight
                        className={cn('h-3.5 w-3.5 transition-transform duration-150', !isCollapsed && 'rotate-90')}
                        aria-hidden="true"
                      />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

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
