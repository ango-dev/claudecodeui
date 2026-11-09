import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  Dispatch,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  SetStateAction,
  TouchEvent,
} from 'react';
import { useDropzone } from 'react-dropzone';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { PROVIDER_PERMISSION_PREFERENCE_KEYS } from '@/shared/constants';
import { readUserPreference } from '@/shared/userSettings';
import { createLocalMessageId, isPromptCommand, withPastedTexts } from '@/shared/utils';
import type { BackgroundSendChoice, BackgroundSendPrompt, BackgroundStopReason, CommandModalPayload, CostCommandData, HelpCommandData, MarkSessionProcessing, ModelCommandData, PastedText, PendingSteer, QueuedDraft, SessionActivityMap, StatusCommandData, SteerOutcome,QueuedSendOptions,ChatAttachment,ChatMessage,PendingPermissionRequest,PermissionMode,SessionEstablishedContext,Project,ProjectSession,LLMProvider,SlashCommand } from '@/shared/types';
import { grantClaudeToolPermission } from '@/modules/chat/utils/chatPermissions';
import {
  appendQueuedMessage,
  hydrateChatDrafts,
  readDraftText,
  readQueuedMessages,
  removeQueuedMessage,
  subscribeToChatDrafts,
  writeDraftText,
} from '@/shared/chatDrafts';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import { describeBackgroundTask, ownBackgroundTasks } from '@/modules/chat/utils/backgroundTasks';
import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { useInputHistory } from '@/modules/chat/hooks/useInputHistory';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { confirmDialog } from '@/shared/ui';
import { useAskSideQuestion } from '@/modules/chat/hooks/useSideQuestions';

type UseChatComposerStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  permissionMode: PermissionMode | string;
  cyclePermissionMode: () => void;
  resolvePermissionModeForProvider: (provider: LLMProvider, requestedMode: PermissionMode | string) => PermissionMode;
  /**
   * Model every send and command carries: the open session's model when there
   * is one, otherwise the user's per-provider selection.
   */
  currentProviderModel: string;
  currentProviderEffort: string;
  isLoading: boolean;
  processingSessions?: SessionActivityMap;
  canAbortSession: boolean;
  tokenBudget: Record<string, unknown> | null;
  sendMessage: (message: unknown) => void;
  /** Whether the chat socket is currently open; a side-question ask while it is not would send nothing and leave the optimistic entry pending forever. */
  isConnected?: boolean;
  sendByCtrlEnter?: boolean;
  /** From the capability matrix, like `supportsSideQuestions`: whether the provider can take a message into a running turn (`chat.steer`). Gates the send menu's Steer choice. */
  supportsSteering?: boolean;
  onSessionProcessing?: MarkSessionProcessing;
  /**
   * Invoked with the freshly allocated session id when the user sends the
   * first message of a brand-new conversation. The backend allocates the id
   * via POST /api/providers/sessions BEFORE the websocket send, so the id is
   * stable for the conversation's whole lifetime — the consumer navigates to
   * /session/:id and records it as the current session.
   */
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  scrollToBottom: () => void;
  addMessage: (msg: ChatMessage) => void;
  setIsUserScrolledUp: (isScrolledUp: boolean) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /** From the capability matrix, exactly like `supportsSessionForking`; false until it has loaded. Gates the `/btw` branch. */
  supportsSideQuestions?: boolean;
};

type MentionableFile = {
  name: string;
  path: string;
};

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};





type SubmitOptions = {
  /**
   * Send the text as a chat message even when it starts with "/" (or is
   * "help"). Set only for the re-submit of a custom command's expanded body:
   * like the Claude Code CLI, that body is never read as a command again, so a
   * body that opens with its own or another command's name cannot loop or
   * run that command instead of being sent.
   */
  skipCommandInterception?: boolean;
  /**
   * The send menu already answered the background-work question before
   * `submitMessage` runs, so the dialog that would ask it again never opens.
   */
  presetBackgroundChoice?: 'queue' | 'send';
  /**
   * The send menu's Steer row: while a turn runs, send the message into it
   * (read at the agent's next tool call) instead of queueing it for after.
   * Falls through to the ordinary send when no turn is running any more.
   */
  steerIntoTurn?: boolean;
};

const createFakeSubmitEvent = () => {
  return { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
};

/**
 * A v4 UUID for a steered message. The id becomes the message's transcript
 * uuid, so it must be a real one. `crypto.randomUUID` only exists in secure
 * contexts, and the app is often opened over plain http on a LAN address
 * (a phone on the same network), so this falls back to `getRandomValues`.
 */
const createSteerMessageId = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Whether a live user message is the echo of the steered message with this id. */
const isEchoOfSteer = (echoId: string, messageId: string): boolean => (
  // A text-only message is echoed under its own id; one with images is split
  // into parts named `<id>_text_<n>` / `<id>_images`.
  echoId === messageId || echoId.startsWith(`${messageId}_`)
);

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};


/**
 * A message to submit in place of the composer's own input: a plan follow-up.
 * It has no queue id until it is queued.
 */
type ComposerSubmission = Omit<QueuedDraft, 'id'>;

/**
 * A session's queue as the draft store holds it, oldest first. `files` holds
 * the browser File objects of messages queued from this composer; a message
 * restored from storage only has its uploaded copies.
 */
const restoreQueuedDrafts = (sessionKey: string, files: Map<string, File[]>): QueuedDraft[] => (
  readQueuedMessages(sessionKey).map((saved) => ({
    id: saved.id,
    content: saved.content,
    attachments: files.get(saved.id) ?? [],
    uploadedAttachments: saved.attachments,
    options: saved.options,
  }))
);

const sameQueuedDrafts = (left: QueuedDraft[], right: QueuedDraft[]): boolean => (
  left.length === right.length
  && left.every((draft, index) => draft.id === right[index]?.id && draft.content === right[index]?.content)
);

/**
 * A paste this long becomes a card, as Claude does, instead of filling the
 * message box: past this it is easier to read and edit on its own.
 */
const PASTE_CARD_MIN_CHARACTERS = 1_000;
const PASTE_CARD_MIN_LINES = 15;

const isLongPaste = (text: string): boolean => (
  text.length >= PASTE_CARD_MIN_CHARACTERS || text.split('\n').length >= PASTE_CARD_MIN_LINES
);

/**
 * Asks the server whether sending with these options would stop the
 * session's background work, and why: only the server knows what the process
 * holding that work was started with. A check that fails says it would, so
 * the user is asked rather than the work stopped unasked.
 */
const readBackgroundStopReason = async (
  sessionId: string,
  options: QueuedSendOptions,
): Promise<BackgroundStopReason | null> => {
  try {
    const response = await api.providers.sendCheck(sessionId, options);
    if (!response.ok) {
      return 'unavailable';
    }
    const body = await response.json() as { data?: { stopsBackgroundWork?: boolean; reason?: BackgroundStopReason | null } };
    if (!body.data?.stopsBackgroundWork) {
      return null;
    }
    return body.data.reason ?? 'unavailable';
  } catch {
    return 'unavailable';
  }
};

