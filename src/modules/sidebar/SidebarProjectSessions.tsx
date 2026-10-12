import { useCallback } from 'react';
import { Archive, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useTouchScreen } from '@/modules/sidebar/hooks/useTouchScreen';
import { useSidebarBulkSelection } from '@/modules/sidebar/hooks/useSidebarBulkSelection';
import SidebarBulkActions from '@/modules/sidebar/SidebarBulkActions';

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

  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  const selectableSessionIds = sessions.filter((session) => !isSessionRunning(session)).map((session) => session.id);
  const selection = useSidebarBulkSelection({
    scopeId: project.projectId,
    selectableIds: selectableSessionIds,
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

  const hasSessions = sessions.length > 0;
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
              onModifierSelect={handleRowModifierSelect}
              onArchiveSessions={onArchiveSessions}
              onBulkContextMenu={handleRowBulkContextMenu}
              readOnly={readOnly}
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
