import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps
 * its composer usable, and a new message goes to the process that work runs
 * under, so the work carries on. An edit is different: it resumes the
 * transcript partway in a new process, which stops the work, so the composer
 * says so and asks before sending the edit.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [
      { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
      { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
      { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
    ],
  },
]]);

const submit = async (processingSessions: SessionActivityMap, { edit = false } = {}) => {
  const sent: Array<{ type: string }> = [];
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
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  if (edit) {
    await act(async () => {
      view.result.current.beginEditMessage({ type: 'user', content: 'earlier', transcriptAnchorId: 'u-anchor', timestamp: new Date() } as never);
    });
  }
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return {
    sends: sent.filter((message) => message.type === 'chat.send' || message.type === 'chat.edit-send'),
    view,
  };
};

const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a message on a session with background work is sent without asking: the work carries on', async () => {
  const { sends } = await submit(backgroundOnly);

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sends.length, 1);
});

test('editing a message while background work runs asks first, naming the session\'s own tasks', async () => {
  confirm.mockReturnValue(false);
  const { sends, view } = await submit(backgroundOnly, { edit: true });

  assert.equal(confirm.mock.calls.length, 1);
  assert.equal(
    confirm.mock.calls[0]?.[0],
    'This session still has background work running:\n'
    + '• Workflow frontend-architecture-audit\n'
    + '• Agent Survey the repo\n\n'
    + 'Editing a message restarts the session, which stops that work; anything it has not reported yet is lost. Edit anyway?',
  );
  assert.equal(sends.length, 0, 'declined: nothing is sent');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
});

test('confirming sends the edit', async () => {
  confirm.mockReturnValue(true);
  const { sends } = await submit(backgroundOnly, { edit: true });

  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.type, 'chat.edit-send');
});

test('an edit on a session with nothing in the background is sent without asking', async () => {
  const { sends } = await submit(new Map(), { edit: true });

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sends.length, 1);
});