/** An id that is unique across devices without asking the server; for queued messages and pasted texts. */
const createLocalId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
);

const getNotificationSessionSummary = (
  selectedSession: ProjectSession | null,
  fallbackInput: string,
): string | null => {
  const sessionSummary = selectedSession?.summary || selectedSession?.name || selectedSession?.title;
  if (typeof sessionSummary === 'string' && sessionSummary.trim()) {
    const normalized = sessionSummary.replace(/\s+/g, ' ').trim();
    return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  }

  const normalizedFallback = fallbackInput.replace(/\s+/g, ' ').trim();
  if (!normalizedFallback) {
    return null;
  }

  return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
};

/**
 * Enter that CONFIRMS an IME candidate must not also submit.
 *
 * `event.isComposing` alone is not enough: Safari fires `compositionend` BEFORE the confirming
 * Enter's `keydown`, so the flag is already `false` by the time the handler runs. Chrome and
 * Firefox fire it after, which is why the naive guard looks correct on those two and the bug
 * reads as Safari-only. A tight window after `compositionend` covers it — that sequence is
 * synchronous (microseconds), while a human pressing Enter a second time takes >= 100ms and
 * never lands inside it.
 */
const SAFARI_IME_RACE_WINDOW_MS = 30;

/**
 * A phone or tablet types through an on-screen keyboard: its return key is
 * labelled "new line", and Shift+Enter — the desktop combination for a newline
 * in Enter-to-send mode — cannot be typed on it at all. `(pointer: coarse)`
 * marks exactly those primary inputs; a touch laptop keeps its fine primary
 * pointer and with it the desktop Enter behaviour.
 */
