import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api } from '@/shared/api';
import type { MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { readSessionMessagesPageSize, SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { isScrollAtRest, usesScrollAnchorFallback, waitForScrollRest } from '@/modules/chat/hooks/useScrollAnchorFallback';
import { findSearchTargetIndex, resolveSearchWindowSize } from '@/modules/chat/utils/searchTargetLocator';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { SearchTarget } from '@/modules/chat/utils/searchTargetLocator';

const INITIAL_VISIBLE_MESSAGES = 100;
/**
 * The longest "Loading older messages" stays up. A page still in flight then
 * lands in the store quietly and shows on the next scroll up, instead of the
 * indicator spinning until a refresh.
 */
const OLDER_PAGE_TIMEOUT_MS = 15_000;
/** How many screens before the first loaded message Safari starts on the next older page (see handleScroll). */
const SAFARI_OLDER_PAGE_LEAD_SCREENS = 6;
/**
 * Beyond the estimated height of the older messages not yet shown, the space
 * Safari keeps above the oldest one (see olderSpacerRef) has this many
 * screens to spare, so an estimate on the low side still holds every page.
 */
const OLDER_SPACER_MARGIN_SCREENS = 1;
/** The space never grows past this many screens, whatever the estimate. */
const OLDER_SPACER_MAX_SCREENS = 400;
/** The smallest height assumed for one message when estimating that space. */
const MIN_MESSAGE_HEIGHT_PX = 40;
/** A page of older messages is assumed this tall, in screens, until one has been measured. */
const ASSUMED_OLDER_PAGE_SCREENS = 6;
/**
 * The window a session opens with: at least a full first page, so a larger
 * "messages loaded at a time" setting is not loaded and then kept hidden.
 */
const initialVisibleMessages = () => Math.max(INITIAL_VISIBLE_MESSAGES, readSessionMessagesPageSize());

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used.
 */
const SEARCH_SCROLL_RETRIES = 20;
const SEARCH_SCROLL_RETRY_DELAY_MS = 150;

/**
 * Finds the rendered row for a resolved search target.
 *
 * Only an exact timestamp match counts while retries remain: the widened window
 * may not be committed yet, and accepting the nearest row then would scroll to
 * an arbitrary message and flash the highlight on it — the silent wrong answer
 * this rewrite exists to remove. `allowNearest` is used on the final attempt
 * because a hit on the second or later call of a collapsed tool group has no row
 * of its own; groupConsecutiveTools stamps the group with the run's FIRST
 * timestamp, so the group row is the nearest, not an exact, match.
 */
function findRenderedMessageElement(
  container: HTMLElement,
  timestamp: unknown,
  allowNearest: boolean,
): HTMLElement | null {
  const targetTimestamp = String(timestamp);
  const targetTime = new Date(targetTimestamp).getTime();
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-timestamp]');

  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.getAttribute('data-message-timestamp');
    if (!candidateTimestamp) {
      continue;
    }
    if (candidateTimestamp === targetTimestamp) {
      return candidate;
    }

    if (!allowNearest) {
      continue;
    }

    const candidateTime = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)) {
      continue;
    }

    const distance = Math.abs(candidateTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return nearest;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

/**
 * The visible-window size that shows the row at `index` of `total` rows, with
 * a page of context above it; the current size when the row already shows.
 * The window is a tail slice, so a row is visible when at most `count` rows
 * follow it, itself included.
 */
export function visibleCountToReveal(total: number, index: number, current: number): number {
  const needed = total - index;
  return needed <= current ? current : needed + SESSION_MESSAGES_PAGE_SIZE;
}

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
};

type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

