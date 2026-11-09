import assert from 'node:assert/strict';

import { createRef } from 'react';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { PendingSteer, QueuedDraft, SessionActivity } from '@/shared/types';
import * as useVoiceInputModule from '@/modules/chat/hooks/useVoiceInput';

/**
 * Where the composer draws the send menu: as a caret beside the queue button
 * while a turn is written and there is something to send, never while idle or
 * over background work alone (there the background-send dialog asks, and only
 * when sending would stop the work). Stop in the menu is the existing abort.
 *
 * Every prop below is a stub of the composer's current interface; only
 * `isLoading`, `activity`, `input` and `onAbortSession` matter here.
 */

type Props = ComponentProps<typeof ChatComposer>;

const BACKGROUND: SessionActivity = { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [] };

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
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDrafts: [],
  combineQueuedMessages: true,
  onEditAllQueuedDrafts: () => undefined,
  onDeleteAllQueuedDrafts: () => undefined,
  pastedTexts: [],
  onChangePastedText: () => undefined,
  onRemovePastedText: () => undefined,
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
  input: 'hello',
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

const hasMenuTrigger = () => screen.queryByRole('button', { name: 'Send options' }) !== null;

const menuLabels = () => Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'))
  .map((row) => row.textContent ?? '');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('idle: the plain send button, and no send menu', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({})} /></UiPreferencesProvider>);

  assert.ok(screen.queryByRole('button', { name: 'Send' }) !== null, 'the send button is there');
  assert.ok(!hasMenuTrigger(), 'no menu while nothing runs');
});

test('turn running, composer empty: the green submit button is Stop, one tap aborts, and no menu opens', () => {
  const onAbortSession = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onAbortSession, input: '', attachedFiles: [] })} /></UiPreferencesProvider>);

  assert.ok(!hasMenuTrigger(), 'an empty composer keeps the plain button, not the menu');
  const stop = screen.getByRole('button', { name: 'Stop' });
  assert.equal(onAbortSession.mock.calls.length, 0);

  fireEvent.click(stop);

  assert.equal(onAbortSession.mock.calls.length, 1, 'one tap aborts the turn');
});

// CodeRabbit: the menu's Stop row was disabled by `canAbortSession` in the
// previous commit, but the one-tap Stop button shown with an empty composer
// predates it and never got the same check, so it stayed enabled and called
// `onAbortSession` while that turn could not actually be interrupted — a tap
// that reaches the handler and does nothing.
test('turn running, composer empty, cannot be interrupted: the one-tap Stop button is disabled', () => {
  const onAbortSession = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onAbortSession, input: '', attachedFiles: [], canAbortSession: false })} /></UiPreferencesProvider>);

  assert.ok(!hasMenuTrigger(), 'an empty composer keeps the plain button, not the menu');
  const stop = screen.getByRole('button', { name: 'Stop' });
  assert.ok((stop as HTMLButtonElement).disabled, 'disabled like the menu row would be');

  fireEvent.click(stop);

  assert.equal(onAbortSession.mock.calls.length, 0, 'a disabled Stop button does nothing');
});

test('background work, composer empty: the submit button is disabled', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ activity: BACKGROUND, input: '', attachedFiles: [] })} /></UiPreferencesProvider>);

  assert.ok(!hasMenuTrigger(), 'an empty composer keeps the plain button, not the menu');
  const submit = screen.getByRole('button', { name: 'Send' });
  assert.ok((submit as HTMLButtonElement).disabled, 'disabled with nothing to send');
});

test('turn running, transcribing: the plain submit button is disabled, so a tap cannot abort the turn', () => {
  // Transcribing draws the same spinner as a running turn, but it is not a
  // turn: a tap on the spinner must not reach `onAbortSession`, which the
  // `isLoading` branch below would otherwise wire up.
  const onAbortSession = vi.fn();
  const spy = vi.spyOn(useVoiceInputModule, 'useVoiceInput').mockReturnValue({
    state: 'transcribing',
    toggle: () => undefined,
    stop: () => undefined,
  });

  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onAbortSession })} /></UiPreferencesProvider>);

  assert.ok(!hasMenuTrigger(), 'transcribing keeps the plain button, not the menu');
  const submit = screen.getByRole('button', { name: 'Send' });
  assert.ok((submit as HTMLButtonElement).disabled, 'disabled while transcribing, even though a turn is running');

  fireEvent.click(submit);
  assert.equal(onAbortSession.mock.calls.length, 0, 'a tap on the disabled spinner cannot end the turn');

  spy.mockRestore();
});

