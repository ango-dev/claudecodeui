import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A picked preset goes into the message box where the caret is, replacing any
 * selection, as typing would; the caret ends after it and nothing is sent.
 */

const PROJECT: Project = { projectId: 'project-insert', displayName: 'Project', fullPath: '/tmp/project' };
const SESSION: ProjectSession = { id: 'session-insert' };

// Frames the composer asked for, run by the test once the new value is in the box.
const frames: FrameRequestCallback[] = [];

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const renderComposer = async () => {
  const sent: unknown[] = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  // The composer's textarea, kept in step with the state as React would.
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  (view.result.current.textareaRef as { current: HTMLTextAreaElement | null }).current = textarea;
  const type = (value: string, selectionStart = value.length, selectionEnd = selectionStart) => {
    act(() => { view.result.current.setInput(value); });
    textarea.value = value;
    textarea.setSelectionRange(selectionStart, selectionEnd);
  };
  const insert = (text: string) => {
    act(() => { view.result.current.insertTextAtCaret(text); });
    // React renders the new value, then the next frame places the caret.
    textarea.value = view.result.current.input;
    for (const callback of frames.splice(0)) callback(0);
  };
  return { view, textarea, type, insert, sent };
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse([]))));
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  localStorage.clear();
});

test('an empty box just becomes the preset, with the caret after it', async () => {
  const { view, textarea, insert, sent } = await renderComposer();
  insert('Review this diff');

  assert.equal(view.result.current.input, 'Review this diff');
  assert.equal(document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 'Review this diff'.length);
  assert.equal(sent.length, 0, 'nothing is sent');
});

test('the preset goes in at the caret', async () => {
  const { view, textarea, type, insert } = await renderComposer();
  type('Please  carefully', 'Please '.length);
  insert('review');

  assert.equal(view.result.current.input, 'Please review carefully');
  assert.equal(textarea.selectionStart, 'Please review'.length);
  assert.equal(textarea.selectionEnd, 'Please review'.length);
});

test('a selection is replaced by the preset', async () => {
  const { view, textarea, type, insert } = await renderComposer();
  type('Fix OLD TEXT now', 'Fix '.length, 'Fix OLD TEXT'.length);
  insert('the tests');

  assert.equal(view.result.current.input, 'Fix the tests now');
  assert.equal(textarea.selectionStart, 'Fix the tests'.length);
});

test('a box whose text has not rendered yet gets the preset at the end', async () => {
  const { view, textarea, insert } = await renderComposer();
  act(() => { view.result.current.setInput('Typed'); });
  textarea.value = '';
  insert(' and more');

  assert.equal(view.result.current.input, 'Typed and more');
});