function captureScrollRestoreState(container: HTMLDivElement): ScrollRestoreState {
  const containerBounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('.chat-message'))
    .find((element) => element.getBoundingClientRect().bottom >= containerBounds.top)
    ?? null;

  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - containerBounds.top
      : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: msg.taskNotificationStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const hasMoreMessagesRef = useRef(false);
  useEffect(() => { hasMoreMessagesRef.current = hasMoreMessages; }, [hasMoreMessages]);
  const [totalMessages, setTotalMessages] = useState(0);
  const totalMessagesRef = useRef(0);
  useEffect(() => { totalMessagesRef.current = totalMessages; }, [totalMessages]);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(initialVisibleMessages);
  const visibleMessageCountRef = useRef(visibleMessageCount);
  useEffect(() => { visibleMessageCountRef.current = visibleMessageCount; }, [visibleMessageCount]);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  // The sidebar-search hit this transcript still owes the user a scroll to.
  // State rather than a ref because resolving it widens the render window,
  // and it is cleared once the row is on screen or the retries run out.
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchScrollActiveRef = useRef(false);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * `isUserScrolledUp` readable from a timer callback. Both deferred
   * scroll-to-bottom calls are armed while the user is at the bottom and fire
   * tens to hundreds of milliseconds later; without re-reading this at fire
   * time, a scroll-up inside that window is silently undone.
   */
  const isUserScrolledUpRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  /**
   * Blank space above the oldest loaded message, kept on Safari while older
   * messages remain (ChatMessagesPane renders it). Safari cannot move scrollTop
   * mid-fling without stopping it, so a page added above the reader used to
   * wait for the scroll to rest, and a fling reached the top and bounced there
   * first. A page now lands inside this space, which shrinks by the page's
   * height so nothing on screen moves; it is topped up again at rest.
   */
  const olderSpacerRef = useRef<HTMLDivElement>(null);
  const lastOlderPageHeightRef = useRef<number | null>(null);
  const spacerRefillPendingRef = useRef(false);
  const revealWaitsForRestRef = useRef(false);
  const spacerRefillAgainRef = useRef(false);
  const refillOlderSpacerRef = useRef<() => void>(() => undefined);
  const pendingInitialScrollRef = useRef(true);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> ProjectWorkspaceRoute -> WorkspaceMain -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(initialVisibleMessages());
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingInitialScrollRef.current = true;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore. Background-only work shows in the
  // indicator but is not a response in flight: the composer can send.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null && !sessionActivity.background;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: readSessionMessagesPageSize(),
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    return all;
  }, [storeMessages, pendingUserMessage]);
  // Read by loadOlderMessages across its awaits, after the page has merged.
  const chatMessagesLengthRef = useRef(chatMessages.length);
  useEffect(() => { chatMessagesLengthRef.current = chatMessages.length; }, [chatMessages.length]);

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  // Mirrors the state into a ref so the two deferred scroll-to-bottom timers
  // can re-read it at fire time. An effect rather than assignments next to each
  // `setIsUserScrolledUp` call, because the setter is also returned from this
  // hook and driven from the composer.
  useEffect(() => {
    isUserScrolledUpRef.current = isUserScrolledUp;
  }, [isUserScrolledUp]);

  // Rows below the old position are sized by an estimate until drawn (see
  // `.chat-message` in index.css), so one jump to the bottom ended short of
  // it once they were. Holds the bottom while the height still moves, for at
  // most a second; the reader's first touch, wheel or click lets go.
  const bottomPinFrameRef = useRef<number | null>(null);
  const releaseBottomPin = useCallback(() => {
    if (bottomPinFrameRef.current !== null) {
      cancelAnimationFrame(bottomPinFrameRef.current);
      bottomPinFrameRef.current = null;
    }
  }, []);
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    releaseBottomPin();
    let frame = 0;
    let stableFrames = 0;
    let lastHeight = container.scrollHeight;
    const hold = () => {
      container.scrollTop = container.scrollHeight;
      stableFrames = container.scrollHeight === lastHeight ? stableFrames + 1 : 0;
      lastHeight = container.scrollHeight;
      frame += 1;
      bottomPinFrameRef.current = stableFrames < 3 && frame < 60 ? requestAnimationFrame(hold) : null;
    };
    bottomPinFrameRef.current = requestAnimationFrame(hold);
  }, [releaseBottomPin]);
  useEffect(() => releaseBottomPin, [releaseBottomPin]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(initialVisibleMessages());
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const olderSpacerHeight = () => olderSpacerRef.current?.offsetHeight ?? 0;

  // Tops the space above the oldest message back up (or removes it once there
  // is nothing older), moving scrollTop by the same amount: done only at rest,
  // where that move is invisible and stops nothing.
  const refillOlderSpacer = useCallback(() => {
    const container = scrollContainerRef.current;
    const spacer = olderSpacerRef.current;
    if (!container || !spacer) return;
    // Asked again while waiting: once this pass is done, one more, with
    // whatever changed meanwhile.
    if (spacerRefillPendingRef.current) {
      spacerRefillAgainRef.current = true;
      return;
    }
    spacerRefillPendingRef.current = true;
    const apply = () => {
      if (!isScrollAtRest(container)) {
        void waitForScrollRest(container, Infinity).then(apply);
        return;
      }
      spacerRefillPendingRef.current = false;
      if (spacerRefillAgainRef.current) {
        spacerRefillAgainRef.current = false;
        requestAnimationFrame(() => refillOlderSpacerRef.current());
      }
      // Not while a session opens: moving scrollTop then reads as the reader
      // scrolling up, which cancels the opening scroll to the bottom. That
      // scroll tops the space up itself once it is done.
      if (pendingInitialScrollRef.current) return;
      // A hidden Chat tab measures as zero; it is topped up when shown again.
      if (container.clientHeight === 0 || !spacer.isConnected) return;
      // As tall as the older messages still to show are likely to be, so
      // every page fits however far a fling goes, and the scroll bar reflects
      // the whole conversation: those not fetched (the server counts raw
      // transcript rows, so scaled to messages by what is loaded) and those
      // loaded but hidden, at the average height of the ones on the page.
      const loadedMessages = chatMessagesLengthRef.current;
      const shownMessages = Math.max(1, Math.min(visibleMessageCountRef.current, loadedMessages));
      const unfetched = hasMoreMessagesRef.current && !allMessagesLoadedRef.current
        ? Math.max(0, totalMessagesRef.current - messagesOffsetRef.current)
          * (loadedMessages / Math.max(1, messagesOffsetRef.current))
        : 0;
      const hidden = Math.max(0, loadedMessages - shownMessages);
      const averageHeight = Math.max(
        MIN_MESSAGE_HEIGHT_PX,
        (container.scrollHeight - spacer.offsetHeight) / shownMessages,
      );
      const wanted = unfetched + hidden > 0
        ? Math.min(
          (unfetched + hidden) * averageHeight + container.clientHeight * OLDER_SPACER_MARGIN_SCREENS,
          container.clientHeight * OLDER_SPACER_MAX_SCREENS,
        )
        : 0;
      const change = Math.round(wanted) - spacer.offsetHeight;
      if (Math.abs(change) < 1) return;
      const top = container.scrollTop;
      const wasAtBottom = container.scrollHeight - top - container.clientHeight < 50;
      // A transcript not yet placed (still at its top before the opening
      // scroll) gets the space only once it is at the bottom or scrolled.
      if (spacer.offsetHeight === 0 && !wasAtBottom && !isUserScrolledUpRef.current) return;
      spacer.style.height = `${Math.round(wanted)}px`;
      // From the position read before resizing: a smaller space first clamps
      // scrollTop to the shorter page, and adding the change to that threw the
      // reader elsewhere. At the bottom the transcript follows new output.
      container.scrollTop = wasAtBottom ? container.scrollHeight : top + change;
    };
    void waitForScrollRest(container, Infinity).then(apply);
  }, []);
  useEffect(() => { refillOlderSpacerRef.current = refillOlderSpacer; }, [refillOlderSpacer]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const holdsPagesUntilRest = usesScrollAnchorFallback();
      if (holdsPagesUntilRest) {
        // The window starts wider than the first page, so without this the
        // next pages would render the moment they arrive, mid-fling.
        setVisibleMessageCount((prev) => Math.min(prev, chatMessagesLengthRef.current));
      }

      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          sessionStore.fetchMore(selectedSession.id, {
            limit: readSessionMessagesPageSize(),
            canRequest: () => (
              isActiveRef.current
              && activeSessionIdRef.current === selectedSession.id
            ),
          }),
          new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), OLDER_PAGE_TIMEOUT_MS); }),
        ]).finally(() => clearTimeout(timeout));
        if (!result) return false;
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (prependedCount === 0) {
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        // The page is in the store, but it only renders once the window
        // widens below. On Safari that waits for the scroll to rest: keeping
        // the reader's place then is invisible, where mid-fling it either
        // stops iOS momentum or hides the new rows until the fling ends.
        // With room for the page in the space above (olderSpacerRef), it can
        // land mid-fling: nothing on screen moves, so nothing has to wait.
        const fitsAboveReader = olderSpacerHeight()
          >= (lastOlderPageHeightRef.current ?? container.clientHeight * ASSUMED_OLDER_PAGE_SCREENS);
        if (holdsPagesUntilRest && !fitsAboveReader) {
          await waitForScrollRest(container);
          if (!isActiveRef.current || activeSessionIdRef.current !== selectedSession.id) {
            return false;
          }
        }
        // Captured now, not when the fetch began: the reader may have kept
        // scrolling while it was in flight, and restoring the older position
        // snapped them back.
        pendingScrollRestoreRef.current = captureScrollRestoreState(container);
        setVisibleMessageCount((prev) => (
          holdsPagesUntilRest
            // Everything loaded so far, plus the usual headroom so new live
            // messages do not push the oldest rows out of the window.
            ? chatMessagesLengthRef.current + INITIAL_VISIBLE_MESSAGES
            : prev + readSessionMessagesPageSize()
        ));
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
        setIsLoadingMoreMessages(false);
      }
    },
    [hasMoreMessages, isActive, isLoadingMoreMessages, selectedProject, selectedSession, sessionStore],
  );

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };

    // Measured from the first loaded message, below any space kept above it.
    const contentTop = container.scrollTop - olderSpacerHeight();
    if (hasMoreMessages && olderSpacerRef.current && olderSpacerHeight() === 0) refillOlderSpacer();
    // Where older messages land in the space above, the reader seldom reaches
    // the first loaded one, so the prompt appears once older pages start loading.
    const scrolledNearTop = olderSpacerRef.current
      ? contentTop < container.clientHeight * SAFARI_OLDER_PAGE_LEAD_SCREENS
      : contentTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    // Older messages start loading ahead of the top, so they are usually in
    // place before the reader gets there. Safari only adds a page once the
    // scroll rests, and a fling crosses one screen before that, leaving the
    // reader bouncing at the top until it settles; there it starts further out,
    // so the page lands in a pause on the way up.
    const leadScreens = usesScrollAnchorFallback() ? SAFARI_OLDER_PAGE_LEAD_SCREENS : 1;
    const shouldLoadOlder = contentTop < Math.max(100, container.clientHeight * leadScreens);
    // With the space above (Safari), a page never moves the reader, so there
    // is no lock between pages: one held until the reader scrolled back below
    // the first message, and a fling past it into the space waited there,
    // blank, until they did. One load runs at a time anyway. After each page
    // the position is checked again, as a reader resting in the space sends
    // no scroll events to ask for the next one.
    const keepsLoading = Boolean(olderSpacerRef.current);
    const checkAgain = () => requestAnimationFrame(() => { void handleScrollRef.current(); });
    // Loaded but not yet shown (after "Load all" on Safari): shown a page at a
    // time into the space above, before anything is fetched.
    if (keepsLoading && chatMessagesLengthRef.current > visibleMessageCountRef.current) {
      if (!shouldLoadOlder) return;
      // The last page is not applied yet; look again once it is.
      if (pendingScrollRestoreRef.current) { checkAgain(); return; }
      // Mid-fling only a page the space above can take: the rest would pile up
      // as an offset that only settles at rest. Otherwise it waits for rest.
      const fitsAbove = olderSpacerHeight()
        >= (lastOlderPageHeightRef.current ?? container.clientHeight * ASSUMED_OLDER_PAGE_SCREENS);
      if (!fitsAbove && !isScrollAtRest(container)) {
        if (!revealWaitsForRestRef.current) {
          revealWaitsForRestRef.current = true;
          void waitForScrollRest(container, Infinity).then(() => {
            revealWaitsForRestRef.current = false;
            checkAgain();
          });
        }
        return;
      }
      pendingScrollRestoreRef.current = captureScrollRestoreState(container);
      setVisibleMessageCount((prev) => Math.min(
        chatMessagesLengthRef.current,
        (Number.isFinite(prev) ? prev : chatMessagesLengthRef.current) + readSessionMessagesPageSize(),
      ));
      checkAgain();
      return;
    }
    if (!allMessagesLoadedRef.current) {
      if (!shouldLoadOlder) { topLoadLockRef.current = false; return; }
      if (!keepsLoading && topLoadLockRef.current) {
        if (contentTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad && !keepsLoading) topLoadLockRef.current = true;
      if (didLoad && keepsLoading) checkAgain();
    }
  }, [hasMoreMessages, isActive, isNearBottom, loadOlderMessages, refillOlderSpacer]);

  // For handleScroll to check the position again after a page lands.
  const handleScrollRef = useRef(handleScroll);
  useEffect(() => { handleScrollRef.current = handleScroll; }, [handleScroll]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (pendingScrollRestoreRef.current) {
      const { height, top, anchor, anchorOffset } = pendingScrollRestoreRef.current;
      const hasAnchor = Boolean(anchor?.isConnected) && anchorOffset !== null;
      // How far what the reader is looking at moved down.
      let shift = hasAnchor
        ? anchor!.getBoundingClientRect().top - container.getBoundingClientRect().top - anchorOffset!
        : top + Math.max(container.scrollHeight - height, 0) - container.scrollTop;
      // Taken out of the space above instead (olderSpacerRef): it shrinks by
      // what was added, so nothing moves and a fling carries on.
      const spacer = olderSpacerRef.current;
      if (spacer && shift > 0) {
        lastOlderPageHeightRef.current = shift;
        const absorbed = Math.min(shift, spacer.offsetHeight);
        spacer.style.height = `${spacer.offsetHeight - absorbed}px`;
        shift -= absorbed;
        refillOlderSpacer();
      }
      // What the space could not take is left to useScrollAnchorFallback
      // mid-fling: moving scrollTop then stopped the fling and snapped the view.
      if (Math.abs(shift) >= 0.5 && (!spacer || isScrollAtRest(container))) {
        container.scrollTop += shift;
      }
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (becameActive) {
      container.scrollTop = isUserScrolledUp
        ? scrollPositionRef.current.top
        : container.scrollHeight;
    }
  }, [chatMessages.length, isActive, isUserScrolledUp, refillOlderSpacer, visibleMessageCount]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);

    pendingInitialScrollRef.current = true;
    setVisibleMessageCount(initialVisibleMessages());
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
    // The space above belongs to the transcript being replaced.
    if (olderSpacerRef.current) olderSpacerRef.current.style.height = '0px';
    lastOlderPageHeightRef.current = null;
  }, [selectedProject?.projectId, selectedSession?.id]);

  // The space above the oldest message appears once there is older history
  // and goes once there is none (or all of it is loaded), each at rest.
  useEffect(() => {
    refillOlderSpacer();
  }, [allMessagesLoaded, hasMoreMessages, isActive, refillOlderSpacer]);

  // Initial scroll to bottom — robust to lazy content reflow.
  // The previous implementation fired one scrollToBottom() at +200ms and
  // cleared the pending flag. When markdown blocks, code highlighting, or
  // images finished rendering after that window, scrollHeight grew but
  // nothing re-anchored the viewport, leaving the chat tab visually
  // "scrolled way up" with the latest assistant message off-screen.
  //
  // This version re-scrolls every animation frame while scrollHeight is
  // still growing, capped at ~1s (60 frames) or 3 consecutive stable
  // frames. Cancels cleanly on session change via the pending flag.
  useEffect(() => {
    if (!isActive) return;
    if (!pendingInitialScrollRef.current || !scrollContainerRef.current || isLoadingSessionMessages) return;
    if (chatMessages.length === 0) { pendingInitialScrollRef.current = false; return; }
    if (searchScrollActiveRef.current) { pendingInitialScrollRef.current = false; return; }

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = 0;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || !scrollContainerRef.current) return;
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
        // Now at the bottom, where adding the space above moves nothing.
        refillOlderSpacer();
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [chatMessages.length, isActive, isLoadingSessionMessages, refillOlderSpacer, scrollToBottom]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it — but
      // only for a response in flight: a session whose turn has ended with
      // background work still running has a canonical id, so a missing
      // selection there is a real navigation away.
      const activity = currentSessionId ? processingSessionsRef.current?.get(currentSessionId) : undefined;
      if (activity && !activity.background) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(initialVisibleMessages());
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: readSessionMessagesPageSize(),
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    resetStreamingState,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          const shouldStickToBottom = isActiveRef.current && isNearBottom();
          await requestLatestMessages(selectedSession.id);

          if (shouldStickToBottom) {
            setTimeout(() => {
              if (!isUserScrolledUpRef.current) {
                scrollToBottom();
              }
            }, 200);
          }
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
              canRequest: () => (
                isActiveRef.current
                && activeSessionIdRef.current === selectedSession.id
              ),
            });
            if (slot) {
              // Fetch the whole transcript so an old hit can be found, but do
              // not render all of it — the window below is widened to exactly
              // what the resolved target needs.
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.offset;
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
            } else if (!isActiveRef.current) {
              setSearchTarget(target);
              return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      // Resolve the target against the loaded transcript rather than the DOM.
      // The store is the freshest source here: the `fetchFromServer` above has
      // landed but `chatMessages` is from the render that scheduled this effect.
      const messagesForSearch = activeSessionIdRef.current
        ? normalizedToChatMessages(sessionStore.getMessages(activeSessionIdRef.current))
        : chatMessages;
      const targetIndex = findSearchTargetIndex(messagesForSearch, target);
      if (targetIndex < 0) {
        // The target is not in the transcript at all. Scrolling somewhere
        // plausible would claim a hit that does not exist.
        searchScrollActiveRef.current = false;
        return;
      }

      // Widen the window so the target is rendered. `visibleMessages` is a tail
      // slice, so covering index N means rendering everything after it.
      const requiredVisibleCount = resolveSearchWindowSize(
        messagesForSearch.length,
        targetIndex,
        SEARCH_TARGET_CONTEXT_MESSAGES,
      );
      setVisibleMessageCount((previous) => Math.max(previous, requiredVisibleCount));

      const targetTimestamp = messagesForSearch[targetIndex].timestamp;

      const scrollToRenderedTarget = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // The target is inside the window by construction, so this only waits
        // for React to commit the widened list. A target collapsed inside a
        // tool group resolves to that group, which carries the same timestamp.
        const targetElement = findRenderedMessageElement(
          container,
          targetTimestamp,
          retriesLeft === 0,
        );

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }

        if (retriesLeft > 0) {
          searchScrollTimerRef.current = setTimeout(
            () => scrollToRenderedTarget(retriesLeft - 1),
            SEARCH_SCROLL_RETRY_DELAY_MS,
          );
          return;
        }

        searchScrollTimerRef.current = null;
        searchScrollActiveRef.current = false;
      };

      searchScrollTimerRef.current = setTimeout(
        () => scrollToRenderedTarget(SEARCH_SCROLL_RETRIES),
        150,
      );
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const response = await api.providers.sessionTokenUsage(selectedSession.id);
        if (response.ok) {
          const payload = await response.json();
          setTokenBudget(payload.data ?? null);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useEffect(() => {
    if (!isActive) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current) return;

    if (!isUserScrolledUp) {
      setTimeout(() => {
        if (!isUserScrolledUpRef.current) {
          scrollToBottom();
        }
      }, 50);
    }
  }, [chatMessages.length, isActive, isLoadingMoreMessages, isUserScrolledUp, scrollToBottom]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // Opening a session keeps re-scrolling to the bottom while its rows settle
  // (and again when a page of older messages merges in); a reader who has
  // started scrolling was yanked back down. Their first touch, wheel or click
  // ends that.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;
    const handleReaderIntent = () => {
      pendingInitialScrollRef.current = false;
      releaseBottomPin();
    };
    const options = { passive: true } as const;
    container.addEventListener('touchstart', handleReaderIntent, options);
    container.addEventListener('wheel', handleReaderIntent, options);
    container.addEventListener('mousedown', handleReaderIntent, options);
    return () => {
      container.removeEventListener('touchstart', handleReaderIntent);
      container.removeEventListener('wheel', handleReaderIntent);
      container.removeEventListener('mousedown', handleReaderIntent);
    };
  }, [isActive, releaseBottomPin, selectedSession?.id]);

  // Rotating a phone or tablet (or resizing the window) reflows every row; a
  // reader who was at the bottom stays there rather than ending wherever the
  // old offset now points.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = container.clientWidth;
    let lastHeight = container.clientHeight;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = container;
      // Zero is a hidden tab, not a new size.
      if (clientWidth === 0 || clientHeight === 0) return;
      if (clientWidth === lastWidth && clientHeight === lastHeight) return;
      lastWidth = clientWidth;
      lastHeight = clientHeight;
      if (!isUserScrolledUpRef.current) {
        scrollToBottom();
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isActive, scrollToBottom, selectedSession?.id]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;
    const scrollRestoreState = container ? captureScrollRestoreState(container) : null;
    if (usesScrollAnchorFallback()) {
      // The window runs ahead of what is loaded; without this the first of the
      // older messages would all appear at once when they arrive.
      setVisibleMessageCount((prev) => Math.min(prev, chatMessagesLengthRef.current));
    }

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (scrollRestoreState) {
          pendingScrollRestoreRef.current = scrollRestoreState;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        // Safari shows them a page at a time as the reader nears the top
        // (handleScroll): a thousand rows at once could only start as
        // estimates, each corrected mid-fling as it was reached.
        if (!usesScrollAnchorFallback()) setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [isActive, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    return normalizedToChatMessages(sessionStore.getMessages(sessionId));
  }, [sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  // Brings one row into view even when it is outside the visible window or
  // sits in a lazy row that has not mounted: widen the window to include it,
  // then scroll to the row's wrapper, which is in the DOM as soon as the row
  // is inside the window, mounted or not.
  const revealMessage = useCallback((message: ChatMessage) => {
    const index = chatMessages.indexOf(message);
    if (index >= 0) {
      setVisibleMessageCount((prev) => visibleCountToReveal(chatMessages.length, index, prev));
    }

    const attempt = (remaining: number) => {
      const container = scrollContainerRef.current;
      // The widened window commits after this frame, so the row can be absent
      // on the first attempts; only the last one may settle for the nearest
      // row (a hit collapsed inside a tool group carries the group's
      // timestamp), or the first attempt scrolls to an unrelated row and the
      // retries never run.
      const element = container ? findRenderedMessageElement(container, message.timestamp, remaining === 0) : null;
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    requestAnimationFrame(() => attempt(10));
  }, [chatMessages]);

  return {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    olderSpacerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  };
}