test('while a turn is written a send-options caret sits beside the queue button, and its Stop is the existing abort', () => {
  const onAbortSession = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onAbortSession })} /></UiPreferencesProvider>);

  assert.ok(screen.queryByRole('button', { name: 'Queue next message' }) !== null, 'the button still queues in one tap');
  const trigger = screen.queryByRole('button', { name: 'Send options' });
  assert.ok(trigger !== null, 'the caret opens the other ways to send');
  assert.equal(onAbortSession.mock.calls.length, 0);

  fireEvent.click(trigger);
  const stop = Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    .find((row) => (row.textContent ?? '').startsWith('Stop'));
  assert.ok(stop, 'the menu has a Stop row');
  fireEvent.click(stop);

  assert.equal(onAbortSession.mock.calls.length, 1, 'Stop calls the existing abort once');
});

// CodeRabbit comment 4478109479: the menu's Stop row stayed enabled even
// when the session could not be interrupted, because `ChatComposer` never
// received `canAbortSession` to forward to the menu. Clicking it looked
// actionable but did nothing, since `handleAbortSession` already no-ops in
// that case.
test('turn running, cannot be interrupted: the menu Stop row is disabled', () => {
  const onAbortSession = vi.fn();
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, onAbortSession, canAbortSession: false })} /></UiPreferencesProvider>);

  const trigger = screen.getByRole('button', { name: 'Send options' });
  fireEvent.click(trigger);
  const stop = Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    .find((row) => (row.textContent ?? '').startsWith('Stop'));
  assert.ok(stop, 'the menu has a Stop row');
  assert.ok((stop as HTMLButtonElement).disabled || stop?.getAttribute('aria-disabled') === 'true', 'Stop is disabled');

  fireEvent.click(stop as HTMLElement);
  assert.equal(onAbortSession.mock.calls.length, 0, 'a disabled Stop row does nothing');
});

test('while only background work runs, the plain send button stays: the dialog asks only when sending would stop the work', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ activity: BACKGROUND, supportsSideQuestions: true, supportsSteering: true })} /></UiPreferencesProvider>);

  assert.ok(!hasMenuTrigger(), 'no menu over background work alone');
  const submit = screen.getByRole('button', { name: 'Send' });
  assert.ok(!(submit as HTMLButtonElement).disabled, 'the message can be sent');
});

test('turn running, input present, steering supported: Steer sits right under Queue', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, supportsSideQuestions: true, supportsSteering: true })} /></UiPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));

  const labels = menuLabels();
  assert.equal(labels.length, 4, `Queue, Steer, Side question, Stop, got: ${labels.join(' | ')}`);
  assert.ok(labels[0]?.startsWith('Queue'));
  assert.ok(labels[1]?.startsWith('Steer'));
  assert.ok(labels[2]?.startsWith('Side question'));
  assert.ok(labels[3]?.startsWith('Stop'));
});

test('turn running, input present: the menu offers Queue, Side question, Stop in that order', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, supportsSideQuestions: true })} /></UiPreferencesProvider>);

  const trigger = screen.getByRole('button', { name: 'Send options' });
  fireEvent.click(trigger);

  const labels = Array.from(screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    .map((row) => row.textContent ?? '');
  assert.equal(labels.length, 3, `Queue, Side question, Stop, got: ${labels.join(' | ')}`);
  assert.ok(labels[0]?.startsWith('Queue'), `first row is Queue, got: ${labels.join(' | ')}`);
  assert.ok(labels[1]?.startsWith('Side question'), `second row is Side question, got: ${labels.join(' | ')}`);
  assert.ok(labels[2]?.startsWith('Stop'), `third row is Stop, got: ${labels.join(' | ')}`);
});

test('the side-question shortcut hint shows for a fine pointer with hover, not by screen width', () => {
  // A landscape phone is wide enough for `sm:`, but has neither hover nor a
  // fine pointer, so the hint must gate on `(hover: hover) and (pointer: fine)`
  // rather than a breakpoint.
  render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, supportsSideQuestions: true })} /></UiPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Send options' }));

  const hint = screen.getByText(/⌥↵|Alt\+↵/);
  assert.ok(
    hint.className.includes('[@media(hover:hover)_and_(pointer:fine)]:inline-block'),
    `expected the hover/fine-pointer gate, got: ${hint.className}`,
  );
  assert.ok(!hint.className.includes('sm:inline-block'), `expected no width-based gate, got: ${hint.className}`);
});

