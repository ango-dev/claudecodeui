import { memo, useState } from 'react';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { LLMProviderLogo, Tooltip, buttonVariants } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider } from '@/shared/types';
import { createSessionViewModel, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import { useShowOtherAgents } from '@/shared/agentVisibility';
import { dragSelectRowProps } from '@/modules/sidebar/hooks/useSidebarDragSelect';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  isProcessing: boolean;
  /** The session's turn has ended but the agents, workflows or commands it launched still run. */
  hasBackgroundWork: boolean;
  needsAttention: boolean;
  currentTime: Date;
  /** Resolved for this row, so a keystroke elsewhere does not invalidate it. */
  isEditing: boolean;
  renameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  /** Branches this session into an independent one; absent when its provider cannot. */
  onForkSession?: (session: SessionWithProvider) => void;
  /** This project's list is in bulk-selection mode: the row acts as a checkbox and hides its options. */
  isSelecting: boolean;
  /** Ticked for the pending bulk delete. Resolved by the list, which never ticks a running row. */
  isChecked: boolean;
  /** Takes the owning projectId so this memoized row binds itself without the list making a closure per row. */
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  /**
   * Ctrl/Cmd-click ('toggle') or Shift-click ('range') on a desktop row, and the
   * menu's Select item: starts or extends the bulk selection. Stable identity.
   */
  onModifierSelect: (projectId: string, sessionId: string, mode: 'toggle' | 'range') => void;
  /** Archives sessions at once (the menu's Archive); stable identity. */
  onArchiveSessions?: (sessionIds: string[]) => void;
  /** Right-click while selecting: opens the list's bulk menu at the pointer. Stable identity. */
  onBulkContextMenu?: (projectId: string, sessionId: string, point: { x: number; y: number }) => void;
  /** View only (the Running tab): no selecting, and the menu only copies the id. */
  readOnly?: boolean;
  t: TFunction;
};

