import { memo, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, MoreHorizontal, Star, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  /** Resolved for this row: only the project being renamed re-renders on a keystroke. */
  isEditing: boolean;
  renameDraft: string;
  sessions: SessionWithProvider[];
  initialSessionsLoaded: boolean;
  isLoadingMoreSessions: boolean;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (name: string) => void;
  onToggleProject: (projectId: string) => void;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectId: string) => void;
  onStartEditingProject: (project: Project) => void;
  onCancelEditingProject: () => void;
  onSaveProjectName: (projectId: string, nextName: string) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  onNewSession: (project: Project) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  /** The sessions ticked in this project's list, or null when it is not the one selecting. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[], options?: { isArchived?: boolean }) => void;
  /** View only (the Running tab): no project menu, New Session or session editing. */
  readOnly?: boolean;
  /** Archives sessions at once; see SidebarProjectListProps. */
  onArchiveSessions?: (sessionIds: string[]) => void;
  t: TFunction;
};

const getSessionCountDisplay = (project: Project, sessions: SessionWithProvider[]): string => {
  const total = Number(project.sessionMeta?.total ?? sessions.length);
  return String(total);
};

/** Rendered by SidebarProjectList for one project row, including its expand, rename, star and delete controls. */
function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  isEditing,
  renameDraft,
  sessions,
  initialSessionsLoaded,
  isLoadingMoreSessions,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  readOnly = false,
  onArchiveSessions,
  t,
}: SidebarProjectItemProps) {
  // Project identity is tracked by the DB-assigned `projectId` everywhere
  // after the projectName → projectId migration.
  const isSelected = selectedProject?.projectId === project.projectId;
  const sessionCountDisplay = getSessionCountDisplay(project, sessions);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing || !renameInputRef.current) {
      return;
    }

    let animationFrame = 0;
    const revealInput = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        renameInputRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    revealInput();
    window.visualViewport?.addEventListener('resize', revealInput);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.visualViewport?.removeEventListener('resize', revealInput);
    };
  }, [isEditing]);

  // Where the project row was last right-clicked; a new object opens its menu there.
  const [projectMenuAt, setProjectMenuAt] = useState<{ x: number; y: number } | null>(null);

  const toggleProject = () => onToggleProject(project.projectId);
  const toggleStarProject = () => onToggleStarProject(project.projectId);

  const saveProjectName = () => {
    onSaveProjectName(project.projectId, renameDraft);
  };

  const selectAndToggleProject = () => {
    if (selectedProject?.projectId !== project.projectId) {
      onProjectSelect(project);
    }

    toggleProject();
  };

  return (
    <div className={cn('space-y-1', isDeleting && 'opacity-50 pointer-events-none')}>
      <div className="group sticky top-0 z-10">
        {/* One flat line, as in Claude Code: chevron, name, star, count. Rename,
            delete and favourite live in the "⋯" menu, which right-click opens too. */}
        <Button
          variant="ghost"
          className={cn(
            'sticky top-0 z-10 flex h-8 w-full justify-between bg-background px-2 font-normal hover:bg-accent/60',
            !isEditing && 'pr-9',
            isEditing && 'h-auto py-1.5',
          )}
          onClick={selectAndToggleProject}
          onContextMenu={(event) => {
            if (isEditing || readOnly) return;
            event.preventDefault();
            setProjectMenuAt({ x: event.clientX, y: event.clientY });
          }}
          title={isEditing ? undefined : project.fullPath}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1 text-left">
              {isEditing ? (
                <div className="space-y-1">
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(event) => onRenameDraftChange(event.target.value)}
                    className="w-full rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:ring-2 focus:ring-primary/20"
                    placeholder={t('projects.projectNamePlaceholder')}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        saveProjectName();
                      }
                      if (event.key === 'Escape') {
                        // Cancelling the rename must not also close the code editor.
                        event.stopPropagation();
                        onCancelEditingProject();
                      }
                    }}
                  />
                  <div className="truncate text-xs text-muted-foreground" title={project.fullPath}>
                    {project.fullPath}
                  </div>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={cn('truncate text-sm text-foreground', isSelected && 'font-medium')}>
                    {project.displayName}
                  </span>
                  {isStarred && (
                    <Star
                      className="h-3 w-3 flex-shrink-0 fill-current text-yellow-600 dark:text-yellow-400"
                      aria-label={t('tooltips.removeFromFavorites')}
                    />
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            {isEditing ? (
              <>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-green-600 transition-colors hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveProjectName();
                  }}
                >
                  <Check className="h-3 w-3" />
                </div>
                <div
                  className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700 dark:hover:bg-gray-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingProject();
                  }}
                >
                  <X className="h-3 w-3" />
                </div>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                {sessionCountDisplay}
              </span>
            )}
          </div>
        </Button>
        {!isEditing && !readOnly && (
          <ActionMenu
            label={t('tooltips.projectOptions', { defaultValue: 'Project options' })}
            ariaLabel={`${t('tooltips.projectOptions', { defaultValue: 'Project options' })}: ${project.displayName}`}
            icon={MoreHorizontal}
            iconOnly
            portal
            variant="ghost"
            size="icon"
            openAt={projectMenuAt}
            // Centred by flex rather than top-1/2 plus a transform, which iPad
            // Safari sometimes misplaced inside this sticky header.
            className="absolute inset-y-0 right-1 z-20 items-center"
            // Beside the session count, which stays put: revealed on hover, focus
            // or while open, and always shown on touch screens, which cannot hover.
            triggerClassName="h-6 w-6 text-muted-foreground opacity-0 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 touch:opacity-100"
            menuClassName="w-[220px] rounded-xl p-1.5 shadow-xl"
            items={[
              {
                key: 'star',
                label: isStarred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites'),
                onSelect: toggleStarProject,
              },
              {
                key: 'rename',
                label: t('actions.rename', { defaultValue: 'Rename' }),
                onSelect: () => onStartEditingProject(project),
              },
              {
                key: 'delete',
                label: t('actions.removeFromSidebar', { defaultValue: 'Remove from sidebar' }),
                isDanger: true,
                showDividerBefore: true,
                onSelect: () => onDeleteProject(project),
              },
            ]}
          />
        )}
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        hasMoreSessions={Boolean(project.sessionMeta?.hasMore)}
        isLoadingMoreSessions={isLoadingMoreSessions}
        activeSessions={activeSessions}
        backgroundSessionIds={backgroundSessionIds}
        attentionSessionIds={attentionSessionIds}
        currentTime={currentTime}
        sessionRenameId={sessionRenameId}
        sessionRenameDraft={sessionRenameDraft}
        onRenameDraftChange={onRenameDraftChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onSessionSelect={onSessionSelect}
        onDeleteSession={onDeleteSession}
        onForkSession={onForkSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        selectedSessionIds={selectedSessionIds}
        onSetSessionSelection={onSetSessionSelection}
        onToggleSessionSelected={onToggleSessionSelected}
        onCancelSessionSelection={onCancelSessionSelection}
        onDeleteSelectedSessions={onDeleteSelectedSessions}
        onArchiveSessions={onArchiveSessions}
        readOnly={readOnly}
        t={t}
      />
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * Both renames are resolved to scalars by SidebarProjectList and the sorted
 * session array is cached per project, so a keystroke changes props on exactly
 * one row and every other row's compare succeeds. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarProjectItem);