function isSoftKeyboardEnvironment(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

/** The composer's input state machine — text, drafts, sending, queueing and the keyboard handling around them; used by ChatInterface. */
export function useChatComposerState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  permissionMode,
  cyclePermissionMode,
  resolvePermissionModeForProvider,
  currentProviderModel,
  currentProviderEffort,
  isLoading,
  processingSessions,
  canAbortSession,
  tokenBudget,
  sendMessage,
  isConnected = true,
  supportsSideQuestions = false,
  sendByCtrlEnter,
  supportsSteering = false,
  onSessionProcessing,
  onSessionEstablished,
  onFileOpen,
  onShowSettings,
  scrollToBottom,
  addMessage,
  setIsUserScrolledUp,
  setPendingPermissionRequests,
}: UseChatComposerStateArgs) {
  const { t } = useTranslation('chat');
  // The composer text together with the chat scope it belongs to. They are one
  // state rather than a value plus a ref because they have to move in lockstep:
  // on a session switch there is one commit where the scope has already changed
  // while the text has not, and anything that persisted the text in that commit
  // would write the previous session's message into the new session's draft.
  // A ref cannot express this — React evaluates a state updater eagerly, so a
  // ref set inside one is already ahead by the time the effects run.
  //
  // Restored synchronously from the draft mirror so a reload shows what was
  // being typed on the first paint rather than after the drafts request lands.
  /**
   * The already-sent message the composer is currently replacing, or null.
   *
   * Holds the anchor rather than the message, because that is all the send
   * needs and it keeps a stale message object from being captured while the
   * transcript refreshes underneath the composer.
   */
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);

  const [inputState, setInputState] = useState<{ scope: string | null; value: string }>(() => {
    if (typeof window === 'undefined') {
      return { scope: null, value: '' };
    }
    const initialScope = selectedSession?.id || currentSessionId
      || (selectedProject ? `project:${selectedProject.projectId}` : null);
    return {
      scope: initialScope,
      value: initialScope ? readDraftText(initialScope) : '',
    };
  });
  const input = inputState.value;
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  // Long pastes shown as cards rather than in the message box; sent ahead of
  // the typed text and cleared with it, like attached files.
  const [pastedTexts, setPastedTexts] = useState<PastedText[]>([]);
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());
  const [isTextareaExpanded, setIsTextareaExpanded] = useState(false);
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputHighlightRef = useRef<HTMLDivElement>(null);
  const textareaLineHeightRef = useRef<number | null>(null);
  const lastAutosizedInputRef = useRef<string | null>(null);
  const handleSubmitRef = useRef<
    ((
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: ComposerSubmission,
      submitOptions?: SubmitOptions,
    ) => Promise<void>) | null
  >(null);
  const inputValueRef = useRef(input);
  const selectedProjectId = selectedProject?.projectId;
  // Prefer the stable backend-allocated id (selectedSession.id) but fall back
  // to currentSessionId for a just-established session that hasn't been
  // handed back to the parent's `selectedSession` prop yet.
  const sessionKey = selectedSession?.id || currentSessionId || null;
  // Always the composer's own `sendMessage`, never `useWebSocket()` directly,
  // which throws outside a provider and would break the composer's tests.
  const askSideQuestion = useAskSideQuestion(sendMessage);
  // The chat scope a draft belongs to: the open session, or the project for a
  // chat that has not been sent yet and so has no session id. Drafts used to be
  // keyed by project alone, so every session in a project shared one draft.
  const draftScope = sessionKey ?? (selectedProjectId ? `project:${selectedProjectId}` : null);
  const draftScopeRef = useRef(draftScope);
  draftScopeRef.current = draftScope;
  // Composition is tracked on `window` in the capture phase rather than on the textarea, so a
  // composition that starts in one field and ends after focus moves still closes cleanly.
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onStart = () => {
      isComposingRef.current = true;
    };
    const onEnd = () => {
      isComposingRef.current = false;
      lastCompositionEndAtRef.current = performance.now();
    };
    // `blur` does not bubble, but a capture-phase listener on `window` still sees it on the way
    // down — otherwise a composition abandoned by clicking away would stay open forever.
    const onBlur = () => {
      isComposingRef.current = false;
    };
    window.addEventListener('compositionstart', onStart, true);
    window.addEventListener('compositionend', onEnd, true);
    window.addEventListener('blur', onBlur, true);
    return () => {
      window.removeEventListener('compositionstart', onStart, true);
      window.removeEventListener('compositionend', onEnd, true);
      window.removeEventListener('blur', onBlur, true);
    };
  }, []);

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    setInputState((previous) => ({
      scope: draftScopeRef.current,
      value: typeof next === 'function' ? next(previous.value) : next,
    }));
  }, []);
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;

  // Recall writes go through the same pair of stores a send reads: the state
  // (for the render) and inputValueRef (so an immediate Enter submits the
  // recalled text, not a stale value).
  const setInputFromHistory = useCallback((value: string) => {
    setInput(value);
    inputValueRef.current = value;
  }, [setInput]);
  const { recordSentMessage, handleHistoryKeyDown } = useInputHistory({
    setInput: setInputFromHistory,
    textareaRef,
    scope: draftScope,
  });

  // Browser File objects of messages queued from this composer, by queue id,
  // so editing one puts its files back into the composer. They cannot be
  // stored, so they live only as long as this composer.
  const queuedFilesRef = useRef(new Map<string, File[]>());
  // This session's queue, mirrored from the draft store (which the server
  // keeps in step) so the cards re-render as messages are queued, edited,
  // removed, or sent by the server.
  const [queuedDrafts, setQueuedDrafts] = useState<QueuedDraft[]>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return [];
    }
    return restoreQueuedDrafts(sessionKey, queuedFilesRef.current);
  });

  // Messages this tab sent into a running turn that the agent has not read
  // yet. Each is a card above the composer until its echo reaches the
  // transcript; the run ending without it puts the text back in the composer,
  // and a refusal (the turn had already ended) queues it as the next turn.
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  // Read by the outcome handler, which the realtime listener calls between
  // renders: a refusal can follow an acceptance before React re-renders.
  // Written only through `updatePendingSteers` below, with the state.
  const pendingSteersRef = useRef(pendingSteers);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = await confirmDialog(
        'This command contains bash commands that will be executed. Do you want to proceed?',
        { confirmLabel: 'Run' },
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    // The expanded body is the message itself: it skips slash-command interception.
    setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current(createFakeSubmitEvent(), undefined, { skipCommandInterception: true });
      }
    }, 0);
  }, [addMessage]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        // Everything typed after the command name is its argument text, line
        // breaks included (`[\s\S]`, unlike `.`), trimmed as the Claude Code CLI
        // does. `$ARGUMENTS` gets it verbatim; `$1`, `$2`, … get its tokens.
        // The name must open the input and end at whitespace or the end: a pick
        // from the slash menu passes the whole composer, where the name may
        // appear later or inside a longer word ("see /echo2 …" has no arguments).
        const commandMatch = effectiveInput
          .trimStart()
          .match(new RegExp(`^${escapeRegExp(command.name)}(?=\\s|$)([\\s\\S]*)`));
        const rawArgs = commandMatch ? commandMatch[1].trim() : '';
        const args = rawArgs ? rawArgs.split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          rawArgs,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  const {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  } = useFileMentions({
    selectedProject,
    input,
    setInput,
    textareaRef,
  });

  const syncInputOverlayScroll = useCallback((target: HTMLTextAreaElement) => {
    if (!inputHighlightRef.current || !target) {
      return;
    }
    inputHighlightRef.current.scrollTop = target.scrollTop;
    inputHighlightRef.current.scrollLeft = target.scrollLeft;
  }, []);

  const resizeTextarea = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = 'auto';
    const nextHeight = Math.max(22, target.scrollHeight);
    target.style.height = `${nextHeight}px`;

    let lineHeight = textareaLineHeightRef.current;
    if (!lineHeight) {
      lineHeight = parseInt(window.getComputedStyle(target).lineHeight);
      textareaLineHeightRef.current = Number.isFinite(lineHeight) ? lineHeight : 24;
    }

    const expanded = nextHeight > (textareaLineHeightRef.current || 24) * 2;
    setIsTextareaExpanded((previous) => previous === expanded ? previous : expanded);
    lastAutosizedInputRef.current = target.value;
  }, []);

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      const pastedText = event.clipboardData.getData('text/plain');
      if (pastedText && isLongPaste(pastedText)) {
        event.preventDefault();
        setPastedTexts((previous) => [...previous, { id: createLocalId(), text: pastedText }]);
      }

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const updatePastedText = useCallback((id: string, text: string) => {
    setPastedTexts((previous) => previous.map((pasted) => (pasted.id === id ? { ...pasted, text } : pasted)));
  }, []);

  const removePastedText = useCallback((id: string) => {
    setPastedTexts((previous) => previous.filter((pasted) => pasted.id !== id));
  }, []);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  // Snapshot of everything `chat.send` needs beyond the text itself. Built at
  // send time for immediate sends and at queue time for queued ones, so a
  // queued message keeps the provider settings it was composed under even if
  // it is later dispatched outside this composer (app-level auto-send).
  const buildSendOptions = useCallback((currentInput: string): QueuedSendOptions => {
    const getToolsSettings = () => readUserPreference(
      PROVIDER_PERMISSION_PREFERENCE_KEYS[provider],
      {
        allowedTools: [],
        disallowedTools: [],
        skipPermissions: false,
      },
    );

    const toolsSettings = getToolsSettings();

    return {
      model: currentProviderModel,
      effort: currentProviderEffort,
      permissionMode: resolvePermissionModeForProvider(provider, permissionMode),
      toolsSettings,
      skipPermissions: toolsSettings?.skipPermissions || false,
      sessionSummary: getNotificationSessionSummary(selectedSession, currentInput),
    };
  }, [
    currentProviderEffort,
    currentProviderModel,
    permissionMode,
    provider,
    resolvePermissionModeForProvider,
    selectedSession,
  ]);

  // Read at send time through a ref: the map changes on every poll, and a
  // submit handler rebuilt that often would re-render the whole composer.
  const processingSessionsRef = useRef(processingSessions);
  useEffect(() => {
    processingSessionsRef.current = processingSessions;
  }, [processingSessions]);

  // Sending over background work, when that would stop it, asks first. The
  // dialog is rendered by the composer; the submit awaits the user's choice
  // through this resolver.
  const [backgroundSendPrompt, setBackgroundSendPrompt] = useState<BackgroundSendPrompt | null>(null);
  const backgroundSendResolverRef = useRef<((choice: BackgroundSendChoice) => void) | null>(null);

  const askBeforeSendingOverBackgroundWork = useCallback(
    (prompt: BackgroundSendPrompt) => new Promise<BackgroundSendChoice>((resolve) => {
      // Only one prompt at a time: a stale one is answered "cancel".
      backgroundSendResolverRef.current?.('cancel');
      backgroundSendResolverRef.current = resolve;
      setBackgroundSendPrompt(prompt);
    }),
    [],
  );

  const resolveBackgroundSendPrompt = useCallback((choice: BackgroundSendChoice) => {
    const resolve = backgroundSendResolverRef.current;
    backgroundSendResolverRef.current = null;
    setBackgroundSendPrompt(null);
    resolve?.(choice);
  }, []);

  // An unmounted composer cannot answer; let the pending submit finish.
  useEffect(() => () => {
    backgroundSendResolverRef.current?.('cancel');
    backgroundSendResolverRef.current = null;
  }, []);

  // A side question never touches the session: on a successful ask, the
  // typed text is cleared the same way a sent message is, without the parts
  // (queued draft, session processing) that belong only to an actual turn.
  // A side question cannot carry attachments, so they are left untouched — unlike a real
  // send, which takes them. Called only when `askSideQuestion` returned
  // `true`; a refusal (no connection) leaves the text in place too, so the
  // user does not lose what they typed.
  //
  // Also ends edit mode, matching `cancelEditMessage`: a side question asked
  // while editing a sent message must not leave `editingAnchorId` set over
  // the now-empty composer, which previously turned the next plain send into
  // a `chat.edit-send` that replaced the edited turn and everything after it.
  const clearComposerAfterSideQuestion = useCallback(() => {
    setInput('');
    inputValueRef.current = '';
    setEditingAnchorId(null);
    resetCommandMenuState();
    setIsTextareaExpanded(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    if (draftScopeRef.current) {
      writeDraftText(draftScopeRef.current, '');
    }
  }, [resetCommandMenuState, setInput]);

  // Shared by the `/btw` command, Option/Alt+Enter, the background-send
  // dialog's side question choice and the send menu's side question row: all
  // four ask the same way and clear the composer the same way on success, and
  // refuse the same way when there is nothing to ask it on — no connection,
  // no provider support, or (a brand-new chat) no session yet. Without this
  // check here, a caller with no session relied on `useAskSideQuestion`
  // refusing a null `sessionId` on its own, which it does silently: the
  // keypress did nothing, with no error and no explanation. Checking it once,
  // here, means every caller gets the same `noSession` message instead of
  // each needing its own copy of the check.
  const askSideQuestionAndClear = useCallback(
    (sessionId: string | null, text: string) => {
      if (!supportsSideQuestions) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.unsupported'),
          timestamp: Date.now(),
        });
        return;
      }
      if (!sessionId) {
        addMessage({
          type: 'error',
          content: t('sideQuestion.noSession'),
          timestamp: Date.now(),
        });
        return;
      }
      if (askSideQuestion(sessionId, text, { model: currentProviderModel }, isConnected)) {
        clearComposerAfterSideQuestion();
      }
    },
    [addMessage, askSideQuestion, clearComposerAfterSideQuestion, currentProviderModel, isConnected, supportsSideQuestions, t],
  );

  // Adds a composed message to the end of a session's queue (the server sends
  // them one per turn, oldest first) and clears the composer it came from.
  // Used while a turn is in flight and when the user chooses to queue behind
  // background work. Attachments must already be uploaded.
  const queueMessage = useCallback(
    (
      queuedSessionKey: string,
      message: { content: string; options: QueuedSendOptions; uploadedAttachments: unknown[]; files: File[] },
      fromComposerInput: boolean,
    ) => {
      // The card shows at once; the store takes it back out if the server
      // refuses it.
      const id = createLocalId();
      queuedFilesRef.current.set(id, message.files);
      void appendQueuedMessage(queuedSessionKey, {
        id,
        content: message.content,
        options: message.options,
        attachments: message.uploadedAttachments,
      }).then((result) => {
        if (result.kept) {
          return;
        }
        queuedFilesRef.current.delete(id);
        addMessage({
          type: 'error',
          content: `Could not queue your message${result.reason ? `: ${result.reason}` : ''}. Press Up in the message box to get it back, then try again.`,
          timestamp: new Date(),
        });
      });

      // Recorded under the session the message was queued FOR, and before
      // the session-switch return below — the queued text must be
      // recallable even when it dispatches without this composer.
      recordSentMessage(message.content, queuedSessionKey);

      // A plan follow-up is not the composer's input, and if the user
      // changed sessions during upload the input now belongs to another
      // session: either way it is left as it is.
      if (!fromComposerInput || sessionKeyRef.current !== queuedSessionKey) {
        return;
      }

      setInput('');
      inputValueRef.current = '';
      setAttachedFiles([]);
      setPastedTexts([]);
      setFileErrors(new Map());
      resetCommandMenuState();
      setIsTextareaExpanded(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [addMessage, recordSentMessage, resetCommandMenuState, setInput],
  );

  // Every change to the pending steers goes through here so the ref the
  // outcome handler reads is never behind the state.
  const updatePendingSteers = useCallback((update: (current: PendingSteer[]) => PendingSteer[]) => {
    const next = update(pendingSteersRef.current);
    pendingSteersRef.current = next;
    setPendingSteers(next);
  }, []);

  // Sends a message into the session's running turn (`chat.steer`): the agent
  // reads it at its next tool call, without the turn stopping. It leaves the
  // composer at once, as a sent message does, and waits as a card until the
  // agent reads it. Attachments must already be uploaded.
  const steerIntoRunningTurn = useCallback(
    (message: { content: string; attachments: File[]; uploadedAttachments: unknown[] }, steerSessionKey: string) => {
      const messageId = createSteerMessageId();
      updatePendingSteers((current) => [...current, {
        messageId,
        sessionKey: steerSessionKey,
        content: message.content,
        attachments: message.attachments,
        uploadedAttachments: message.uploadedAttachments,
        status: 'sending',
      }]);
      sendMessage({
        type: 'chat.steer',
        sessionId: steerSessionKey,
        messageId,
        content: message.content,
        options: { attachments: message.uploadedAttachments },
      });
      recordSentMessage(message.content, steerSessionKey);

      if (sessionKeyRef.current === steerSessionKey) {
        setInput('');
        inputValueRef.current = '';
        setAttachedFiles([]);
        // The pasted texts went out with it, ahead of the typed text.
        setPastedTexts([]);
        setFileErrors(new Map());
        resetCommandMenuState();
        setIsTextareaExpanded(false);
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
        }
        if (draftScopeRef.current) {
          writeDraftText(draftScopeRef.current, '');
        }
      } else if (readDraftText(steerSessionKey) === message.content) {
        // The user changed sessions during the upload; the composer they left
        // must not still hold the message as its draft.
        writeDraftText(steerSessionKey, '');
      }
    },
    [recordSentMessage, resetCommandMenuState, sendMessage, setInput, updatePendingSteers],
  );

  /**
   * Settles a steered message as the realtime handler reports on it. Used by
   * ChatInterface, which hands it to the realtime handler.
   */
  const handleSteerOutcome = useCallback(
    (_sessionId: string, messageId: string, outcome: SteerOutcome) => {
      if (outcome === 'delivered') {
        if (pendingSteersRef.current.some((steer) => isEchoOfSteer(messageId, steer.messageId))) {
          updatePendingSteers((current) => current.filter((steer) => !isEchoOfSteer(messageId, steer.messageId)));
        }
        return;
      }

      const steer = pendingSteersRef.current.find((candidate) => candidate.messageId === messageId);
      if (!steer) {
        return;
      }
      if (outcome === 'accepted') {
        updatePendingSteers((current) => current.map((candidate) => (
          candidate.messageId === messageId ? { ...candidate, status: 'accepted' } : candidate
        )));
        return;
      }

      // Refused: the turn had already ended when it arrived. The user meant it
      // for this conversation now, so it goes out as the next turn — the
      // queue sends it as soon as the session is idle, which it about is.
      updatePendingSteers((current) => current.filter((candidate) => candidate.messageId !== messageId));
      // It already left the composer, so whatever was typed since stays put.
      queueMessage(steer.sessionKey, {
        content: steer.content,
        options: buildSendOptions(steer.content),
        uploadedAttachments: steer.uploadedAttachments,
        files: steer.attachments,
      }, false);
    },
    [buildSendOptions, queueMessage, updatePendingSteers],
  );

  // The run ended with a steered message the server took but the agent never
  // read — the user stopped the run, or it failed. Nothing will send it now,
  // so it goes back into the composer (ahead of anything typed since) rather
  // than vanishing or being sent behind the user's back after a stop.
  const wasLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoading;
    if (!wasLoading || isLoading || !sessionKey) {
      return;
    }
    const unread = pendingSteersRef.current.filter(
      (steer) => steer.sessionKey === sessionKey && steer.status === 'accepted',
    );
    if (unread.length === 0) {
      return;
    }
    updatePendingSteers((current) => current.filter((steer) => !unread.includes(steer)));
    const restored = [...unread.map((steer) => steer.content), inputValueRef.current]
      .filter((part) => part.trim())
      .join('\n\n');
    setInput(restored);
    inputValueRef.current = restored;
    setAttachedFiles((current) => [...unread.flatMap((steer) => steer.attachments), ...current]);
    writeDraftText(sessionKey, restored);
  }, [isLoading, sessionKey, setInput, updatePendingSteers]);

  // Cards belong to the session they were sent into; switching away drops
  // them (the messages themselves are already the run's, on the server).
  useEffect(() => {
    if (pendingSteersRef.current.some((steer) => steer.sessionKey !== sessionKey)) {
      updatePendingSteers((current) => current.filter((steer) => steer.sessionKey === sessionKey));
    }
  }, [sessionKey, updatePendingSteers]);

  // Only the open session's cards are shown.
  const visiblePendingSteers = useMemo(
    () => pendingSteers.filter((steer) => steer.sessionKey === sessionKey),
    [pendingSteers, sessionKey],
  );

  const submitMessage = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: ComposerSubmission,
      submitOptions?: SubmitOptions,
    ) => {
      event.preventDefault();
      // What was typed (or the follow-up being submitted), without the pasted
      // texts: only it can be a slash command, and it names a new chat.
      const typedInput = queuedSubmission?.content ?? inputValueRef.current;
      const currentInput = queuedSubmission ? typedInput : withPastedTexts(pastedTexts, typedInput);
      const summaryInput = typedInput.trim() ? typedInput : currentInput;
      const currentAttachments = queuedSubmission?.attachments ?? attachedFiles;
      const previouslyUploadedAttachments = queuedSubmission?.uploadedAttachments ?? [];
      if (
        (
          !currentInput.trim()
          && currentAttachments.length === 0
          && previouslyUploadedAttachments.length === 0
        )
        || !selectedProject
      ) {
        return;
      }

      // `/btw <question>` never becomes a turn: checked before the in-flight
      // queue below, since that branch runs before slash-command
      // interception ever would. Recognised in every state, including a
      // brand-new chat that has no session yet — there is nothing to ask it
      // on the side of, so `askSideQuestionAndClear` refuses it with an error
      // instead of falling through to the normal send path below, which
      // would otherwise allocate a session and send the raw `/btw ...` text
      // as a turn. A queued re-dispatch never carries this prefix, so it is
      // skipped.
      if (!queuedSubmission && !submitOptions?.skipCommandInterception) {
        // The typed text only: pasted cards go ahead of it, so with any the
        // message no longer starts with the command.
        const btwMatch = typedInput.trim().match(/^\/btw(?:\s+([\s\S]*))?$/i);
        if (btwMatch) {
          askSideQuestionAndClear(sessionKey, btwMatch[1] ?? '');
          return;
        }
      }

      // A turn is already in flight: stash this message instead of sending it.
      // Upload attached files now so the queued record contains durable image
      // descriptors that can be sent even if another session is open later.
      if (isLoading) {
        const queuedSessionKey = sessionKey;
        if (!queuedSessionKey) {
          // Nothing has been sent yet, so there is no session to queue for.
          return;
        }

        // Steering sends the message into the running turn instead of after
        // it, when the send menu asked for that and the provider can take it.
        // A slash command is a turn of its own, so it always waits in the queue.
        const steersIntoTurn = submitOptions?.steerIntoTurn === true
          && supportsSteering
          && !queuedSubmission
          && !typedInput.trimStart().startsWith('/');
        const queuedOptions = queuedSubmission?.options ?? buildSendOptions(summaryInput);
        let uploadedAttachments: unknown[] = [];
        try {
          uploadedAttachments = [
            ...previouslyUploadedAttachments,
            ...await uploadAttachmentFiles(currentAttachments),
          ];
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Queued file upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (steersIntoTurn) {
          steerIntoRunningTurn({
            content: currentInput,
            attachments: currentAttachments,
            uploadedAttachments,
          }, queuedSessionKey);
          return;
        }

        queueMessage(queuedSessionKey, {
          content: currentInput,
          options: queuedOptions,
          uploadedAttachments,
          files: currentAttachments,
        }, !queuedSubmission);
        return;
      }

      // Intercept slash commands only when "/" is the first input character.
      // Also accept exact "help" as a convenience alias for users who expect CLI-style help.
      const commandInput = currentInput.trimEnd();
      const isHelpAlias = commandInput.trim().toLowerCase() === 'help';
      // Pasted text that happens to start with a command name is not a command.
      if (
        !submitOptions?.skipCommandInterception
        && ((commandInput.startsWith('/') && typedInput.trimStart().startsWith('/')) || isHelpAlias)
      ) {
        // The name ends at the first whitespace of any kind, so "/cmd" followed
        // by a line break still runs /cmd (the Claude Code CLI splits the same way).
        const firstWhitespace = commandInput.search(/\s/);
        const commandName = isHelpAlias
          ? '/help'
          : firstWhitespace > 0 ? commandInput.slice(0, firstWhitespace) : commandInput;
        const matchedCommand =
          slashCommands.find((cmd: SlashCommand) => cmd.name === commandName) ||
          (commandName === '/help'
            ? ({
                name: '/help',
                description: 'Show help documentation for Claude Code',
                namespace: 'builtin',
                metadata: { type: 'builtin' },
              } as SlashCommand)
            : undefined);
        if (matchedCommand && !isPromptCommand(matchedCommand)) {
          executeCommand(matchedCommand, isHelpAlias ? '/help' : commandInput);
          recordSentMessage(currentInput);
          setInput('');
          inputValueRef.current = '';
          setAttachedFiles([]);
          setPastedTexts([]);
          setFileErrors(new Map());
          resetCommandMenuState();
          setIsTextareaExpanded(false);
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
          }
          return;
        }
      }

      const messageContent = currentInput;

      let uploadedAttachments = previouslyUploadedAttachments;
      if (uploadedAttachments.length === 0 && currentAttachments.length > 0) {
        try {
          uploadedAttachments = await uploadAttachmentFiles(currentAttachments);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('File upload failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to upload files: ${message}`,
            timestamp: new Date(),
          });
          return;
        }
      }

      const resolvedProjectPath = selectedProject.fullPath || selectedProject.path || '';
      const sessionSummary = getNotificationSessionSummary(selectedSession, summaryInput);

      // The conversation always has a stable backend-allocated session id
      // BEFORE the first websocket send: brand-new chats allocate one here
      // via the session gateway. There is no client-visible session-id
      // handoff later — this id stays valid for the conversation's lifetime.
      let targetSessionId = selectedSession?.id || currentSessionId || null;
      if (!targetSessionId) {
        let createdSessionName = sessionSummary;
        try {
          const response = await api.providers.createSession({
            provider,
            projectPath: resolvedProjectPath,
            initialMessage: messageContent,
          });
          if (!response.ok) {
            throw new Error(`Failed to create session (${response.status})`);
          }
          const body = await response.json();
          targetSessionId = body?.data?.sessionId || null;
          // A blank server name would leave the session unlabeled, so the local
          // summary stays the fallback unless a real name comes back.
          const returnedSessionName = typeof body?.data?.sessionName === 'string'
            ? body.data.sessionName.trim()
            : '';
          if (returnedSessionName) {
            createdSessionName = returnedSessionName;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error('Session creation failed:', error);
          addMessage({
            type: 'error',
            content: `Failed to start a new session: ${message}`,
            timestamp: new Date(),
          });
          return;
        }

        if (!targetSessionId) {
          addMessage({
            type: 'error',
            content: 'Failed to start a new session: no session id returned.',
            timestamp: new Date(),
          });
          return;
        }

        onSessionEstablished?.(targetSessionId, {
          provider,
          project: selectedProject,
          summary: createdSessionName,
        });
      }

      const sendOptions = queuedSubmission?.options ?? buildSendOptions(summaryInput);

      // A message goes to the process a session's background work runs under,
      // so that work carries on. It cannot when the message is an edit (which
      // resumes the transcript partway, in a new process) or when the server
      // says that process would not take it (a different reasoning effort,
      // say). Then sending stops the agents, workflows and commands it still
      // has going. That is the user's call, not one to make for them, and
      // queueing behind the work is the safe alternative.
      const backgroundActivity = processingSessionsRef.current?.get(targetSessionId);
      if (backgroundActivity?.background) {
        // A choice made in the send menu answers the question up front;
        // otherwise it is asked only when sending would stop the work.
        let choice: BackgroundSendChoice | null = submitOptions?.presetBackgroundChoice ?? null;
        if (!choice) {
          const reason = editingAnchorId ? 'edit' : await readBackgroundStopReason(targetSessionId, sendOptions);
          if (reason) {
            const work = ownBackgroundTasks(backgroundActivity.tasks ?? [])
              .map((task) => describeBackgroundTask(task, t));
            choice = await askBeforeSendingOverBackgroundWork({ work, reason });
          }
        }
        if (choice === 'cancel') {
          return;
        }
        if (choice === 'sideQuestion') {
          askSideQuestionAndClear(targetSessionId, typedInput);
          return;
        }
        if (choice === 'queue') {
          // Attachments were uploaded above; queue the same descriptors. The
          // server holds it until sending it would no longer stop the work.
          queueMessage(targetSessionId, {
            content: currentInput,
            options: sendOptions,
            uploadedAttachments,
            files: currentAttachments,
          }, !queuedSubmission);
          return;
        }
      }

      const attachmentRecords = uploadedAttachments as ChatAttachment[];
      // The echo's id goes with the send, and the server opens the run with
      // the prompt under that id: other tabs show it, this one keeps its echo.
      const clientMessageId = createLocalMessageId();
      const userMessage: ChatMessage = {
        type: 'user',
        clientMessageId,
        content: currentInput,
        images: attachmentRecords.filter(isImageAttachment),
        files: attachmentRecords.filter((attachment) => !isImageAttachment(attachment)),
        timestamp: new Date(),
        // Tags this echo as the replacement, so the truncation the server
        // broadcasts a moment later cuts the turns being replaced without
        // taking the message the user just sent with them.
        ...(editingAnchorId ? { replacesAnchorId: editingAnchorId } : {}),
      };

      addMessage(userMessage);
      // Mark this request as processing in the per-session activity map (the
      // single source of truth the indicator derives from). The id is always
      // concrete at this point — no pending placeholder exists anymore.
      onSessionProcessing?.(targetSessionId, {
        statusText: null,
        canInterrupt: true,
      });

      setIsUserScrolledUp(false);
      setTimeout(() => scrollToBottom(), 100);

      // One message shape for every provider. The backend resolves the
      // provider, project path, and provider-native resume id from the
      // session row; `options` only carries composer-level preferences.
      sendMessage({
        // Replacing an already-sent message is its own frame: it changes the
        // shape of the conversation, so it gets validated separately and can
        // report why it was refused.
        type: editingAnchorId ? 'chat.edit-send' : 'chat.send',
        sessionId: targetSessionId,
        ...(editingAnchorId ? { anchorId: editingAnchorId } : {}),
        content: messageContent,
        clientMessageId,
        options: {
          ...sendOptions,
          attachments: uploadedAttachments,
        },
      });
      setEditingAnchorId(null);

      // Recorded under the (possibly just-allocated) session id, so the first
      // message of a new chat lands in the history of the session the user is
      // navigated to. Queued drafts were recorded when they were queued; the
      // consecutive-duplicate check keeps this second call a no-op.
      recordSentMessage(currentInput, targetSessionId);
      setInput('');
      inputValueRef.current = '';
      resetCommandMenuState();
      setAttachedFiles([]);
      setPastedTexts([]);
      setFileErrors(new Map());
      setIsTextareaExpanded(false);

      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      if (draftScopeRef.current) {
        writeDraftText(draftScopeRef.current, '');
      }
    },
    [
      selectedSession,
      askBeforeSendingOverBackgroundWork,
      askSideQuestionAndClear,
      attachedFiles,
      pastedTexts,
      buildSendOptions,
      currentSessionId,
      editingAnchorId,
      executeCommand,
      isLoading,
      onSessionProcessing,
      onSessionEstablished,
      provider,
      queueMessage,
      recordSentMessage,
      resetCommandMenuState,
      scrollToBottom,
      selectedProject,
      sendMessage,
      sessionKey,
      addMessage,
      setIsUserScrolledUp,
      slashCommands,
      steerIntoRunningTurn,
      supportsSteering,
      t,
    ],
  );

  // Chat scopes with a submit still awaiting its upload or, for a brand-new
  // chat, its session id. The composer does not change until that returns (the
  // text stays, send stays enabled), so on a slow server the user submits
  // again — and each extra submit of a new chat allocated its own session and
  // sent it the same first message.
  const submittingScopesRef = useRef(new Set<string>());

  const handleSubmit = useCallback(
    async (
      event: FormEvent<HTMLFormElement> | MouseEvent | TouchEvent | KeyboardEvent<HTMLTextAreaElement>,
      queuedSubmission?: ComposerSubmission,
      submitOptions?: SubmitOptions,
    ) => {
      const scope = draftScopeRef.current ?? '';
      if (submittingScopesRef.current.has(scope)) {
        // Still cancel the event: an ignored form submit must not reload the page.
        event.preventDefault();
        return;
      }
      submittingScopesRef.current.add(scope);
      try {
        await submitMessage(event, queuedSubmission, submitOptions);
      } finally {
        submittingScopesRef.current.delete(scope);
      }
    },
    [submitMessage],
  );

  // The send menu's entry point: side question never becomes a turn, so it never goes
  // through `submitMessage`; Queue and Send anyway answer the background-work
  // question the menu already asked, so the dialog never opens for them; Steer
  // goes through the submit like Queue does (same upload and validation) and
  // only diverges once the message is ready to leave the composer.
  const handleSendMenuChoice = useCallback(
    async (choice: 'queue' | 'steer' | 'sideQuestion' | 'send'): Promise<void> => {
      if (choice === 'sideQuestion') {
        askSideQuestionAndClear(sessionKey, inputValueRef.current);
        return;
      }
      if (choice === 'steer') {
        await handleSubmit(createFakeSubmitEvent(), undefined, { steerIntoTurn: true });
        return;
      }
      await handleSubmit(createFakeSubmitEvent(), undefined, { presetBackgroundChoice: choice });
    },
    [askSideQuestionAndClear, handleSubmit, sessionKey],
  );

  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // The server owns sending. While cards are showing, re-read the drafts
  // now and then so a message the server has sent drops off its card.
  const hasQueuedDrafts = queuedDrafts.length > 0;
  useEffect(() => {
    if (!sessionKey || !hasQueuedDrafts) {
      return;
    }
    const timer = setInterval(() => void hydrateChatDrafts(), 5_000);
    return () => clearInterval(timer);
  }, [hasQueuedDrafts, sessionKey]);

  // A hidden tab's timers are slowed or stopped, so a tab shown again
  // re-reads at once: messages queued on another device appear, and ones the
  // server sent meanwhile drop off, without waiting for the next re-read.
  useEffect(() => {
    if (!sessionKey) {
      return;
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void hydrateChatDrafts();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [sessionKey]);

  // Editing takes the message out of the queue and back into the composer,
  // after anything already typed there.
  const editQueuedDraft = useCallback((id: string) => {
    const draft = queuedDrafts.find((queued) => queued.id === id);
    if (!draft || !sessionKey) {
      return;
    }
    removeQueuedMessage(sessionKey, id);
    queuedFilesRef.current.delete(id);
    const typed = inputValueRef.current;
    const next = typed.trim() ? `${typed}\n\n${draft.content}` : draft.content;
    setInput(next);
    inputValueRef.current = next;
    setAttachedFiles((previous) => [...previous, ...draft.attachments]);
    textareaRef.current?.focus();
  }, [queuedDrafts, sessionKey, setInput]);

  const deleteQueuedDraft = useCallback((id: string) => {
    if (!sessionKey) {
      return;
    }
    removeQueuedMessage(sessionKey, id);
    queuedFilesRef.current.delete(id);
  }, [sessionKey]);

  // For the combined card, whose queued follow-ups go as one message: edit
  // and delete act on all of them. Editing puts them back into the composer
  // in order, after anything already typed there.
  const editAllQueuedDrafts = useCallback(() => {
    if (!sessionKey || queuedDrafts.length === 0) {
      return;
    }
    for (const draft of queuedDrafts) {
      removeQueuedMessage(sessionKey, draft.id);
      queuedFilesRef.current.delete(draft.id);
    }
    const next = [inputValueRef.current, ...queuedDrafts.map((draft) => draft.content)]
      .filter((part) => part.trim())
      .join('\n\n');
    setInput(next);
    inputValueRef.current = next;
    setAttachedFiles((previous) => [...previous, ...queuedDrafts.flatMap((draft) => draft.attachments)]);
    textareaRef.current?.focus();
  }, [queuedDrafts, sessionKey, setInput]);

  const deleteAllQueuedDrafts = useCallback(() => {
    if (!sessionKey) {
      return;
    }
    for (const draft of queuedDrafts) {
      removeQueuedMessage(sessionKey, draft.id);
      queuedFilesRef.current.delete(draft.id);
    }
  }, [queuedDrafts, sessionKey]);

  // A voice transcript either fills the input (to edit before sending) or, when the
  // user tapped "stop and send", is submitted straight away. Mirror the value into
  // inputValueRef synchronously so handleSubmit reads the new text, not the stale state.
  const handleVoiceTranscript = useCallback((text: string, send?: boolean) => {
    const base = inputValueRef.current.trim();
    const next = base ? `${base} ${text}` : text;
    setInput(next);
    inputValueRef.current = next;
    if (send) handleSubmitRef.current?.(createFakeSubmitEvent());
  }, [setInput]);

  // A preset picked from the composer's menu goes where the caret was, replacing
  // any selection, as typing would; it is never sent. The textarea keeps its
  // selection while the menu has focus. When the box is not on screen, or holds
  // a value it has not rendered yet, the text goes at the end instead.
  const insertTextAtCaret = useCallback((text: string) => {
    const current = inputValueRef.current;
    const textarea = textareaRef.current;
    const inSync = textarea !== null && textarea.value === current;
    const start = inSync ? textarea.selectionStart : current.length;
    const end = inSync ? Math.max(start, textarea.selectionEnd) : current.length;
    const next = `${current.slice(0, start)}${text}${current.slice(end)}`;
    const caret = start + text.length;
    setInput(next);
    inputValueRef.current = next;
    setCursorPosition(caret);
    // After React has rendered the new value, or the caret would land in the old one.
    window.requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(caret, caret);
    });
  }, [setCursorPosition, setInput]);

  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // Swap in the open scope's draft, and pick up one that arrives from another
  // device with the hydrated drafts.
  useEffect(() => {
    if (!draftScope) {
      return;
    }

    const restoreDraft = () => {
      const savedInput = readDraftText(draftScope);
      setInputState((previous) => {
        if (previous.scope === draftScope && previous.value === savedInput) {
          return previous;
        }
        inputValueRef.current = savedInput;
        return { scope: draftScope, value: savedInput };
      });
    };

    restoreDraft();
    return subscribeToChatDrafts(restoreDraft);
  }, [draftScope]);

  // Only persist text that was typed for the scope it is about to be written
  // to; see the inputState declaration for why the scope travels with the text.
  useEffect(() => {
    if (!draftScope || inputState.scope !== draftScope) {
      return;
    }
    writeDraftText(draftScope, inputState.value);
  }, [inputState, draftScope]);

  // Show the open session's queue, and follow it as it changes: a message
  // queued here or on another device, or one the server has just sent.
  useEffect(() => {
    if (!sessionKey) {
      setQueuedDrafts([]);
      return;
    }
    const sync = () => {
      const next = restoreQueuedDrafts(sessionKey, queuedFilesRef.current);
      setQueuedDrafts((previous) => (sameQueuedDrafts(previous, next) ? previous : next));
    };
    sync();
    return subscribeToChatDrafts(sync);
  }, [sessionKey]);

  useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    if (lastAutosizedInputRef.current === input) {
      return;
    }
    // Re-run for restored drafts and programmatic input changes. User typing is
    // already resized in onInput, so this avoids doing the same forced layout twice.
    resizeTextarea(textareaRef.current);
  }, [input, resizeTextarea]);

  useEffect(() => {
    if (!textareaRef.current || input.trim()) {
      return;
    }
    textareaRef.current.style.height = 'auto';
    setIsTextareaExpanded(false);
  }, [input]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      const cursorPos = event.target.selectionStart;

      setInput(newValue);
      inputValueRef.current = newValue;
      setCursorPosition(cursorPos);

      if (!newValue.trim()) {
        event.target.style.height = 'auto';
        setIsTextareaExpanded(false);
        resetCommandMenuState();
        return;
      }

      handleCommandInputChange(newValue, cursorPos);
    },
    [handleCommandInputChange, resetCommandMenuState, setCursorPosition],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter') {
        const endedJustNow =
          performance.now() - lastCompositionEndAtRef.current < SAFARI_IME_RACE_WINDOW_MS;
        if (event.nativeEvent.isComposing || isComposingRef.current || endedJustNow) {
          return;
        }

        // Option/Alt+Enter asks a side question in every state (loading,
        // background, idle) and even with the command menu or file-mention
        // dropdown open, so this has to run ahead of
        // `handleCommandMenuKeyDown`/`handleFileMentionsKeyDown` below: both
        // consume a plain Enter to select their highlighted entry and never
        // check altKey, so they would otherwise run the highlighted command
        // or mention instead of asking the side question.
        if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          askSideQuestionAndClear(sessionKey, inputValueRef.current);
          return;
        }
      }

      if (handleCommandMenuKeyDown(event)) {
        return;
      }

      if (handleFileMentionsKeyDown(event)) {
        return;
      }

      if (handleHistoryKeyDown(event)) {
        return;
      }

      if (event.key === 'Tab' && !showFileDropdown && !showCommandMenu) {
        event.preventDefault();
        cyclePermissionMode();
        return;
      }

      if (event.key === 'Enter') {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          handleSubmit(event);
        } else if (
          !event.shiftKey
          && !event.ctrlKey
          && !event.metaKey
          && !sendByCtrlEnter
          // Submitting on plain Enter strands the newline on a soft keyboard:
          // the return key is the only Enter, and no Shift exists to combine
          // with it. The send button still submits.
          && !isSoftKeyboardEnvironment()
        ) {
          event.preventDefault();
          handleSubmit(event);
        }
      }
    },
    [
      askSideQuestionAndClear,
      cyclePermissionMode,
      handleCommandMenuKeyDown,
      handleFileMentionsKeyDown,
      handleHistoryKeyDown,
      handleSubmit,
      sendByCtrlEnter,
      sessionKey,
      showCommandMenu,
      showFileDropdown,
    ],
  );

  const handleTextareaClick = useCallback(
    (event: MouseEvent<HTMLTextAreaElement>) => {
      setCursorPosition(event.currentTarget.selectionStart);
    },
    [setCursorPosition],
  );

  const handleTextareaInput = useCallback(
    (event: FormEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      resizeTextarea(target);
      setCursorPosition(target.selectionStart);
      syncInputOverlayScroll(target);
    },
    [resizeTextarea, setCursorPosition, syncInputOverlayScroll],
  );

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const targetSessionId = selectedSession?.id || currentSessionId || null;
    if (!targetSessionId) {
      console.warn('Abort requested but no session ID is available.');
      return;
    }

    // The backend resolves the provider from the session row, so no provider
    // field is needed here.
    sendMessage({
      type: 'chat.abort',
      sessionId: targetSessionId,
    });
  }, [canAbortSession, currentSessionId, selectedSession?.id, sendMessage]);

  const handleGrantToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion || provider !== 'claude') {
        return { success: false };
      }
      return grantClaudeToolPermission(suggestion.entry);
    },
    [provider],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach((requestId) => {
        sendMessage({
          type: 'chat.permission-response',
          requestId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests((previous) =>
        previous.filter((request) => !validIds.includes(request.requestId)),
      );
    },
    [sendMessage, setPendingPermissionRequests],
  );

  const [isInputFocused, setIsInputFocused] = useState(false);

  const handleInputFocusChange = useCallback(
    (focused: boolean) => {
      setIsInputFocused(focused);
    },
    [],
  );

  /** Loads an already-sent message back into the composer to be replaced. */
  const beginEditMessage = useCallback((message: ChatMessage) => {
    if (!message.transcriptAnchorId) return;
    setEditingAnchorId(message.transcriptAnchorId);
    setInput(message.content || '');
    inputValueRef.current = message.content || '';
    textareaRef.current?.focus();
  }, [setInput]);

  const cancelEditMessage = useCallback(() => {
    setEditingAnchorId(null);
    setInput('');
    inputValueRef.current = '';
  }, [setInput]);

  return {
    input,
    setInput,
    editingAnchorId,
    beginEditMessage,
    cancelEditMessage,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles: filteredFiles as MentionableFile[],
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    pastedTexts,
    setPastedTexts,
    updatePastedText,
    removePastedText,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handleSubmit,
    handleSendMenuChoice,
    backgroundSendPrompt,
    resolveBackgroundSendPrompt,
    queuedDrafts,
    editQueuedDraft,
    deleteQueuedDraft,
    editAllQueuedDrafts,
    deleteAllQueuedDrafts,
    pendingSteers: visiblePendingSteers,
    handleSteerOutcome,
    handleVoiceTranscript,
    insertTextAtCaret,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  };
}