// The capability gate has to travel: every component defaults
// `supportsSideQuestions` to false, so a composer that never hands the flag on
// would silently drop side questions for every provider. These pin that
// `ChatComposer` passes it to its send menu and its background-send dialog.
const PROMPT = { work: ['Agent Survey the repo'], reason: 'unavailable' as const };

for (const [state, overrides] of [
  ['while a turn is written', { isLoading: true }],
] as const) {
  test(`${state}, supportsSideQuestions true reaches the menu as a side-question row`, () => {
    render(<UiPreferencesProvider><ChatComposer {...props({ ...overrides, supportsSideQuestions: true })} /></UiPreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Send options' }));

    assert.ok(menuLabels().some((label) => label.startsWith('Side question')), `got: ${menuLabels().join(' | ')}`);
  });

  test(`${state}, supportsSideQuestions false leaves the side-question row out of the menu`, () => {
    render(<UiPreferencesProvider><ChatComposer {...props({ ...overrides, supportsSideQuestions: false })} /></UiPreferencesProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Send options' }));

    assert.equal(menuLabels().length, 2, `only the two session choices, got: ${menuLabels().join(' | ')}`);
    assert.ok(!menuLabels().some((label) => label.startsWith('Side question')));
  });
}

test('supportsSideQuestions true reaches the background-send dialog as a side-question button', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ activity: BACKGROUND, backgroundSendPrompt: PROMPT, supportsSideQuestions: true })} /></UiPreferencesProvider>);

  assert.ok(screen.queryByRole('button', { name: 'Side question' }) !== null, 'the dialog offers the side question');
});

test('supportsSideQuestions false leaves the side-question button out of the background-send dialog', () => {
  render(<UiPreferencesProvider><ChatComposer {...props({ activity: BACKGROUND, backgroundSendPrompt: PROMPT, supportsSideQuestions: false })} /></UiPreferencesProvider>);

  const names = Array.from(screen.getByRole('alertdialog').querySelectorAll('button'))
    .map((button) => button.textContent?.trim() ?? '')
    .filter((name) => name !== '');
  assert.deepEqual(names, ['Cancel', 'Queue', 'Send anyway']);
});

// A steered message and the combined queue are drawn as one block on top of
// the message box: steered first (the agent reads it before the queue is
// sent), each with its own label, under one border and surface.
const STEER: PendingSteer = {
  messageId: '00000000-0000-4000-8000-000000000001',
  sessionKey: 'session-1',
  content: 'use the other file',
  attachments: [],
  uploadedAttachments: [],
  status: 'accepted',
};
const QUEUED: QueuedDraft = { id: 'q-1', content: 'then run the tests', attachments: [] };

test('a steered message is drawn on top of the message box, saying who reads it when', () => {
  const { container } = render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, input: '', pendingSteers: [STEER] })} /></UiPreferencesProvider>);

  const stack = container.querySelector('[data-slot="queued-attached"]');
  assert.ok(stack, 'one attached block');
  assert.ok(stack?.textContent?.includes('Steering'));
  assert.ok(stack?.textContent?.includes('Claude reads it at its next tool call'));
  assert.ok(stack?.textContent?.includes('use the other file'));
  assert.ok(container.querySelector('[data-slot="prompt-input-box"]')?.className.includes('rounded-t-none'), 'the box joins it flush');
});

test('a steered message and the combined queue share one attached block, steered first', () => {
  const { container } = render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, input: '', pendingSteers: [STEER], queuedDrafts: [QUEUED] })} /></UiPreferencesProvider>);

  const stacks = container.querySelectorAll('[data-slot="queued-attached"]');
  assert.equal(stacks.length, 1, 'a single attached block, not two');
  const sections = Array.from(stacks[0]?.children ?? []).map((section) => section.getAttribute('data-testid'));
  assert.deepEqual(sections, ['steered-message-card', 'queued-message-merged-card']);
});

test('with combining off, the queued strip stands apart and only the steered message is attached', () => {
  const { container } = render(<UiPreferencesProvider><ChatComposer {...props({ isLoading: true, input: '', pendingSteers: [STEER], queuedDrafts: [QUEUED], combineQueuedMessages: false })} /></UiPreferencesProvider>);

  const stack = container.querySelector('[data-slot="queued-attached"]');
  assert.ok(stack?.querySelector('[data-testid="steered-message-card"]'));
  assert.equal(stack?.querySelector('[data-testid="queued-message-card"]'), null, 'the strip is not inside the attached block');
  assert.ok(container.querySelector('[data-testid="queued-message-card"]'), 'the strip is shown');
});
