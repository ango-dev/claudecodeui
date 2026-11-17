import assert from 'node:assert/strict';

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

/**
 * A question from the agent replaces the input box, which is where the token
 * usage normally sits (this fork's context ring, after the model picker). The
 * answer often depends on how much context is left, so the ring must stay on
 * screen, and still open the breakdown, while the question panel is up.
 *
 * Every prop below is a stub of the composer's current interface; only
 * `pendingPermissionRequests`, `tokenBudget` and `onShowTokenUsage` matter here.
 */

type Props = ComponentProps<typeof ChatComposer>;

const QUESTION_REQUEST = {
  requestId: 'question-1',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which way should we go?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Left', description: 'Go left' },
          { label: 'Right', description: 'Go right' },
        ],
      },
    ],
  },
} as Props['pendingPermissionRequests'][number];

const props = (overrides: Partial<Props>): Props => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: { used: 42_000, total: 200_000 },
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDrafts: [],
  combineQueuedMessages: true,
  onEditAllQueuedDrafts: () => undefined,
  onDeleteAllQueuedDrafts: () => undefined,
  backgroundSendPrompt: null,
  onResolveBackgroundSendPrompt: () => undefined,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  pastedTexts: [],
  onChangePastedText: () => undefined,
  onRemovePastedText: () => undefined,
  fileErrors: new Map(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: -1,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: -1,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  inputHighlightRef: createRef<HTMLDivElement>() as Props['inputHighlightRef'],
  renderInputWithMentions: (text) => text,
  textareaRef: createRef<HTMLTextAreaElement>() as Props['textareaRef'],
  input: '',
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Message',
  isTextareaExpanded: false,
  ...overrides,
});

// The ring's name carries its reading after the label: "Show token usage: 21% …".
const tokenUsageButtons = () => screen.queryAllByRole('button', { name: /^Show token usage/ });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('no question pending: the token usage sits in the input box, once', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({})} /></UiPreferencesProvider>);

  assert.ok(screen.queryByPlaceholderText('Message') !== null, 'the input is there');
  assert.equal(tokenUsageButtons().length, 1);
});

test('question pending: the input is gone but the token usage stays and opens the breakdown', () => {
  const onShowTokenUsage = vi.fn();
  render(
    <UiPreferencesProvider>
      <ChatComposer {...props({ pendingPermissionRequests: [QUESTION_REQUEST], onShowTokenUsage })} />
    </UiPreferencesProvider>,
  );

  assert.ok(screen.queryByText('Which way should we go?') !== null, 'the question panel is shown');
  assert.equal(screen.queryByPlaceholderText('Message'), null, 'the input is replaced by the question');
  const buttons = tokenUsageButtons();
  assert.equal(buttons.length, 1, 'token usage is still on screen, once');
  assert.ok(buttons[0].getAttribute('aria-label')?.includes('42K'), 'it reads out the used tokens');

  fireEvent.click(buttons[0]);

  assert.equal(onShowTokenUsage.mock.calls.length, 1, 'clicking it opens the token breakdown');
});

// Clearing the context sits beside the ring it empties, and only where the
// session can be cleared (ChatInterface passes no handler otherwise).
const clearContextButton = () => screen.queryByRole('button', { name: 'Clear context' });

test('clear context: shown beside the ring only with a handler, and asks the handler on click', () => {
  const { unmount } = render(<UiPreferencesProvider><ChatComposer {...props({})} /></UiPreferencesProvider>);
  assert.equal(clearContextButton(), null, 'no handler, no button');
  unmount();

  const onClearContext = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ onClearContext })} /></UiPreferencesProvider>);
  const button = clearContextButton();
  assert.ok(button, 'the button is there');
  assert.ok(
    tokenUsageButtons()[0].parentElement?.contains(button),
    'it sits in the same toolbar group as the context ring',
  );
  fireEvent.click(button);
  assert.equal(onClearContext.mock.calls.length, 1);
});

test('clear context: disabled while a turn is still writing to the context', () => {
  render(
    <UiPreferencesProvider>
      <ChatComposer {...props({ onClearContext: () => undefined, isLoading: true, canAbortSession: true })} />
    </UiPreferencesProvider>,
  );
  assert.equal(clearContextButton()?.hasAttribute('disabled'), true);
});
