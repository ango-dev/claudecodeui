import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * The server opens every run with the turn's prompt so that tabs which did not
 * send it show it too. The sending tab already shows its own optimistic echo,
 * so the send carries that echo's id and the prompt comes back under it: the
 * store keeps one row.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-existing' };

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse([]))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a send hands the server the id of the echo it shows', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const echoes: ChatMessage[] = [];
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
      sendMessage: (message) => { sent.push(message as Record<string, unknown>); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { echoes.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  act(() => { view.result.current.setInput('hello there'); });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  const chatSend = sent.find((message) => message.type === 'chat.send');
  const echo = echoes.find((message) => message.type === 'user');
  assert.ok(chatSend && echo);
  assert.match(String(chatSend.clientMessageId), /^local_\d+_[a-z0-9]+$/);
  assert.equal(echo.clientMessageId, chatSend.clientMessageId);
});
