import { Archive, Loader2, MessageSquare, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { TFunction } from 'i18next';

import { Button, LLMProviderLogo, Tooltip } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { ProjectSession, RecentConversationListItem, SessionRowActions, SidebarProjectListProps } from '@/shared/types';
import { formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import SessionOptions from '@/modules/sidebar/SessionOptions';
import SidebarBulkActions from '@/modules/sidebar/SidebarBulkActions';
import { useSidebarBulkSelection } from '@/modules/sidebar/hooks/useSidebarBulkSelection';
import { useTouchScreen } from '@/modules/sidebar/hooks/useTouchScreen';
import { RECENT_SESSIONS_SELECTION_SCOPE } from '@/modules/sidebar/utils/sidebarSelectionScopes';
import { useShowOtherAgents } from '@/shared/agentVisibility';

type SidebarRecentConversationsProps = {
  conversations: RecentConversationListItem[];
  total: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasError: boolean;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  /**
   * The same row state and callbacks the Projects list hands its rows, so a
   * conversation can be renamed, copied, forked or archived from here too.
   */
  sessionActions: SessionRowActions;
  /** Bulk selection, shared with the Projects list (one selection at a time). */
  bulkSelection: Pick<
    SidebarProjectListProps,
    'sessionSelection' | 'onSetSessionSelection' | 'onToggleSessionSelected' | 'onCancelSessionSelection' | 'onDeleteSelectedSessions'
  >;
  onConversationSelect: (
    projectId: string | null,
    sessionId: string,
    provider: string,
  ) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  t: TFunction;
};

function RecentConversationSkeleton() {
  return (
    <div className="space-y-1 px-1" aria-label="Loading recent sessions">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-2 rounded-lg px-2 py-2.5">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${72 - index * 3}%` }} />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Rendered by SidebarContent in the recents search mode to list recently active sessions across all projects. */
export default function SidebarRecentConversations({
  conversations,
  total,
  hasMore,
  isLoading,
  isLoadingMore,
  hasError,
  selectedSession,
  currentTime,
  sessionActions,
  bulkSelection,
  onConversationSelect,
  onLoadMore,
  onRetry,
  t,
}: SidebarRecentConversationsProps) {
  // Agent logos only tell agents apart when there is more than one (agentVisibility).
  const showOtherAgents = useShowOtherAgents();
  // The row last right-clicked and where: its options menu opens at that point.
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; point: { x: number; y: number } } | null>(null);
  const isTouchScreen = useTouchScreen();

  // A session with a response in flight can be neither archived nor deleted,
  // so it is not selectable either (the Projects list's rule).
  const isConversationRunning = (sessionId: string) =>
    sessionActions.activeSessions.has(sessionId) && !sessionActions.backgroundSessionIds.has(sessionId);
  const selectableIds = conversations
    .filter((conversation) => !isConversationRunning(conversation.sessionId))
    .map((conversation) => conversation.sessionId);
  const { sessionSelection, onCancelSessionSelection, onDeleteSelectedSessions } = bulkSelection;
  const selection = useSidebarBulkSelection({
    scopeId: RECENT_SESSIONS_SELECTION_SCOPE,
    selectableIds,
    selectedIds: sessionSelection?.projectId === RECENT_SESSIONS_SELECTION_SCOPE ? sessionSelection.sessionIds : null,
    openSessionId: selectedSession?.id ? String(selectedSession.id) : null,
    onSetSelection: bulkSelection.onSetSessionSelection,
    onToggleSelected: bulkSelection.onToggleSessionSelected,
    onCancelSelection: onCancelSessionSelection,
  });
  const { isSelecting, effectiveSelectedIds, checkedIds, handleModifierSelect, handleBulkContextMenu } = selection;
  const toggleRow = useCallback((sessionId: string) => handleModifierSelect(sessionId, 'toggle'), [handleModifierSelect]);

  if (isLoading && conversations.length === 0) {
    return <RecentConversationSkeleton />;
  }

  if (hasError && conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.loadFailed', 'Could not load recent sessions')}
        </p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
          {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
        </Button>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('recent.emptyTitle', 'No sessions yet')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('recent.emptyDescription', 'Your most recently updated sessions will appear here.')}
        </p>
      </div>
    );
  }

  return (
    <div className="px-1" data-testid="recent-conversations-list">
      <div className="flex items-center justify-between px-2 pb-1.5 pt-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('recent.title', 'Recent sessions')}
        </span>
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{total}</span>
      </div>

      {isSelecting && (
        <div className="pb-1">
          <SidebarBulkActions
            isTouchScreen={isTouchScreen}
            selectedCount={effectiveSelectedIds.length}
            actions={[
              ...(sessionActions.onArchiveSessions ? [{
                key: 'archive',
                label: t('sessions.archiveSelected', { count: effectiveSelectedIds.length, defaultValue: 'Archive {{count}}' }),
                menuLabel: `Archive ${effectiveSelectedIds.length}`,
                icon: Archive,
                onSelect: () => {
                  sessionActions.onArchiveSessions?.(effectiveSelectedIds);
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
            selectAllLabel={selection.allSelected
              ? t('sessions.clearSelection')
              : hasMore ? t('sessions.selectAllLoaded') : t('sessions.selectAll')}
            selectAllDisabled={selectableIds.length === 0}
            onToggleSelectAll={selection.toggleSelectAll}
            onCancel={onCancelSessionSelection}
            bulkMenuAt={selection.bulkMenuAt}
            t={t}
          />
        </div>
      )}

      <div className="space-y-0.5">
        {conversations.map((conversation) => {
          const isSelected = String(selectedSession?.id ?? '') === conversation.sessionId;
          const age = formatCompactAge(conversation.lastActivity, currentTime);
          const hasBackgroundWork = sessionActions.backgroundSessionIds.has(conversation.sessionId);
          const isProcessing = sessionActions.activeSessions.has(conversation.sessionId) && !hasBackgroundWork;
          const showAttentionIndicator =
            sessionActions.attentionSessionIds.has(conversation.sessionId) && !isSelected;
          // Resolved per row so a keystroke in one rename does not redraw the rest.
          const rename = sessionActions.activeRename;
          const sessionRename =
            rename?.target === 'session' && rename.id === conversation.sessionId ? rename : null;

          const isChecked = checkedIds.has(conversation.sessionId);
          const isSelectable = !isProcessing;

          const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
            if (event.button !== 0) {
              return;
            }
            // Ctrl/Cmd-click toggles a row into the bulk selection and
            // Shift-click selects a range, as in the Projects list; while
            // selecting, a plain click ticks the row too.
            if (event.shiftKey || event.metaKey || event.ctrlKey) {
              event.preventDefault();
              if (isSelectable) {
                handleModifierSelect(conversation.sessionId, event.shiftKey ? 'range' : 'toggle');
              }
              return;
            }
            if (isSelecting) {
              event.preventDefault();
              if (isSelectable) {
                toggleRow(conversation.sessionId);
              }
              return;
            }
            if (event.altKey) {
              return;
            }
            event.preventDefault();
            onConversationSelect(
              conversation.projectId,
              conversation.sessionId,
              conversation.provider,
            );
          };

          return (
            <div key={conversation.sessionId} className="group relative">
              {/*
                * Only the amber "needs attention" dot, and the spinner below. The
                * Projects row also has a green dot for a session touched recently,
                * which carries no information in a list ordered by recency.
                */}
              {showAttentionIndicator && (
                <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
                  <Tooltip
                    content={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
                    position="right"
                  >
                    <div
                      role="status"
                      aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
                      className="h-2 w-2 animate-pulse rounded-full bg-amber-500"
                    />
                  </Tooltip>
                </div>
              )}

              <a
                href={`/session/${conversation.sessionId}`}
                onClick={handleClick}
                onContextMenu={(event) => {
                  if (sessionRename !== null) return;
                  if (isSelecting) {
                    // A running row cannot join a bulk action; the browser menu stays.
                    if (isSelectable) {
                      event.preventDefault();
                      handleBulkContextMenu(conversation.sessionId, { x: event.clientX, y: event.clientY });
                    }
                    return;
                  }
                  event.preventDefault();
                  setContextMenu({ sessionId: conversation.sessionId, point: { x: event.clientX, y: event.clientY } });
                }}
                onKeyDown={isSelecting ? (event: KeyboardEvent<HTMLAnchorElement>) => {
                  if (isSelectable && (event.key === ' ' || event.key === 'Enter')) {
                    event.preventDefault();
                    toggleRow(conversation.sessionId);
                  }
                } : undefined}
                role={isSelecting ? 'checkbox' : undefined}
                aria-checked={isSelecting ? isChecked : undefined}
                aria-disabled={isSelecting && !isSelectable ? true : undefined}
                data-testid="recent-conversation-row"
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left',
                  isSelecting ? 'pr-2' : 'pr-11',
                  isChecked || isSelected
                    ? 'bg-accent text-foreground'
                    : 'text-foreground hover:bg-accent/60',
                )}
              >
                {showOtherAgents && <LLMProviderLogo provider={conversation.provider} className="h-3.5 w-3.5 flex-shrink-0" />}

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-normal leading-4">
                    {conversation.sessionTitle}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] leading-3 text-muted-foreground">
                    <span className="truncate">{conversation.projectDisplayName}</span>
                    {isProcessing ? (
                      <>
                        <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                        <Tooltip content={t('tooltips.processingSessionIndicator', 'Processing session')} position="top">
                          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                        </Tooltip>
                      </>
                    ) : hasBackgroundWork ? (
                      // No spinner: nothing is responding. The purple of the
                      // workflow and agent cards says what is still running.
                      <>
                        <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                        <Tooltip content={t('tooltips.backgroundWorkIndicator', 'Background work running')} position="top">
                          <span
                            role="status"
                            aria-label={t('tooltips.backgroundWorkIndicator', 'Background work running')}
                            className="h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400"
                          />
                        </Tooltip>
                      </>
                    ) : age && (
                      <>
                        <span className="flex-shrink-0 text-muted-foreground/40">·</span>
                        <time className="flex-shrink-0 tabular-nums" dateTime={conversation.lastActivity ?? undefined}>
                          {age}
                        </time>
                      </>
                    )}
                  </span>
                </span>
              </a>

              {!isSelecting && (
              <SessionOptions
                className="absolute inset-y-0 right-2"
                sessionId={conversation.sessionId}
                sessionName={conversation.sessionTitle}
                provider={conversation.provider}
                projectId={conversation.projectId}
                isProcessing={isProcessing}
                isEditing={sessionRename !== null}
                renameDraft={sessionRename?.draft ?? ''}
                onRenameDraftChange={sessionActions.onRenameDraftChange}
                onStartEditingSession={sessionActions.onStartEditingSession}
                onCancelEditingSession={sessionActions.onCancelEditingSession}
                onSaveEditingSession={sessionActions.onSaveEditingSession}
                onDeleteSession={sessionActions.onDeleteSession}
                onArchive={sessionActions.onArchiveSessions
                  ? () => sessionActions.onArchiveSessions?.([conversation.sessionId])
                  : undefined}
                onSelectForBulk={() => toggleRow(conversation.sessionId)}
                openAt={contextMenu?.sessionId === conversation.sessionId ? contextMenu.point : null}
                showOnTouch={isSelected}
                // The fork path reads only the id, provider and owning project,
                // which is all a recents row knows about the session.
                onFork={sessionActions.onForkSession
                  ? () => sessionActions.onForkSession?.({
                    id: conversation.sessionId,
                    summary: conversation.sessionTitle,
                    __provider: conversation.provider,
                    __projectId: conversation.projectId ?? undefined,
                  })
                  : undefined}
                t={t}
              />
              )}
            </div>
          );
        })}
      </div>

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full text-xs text-muted-foreground"
          onClick={onLoadMore}
          disabled={isLoadingMore}
        >
          {isLoadingMore
            ? t('recent.loadingMore', 'Loading more...')
            : t('recent.loadMore', 'Load older sessions')}
        </Button>
      )}
    </div>
  );
}