/** Rendered by SidebarProjectSessions for one session row, including its rename, copy and delete controls. */
function SidebarSessionItem({
  project,
  session,
  selectedSession,
  isProcessing,
  hasBackgroundWork,
  needsAttention,
  currentTime,
  isEditing,
  renameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  isSelecting,
  isChecked,
  onToggleSessionSelected,
  onModifierSelect,
  onArchiveSessions,
  onBulkContextMenu,
  readOnly = false,
  t,
}: SidebarSessionItemProps) {
  // Agent logos only tell agents apart when there is more than one (agentVisibility).
  const showOtherAgents = useShowOtherAgents();
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const showAttentionIndicator = needsAttention && !isSelected;
  // Background work takes the recent-activity dot's place: the session is
  // still doing something, which says more than that it was touched lately.
  const showBackgroundIndicator = !showAttentionIndicator && hasBackgroundWork;
  const showRecentIndicator = !showAttentionIndicator && !showBackgroundIndicator && !isProcessing && sessionView.isActive;
  const indicatorLabel = showAttentionIndicator
    ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
    : showBackgroundIndicator
      ? t('tooltips.backgroundWorkIndicator', { defaultValue: 'Background work running' })
      : t('tooltips.activeSessionIndicator');

  // A running session cannot be deleted, so it cannot be ticked either; the row
  // still renders, locked, instead of disappearing from the list mid-selection.
  const isSelectable = isSelecting && !isProcessing;
  const toggleSelected = () => {
    onToggleSessionSelected(project.projectId, session.id);
  };
  // Where the row was last right-clicked; a new object asks the options menu
  // to open there. Null until the first right-click.
  const [contextMenuAt, setContextMenuAt] = useState<{ x: number; y: number } | null>(null);
  const openContextMenu = (event: ReactMouseEvent) => {
    // While renaming, the browser's own menu (paste etc.) stays.
    if (isEditing) {
      return;
    }
    if (isSelecting) {
      // A running row cannot join a bulk action; the browser menu stays.
      if (!isProcessing && onBulkContextMenu) {
        event.preventDefault();
        onBulkContextMenu(project.projectId, session.id, { x: event.clientX, y: event.clientY });
      }
      return;
    }
    event.preventDefault();
    setContextMenuAt({ x: event.clientX, y: event.clientY });
  };
  // Space does not activate the row's anchor and Enter would follow its link,
  // so both keys are handled here while selecting.
  const handleSelectionKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isSelectable || (event.key !== ' ' && event.key !== 'Enter')) {
      return;
    }
    event.preventDefault();
    toggleSelected();
  };
  return (
    <div className="group relative">
      {(showAttentionIndicator || showBackgroundIndicator || showRecentIndicator) && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip content={indicatorLabel} position="right">
            <div
              role="status"
              aria-label={indicatorLabel}
              className={cn(
                'h-2 w-2 animate-pulse rounded-full',
                showAttentionIndicator
                  ? 'bg-amber-500'
                  : showBackgroundIndicator
                    ? 'bg-purple-500 dark:bg-purple-400'
                    : 'bg-green-500',
              )}
            />
          </Tooltip>
        </div>
      )}

      <div>
        <a
          href={`/session/${session.id}`}
          {...(isSelecting ? dragSelectRowProps(project.projectId, session.id) : {})}
          role={isSelecting ? 'checkbox' : undefined}
          aria-checked={isSelecting ? isChecked : undefined}
          aria-disabled={isSelecting && !isSelectable ? true : undefined}
          // Flat rows as in Claude Code: no card border, a filled row for the
          // open session and for every ticked one.
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            // No colour transition: on iPad it left the old row half-painted.
            'h-8 w-full justify-start rounded-md px-2 py-1 text-left font-normal transition-none',
            isSelecting ? 'pr-2' : 'pr-9',
            isChecked
              ? 'bg-accent hover:bg-accent'
              : isSelected
                ? 'bg-accent/70 hover:bg-accent'
                : 'hover:bg-accent/60',
          )}
          // Left-click opens the session in-app; Ctrl/Cmd-click toggles it into
          // the bulk selection and Shift-click selects a range, as in Claude
          // Code. Middle-click still opens the href in a new tab. While
          // selecting, a plain click ticks the row too.
          onClick={(event) => {
            if (!readOnly && (event.shiftKey || event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!isProcessing) {
                onModifierSelect(project.projectId, session.id, event.shiftKey ? 'range' : 'toggle');
              }
              return;
            }
            if (isSelecting) {
              event.preventDefault();
              if (isSelectable) {
                toggleSelected();
              }
              return;
            }
            if (event.altKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId);
          }}
          onContextMenu={openContextMenu}
          onKeyDown={isSelecting ? handleSelectionKeyDown : undefined}
        >
          {/* Hidden, not removed, while the rename editor covers the row: the row keeps its height. */}
          <div className={cn('flex w-full min-w-0 items-center gap-2', isEditing && 'invisible')}>
            {showOtherAgents && <LLMProviderLogo provider={session.__provider} className="h-3.5 w-3.5 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm font-normal text-foreground"
                  title={sessionView.sessionName}
                >
                  {sessionView.sessionName}
                </div>
                {isProcessing ? (
                  <span
                    className={cn(
                      'ml-auto flex-shrink-0 transition-opacity duration-200',
                      isEditing && 'opacity-0',
                    )}
                  >
                    <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                      <span className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                      </span>
                    </Tooltip>
                  </span>
                ) : compactSessionAge && (
                  <span
                    className={cn(
                      // Stays visible on hover, like a project's session count; the
                      // "⋯" button appears beside it.
                      'ml-auto flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200',
                      isEditing && 'opacity-0',
                    )}
                  >
                    {compactSessionAge}
                  </span>
                )}
              </div>
            </div>
          </div>
        </a>

        {!isSelecting && (
          <SessionOptions
            className="absolute inset-y-0 right-2"
            sessionId={session.id}
            sessionName={sessionView.sessionName}
            provider={session.__provider}
            projectId={project.projectId}
            isProcessing={isProcessing}
            isEditing={isEditing}
            renameDraft={renameDraft}
            onRenameDraftChange={onRenameDraftChange}
            onStartEditingSession={onStartEditingSession}
            onCancelEditingSession={onCancelEditingSession}
            onSaveEditingSession={onSaveEditingSession}
            onDeleteSession={onDeleteSession}
            onFork={onForkSession ? () => onForkSession(session) : undefined}
            onSelectForBulk={() => onModifierSelect(project.projectId, session.id, 'toggle')}
            onArchive={onArchiveSessions ? () => onArchiveSessions([session.id]) : undefined}
            openAt={contextMenuAt}
            showOnTouch={isSelected}
            readOnly={readOnly}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Memoized: a websocket session delta re-renders the sidebar roughly every
 * 0.5-2s during a run, and a rename keystroke re-renders it per character.
 *
 * SidebarProjectSessions hands every row but the one being renamed a constant
 * draft, and the session objects come from a per-project cache, so the compare
 * succeeds for the rest. See sidebarRowProps.test.tsx.
 */
export default memo(SidebarSessionItem);
