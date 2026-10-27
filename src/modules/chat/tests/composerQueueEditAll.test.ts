import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Follow-ups typed while a reply runs are queued. By default the server sends
 * them together as one message, and the composer shows them as one card, so
 * its Edit and Delete act on all of them at once.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-queue' };

const requests: Array<{ url: string; method: string; body: unknown }> = [];

const renderBusyComposer = () => renderHook(() =>
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
    isLoading: true,
    processingSessions: new Map(),
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
);

type ComposerView = ReturnType<typeof renderBusyComposer>;

const queue = async (view: ComposerView, text: string) => {
  await act(async () => { view.result.current.setInput(text); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
};

const queueRequests = (method: string) => requests.filter((request) => request.url.includes('/api/user/drafts/queue') && request.method === method);

beforeEach(() => {
  requests.length = 0;
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('edit all puts every queued follow-up back in the composer, in order, after what was typed', async () => {
  const view = renderBusyComposer();
  await queue(view, 'first');
  await queue(view, 'second');
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['first', 'second']);

  await act(async () => { view.result.current.setInput('typed meanwhile'); });
  await act(async () => { view.result.current.editAllQueuedDrafts(); });

  assert.equal(view.result.current.input, 'typed meanwhile\n\nfirst\n\nsecond');
  assert.deepEqual(view.result.current.queuedDrafts, []);
  await waitFor(() => assert.equal(queueRequests('DELETE').length, 2, 'each one is taken off the server queue'));
});

test('delete all empties the queue and leaves the composer alone', async () => {
  const view = renderBusyComposer();
  await queue(view, 'first');
  await queue(view, 'second');
  await act(async () => { view.result.current.setInput('still typing'); });

  await act(async () => { view.result.current.deleteAllQueuedDrafts(); });

  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.equal(view.result.current.input, 'still typing');
  await waitFor(() => assert.equal(queueRequests('DELETE').length, 2));
});
