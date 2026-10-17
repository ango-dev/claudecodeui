import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { BackgroundSendChoice, BackgroundSendPrompt, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps
 * its composer usable, and a new message goes to the process that work runs
 * under, so the work carries on. When it cannot (an edit resumes the
 * transcript partway in a new process; the server says the held process would
 * not take a message with, say, a different reasoning effort), sending stops
 * the work, so the composer asks first: send anyway, queue, or cancel.
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

type SendCheck = { stopsBackgroundWork: boolean; reason: string | null } | 'fail';

let sendCheck: SendCheck = { stopsBackgroundWork: false, reason: null };
const requests: Array<{ url: string; body: unknown }> = [];

const renderComposer = (processingSessions: SessionActivityMap) => {
  const sent: Array<{ type: string; options?: Record<string, unknown> }> = [];
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
  return {
    view,
    sends: () => sent.filter((message) => message.type === 'chat.send' || message.type === 'chat.edit-send'),
  };
};

/** Types into the composer and submits; `answer` is the choice given if the prompt opens. */
const submit = async (
  processingSessions: SessionActivityMap,
  { edit = false, answer = 'cancel' as BackgroundSendChoice } = {},
) => {
  const composer = renderComposer(processingSessions);
  const { view } = composer;
  if (edit) {
    await act(async () => {
      view.result.current.beginEditMessage({ type: 'user', content: 'earlier', transcriptAnchorId: 'u-anchor', timestamp: new Date() } as never);
    });
  }
  await act(async () => { view.result.current.setInput('hello'); });
  let submitting: Promise<void> = Promise.resolve();
  let settled = false;
  act(() => {
    submitting = view.result.current.handleSubmit({ preventDefault: () => undefined } as never)
      .then(() => { settled = true; });
  });
  // Either the send finishes, or it stops to ask.
  await waitFor(() => assert.ok(settled || view.result.current.backgroundSendPrompt));
  const prompt: BackgroundSendPrompt | null = view.result.current.backgroundSendPrompt;
  if (prompt) {
    act(() => { view.result.current.resolveBackgroundSendPrompt(answer); });
  }
  await act(async () => { await submitting; });
  return { ...composer, prompt };
};

const checks = () => requests.filter((request) => request.url.includes('/send-check'));

beforeEach(() => {
  sendCheck = { stopsBackgroundWork: false, reason: null };
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/send-check')) {
      if (sendCheck === 'fail') {
        return new Response('{}', { status: 500 });
      }
      return new Response(JSON.stringify({ success: true, data: sendCheck }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a message the held process can take is sent without asking: the work carries on', async () => {
  const { sends, prompt } = await submit(backgroundOnly);

  assert.equal(prompt, null);
  assert.equal(sends().length, 1);
  assert.equal(checks().length, 1, 'the server was asked');
  const checked = checks()[0]?.body as { options: { effort?: string } } | undefined;
  assert.equal(checked?.options.effort, 'medium', 'with the options the message would be sent with');
});

test('a message that would stop the work asks first, naming the session\'s own tasks and why', async () => {
  sendCheck = { stopsBackgroundWork: true, reason: 'effort' };
  const { sends, prompt, view } = await submit(backgroundOnly, { answer: 'cancel' });

  assert.deepEqual(prompt, {
    work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
    reason: 'effort',
  });
  assert.equal(sends().length, 0, 'cancelled: nothing is sent');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
  assert.equal(view.result.current.backgroundSendPrompt, null, 'the prompt closes');
});

test('send anyway sends it', async () => {
  sendCheck = { stopsBackgroundWork: true, reason: 'effort' };
  const { sends } = await submit(backgroundOnly, { answer: 'send' });

  assert.equal(sends().length, 1);
  assert.equal(sends()[0]?.type, 'chat.send');
});

test('queue puts it in the session\'s queue instead, and clears the composer', async () => {
  sendCheck = { stopsBackgroundWork: true, reason: 'effort' };
  const { sends, view } = await submit(backgroundOnly, { answer: 'queue' });

  assert.equal(sends().length, 0);
  const queued = requests.find((request) => request.url.includes('/api/user/drafts/queue'));
  assert.equal((queued?.body as { message: { content: string } } | undefined)?.message.content, 'hello');
  assert.deepEqual(view.result.current.queuedDrafts.map((draft) => draft.content), ['hello']);
  assert.equal(view.result.current.input, '');
});

test('a check that fails asks rather than stopping the work unasked', async () => {
  sendCheck = 'fail';
  const { sends, prompt } = await submit(backgroundOnly, { answer: 'cancel' });

  assert.equal(prompt?.reason, 'unavailable');
  assert.equal(sends().length, 0);
});

test('editing a message while background work runs asks without a check, and offers no queue', async () => {
  const { sends, prompt } = await submit(backgroundOnly, { edit: true, answer: 'cancel' });

  assert.equal(prompt?.reason, 'edit');
  assert.equal(checks().length, 0, 'an edit always restarts the session');
  assert.equal(sends().length, 0);
});

test('editing anyway sends the edit', async () => {
  const { sends } = await submit(backgroundOnly, { edit: true, answer: 'send' });

  assert.equal(sends().length, 1);
  assert.equal(sends()[0]?.type, 'chat.edit-send');
});

test('a session with nothing in the background sends without a check or a prompt', async () => {
  const { sends, prompt } = await submit(new Map(), { edit: true });

  assert.equal(prompt, null);
  assert.equal(checks().length, 0);
  assert.equal(sends().length, 1);
});
