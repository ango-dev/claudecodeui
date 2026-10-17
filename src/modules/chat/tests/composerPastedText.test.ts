import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A long paste (1,000+ characters or 15+ lines) becomes a "Pasted" card next
 * to the attachments instead of filling the message box, as on claude.ai. On
 * send, each card's text goes first, in paste order, then the typed text, all
 * joined by a blank line; the cards clear with the message.
 */

// The queue is server-backed; only what the composer hands it matters here.
const queuedMessages = vi.hoisted(() => [] as Array<{ scope: string; content: string }>);
vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    appendQueuedMessage: async (scope: string, message: { content: string }) => {
      queuedMessages.push({ scope, content: message.content });
      return true;
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-existing' };

const LONG_TEXT = 'x'.repeat(1_000);
const MANY_LINES = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const renderComposer = async ({ isLoading = false }: { isLoading?: boolean } = {}) => {
  const sent: Array<{ type: string; sessionId?: string; content?: string }> = [];
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
      isLoading,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  // Let the mount-time requests (slash commands, drafts) finish while fetch is stubbed.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { view, chatSends: () => sent.filter((message) => message.type === 'chat.send') };
};

type ComposerView = Awaited<ReturnType<typeof renderComposer>>['view'];

/** A paste event like the textarea gets, with the clipboard's plain text and any items. */
const paste = (
  view: ComposerView,
  text: string,
  items: Array<{ type: string; getAsFile: () => File | null }> = [],
) => {
  const preventDefault = vi.fn();
  act(() => {
    view.result.current.handlePaste({
      clipboardData: {
        items,
        files: [],
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      },
      preventDefault,
    } as never);
  });
  return preventDefault;
};

const submit = async (view: ComposerView) => {
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
};

beforeEach(() => {
  queuedMessages.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse([]))));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a paste of 1,000+ characters becomes a card and is kept out of the message box', async () => {
  const { view } = await renderComposer();
  act(() => { view.result.current.setInput('typed'); });

  const preventDefault = paste(view, LONG_TEXT);

  assert.equal(preventDefault.mock.calls.length, 1, 'the browser does not insert the text');
  assert.deepEqual(view.result.current.pastedTexts.map((pasted) => pasted.text), [LONG_TEXT]);
  assert.equal(view.result.current.input, 'typed');
});

test('a paste of 15+ lines becomes a card even when it is short', async () => {
  const { view } = await renderComposer();

  const preventDefault = paste(view, MANY_LINES);

  assert.equal(preventDefault.mock.calls.length, 1);
  assert.deepEqual(view.result.current.pastedTexts.map((pasted) => pasted.text), [MANY_LINES]);
});

test('a shorter paste is left to the browser, as before', async () => {
  const { view } = await renderComposer();

  const belowBoth = Array.from({ length: 14 }, () => 'y'.repeat(60)).join('\n');
  assert.ok(belowBoth.length < 1_000);
  const preventDefault = paste(view, belowBoth);
  const preventDefaultShort = paste(view, 'x'.repeat(999));

  assert.equal(preventDefault.mock.calls.length, 0);
  assert.equal(preventDefaultShort.mock.calls.length, 0);
  assert.deepEqual(view.result.current.pastedTexts, []);
});

test('a paste carrying an image and long text attaches the image and makes a card', async () => {
  const { view } = await renderComposer();
  const image = new File(['png'], 'shot.png', { type: 'image/png' });

  paste(view, LONG_TEXT, [{ type: 'image/png', getAsFile: () => image }]);

  assert.deepEqual(view.result.current.attachedFiles, [image]);
  assert.equal(view.result.current.pastedTexts.length, 1);
});

test('a card is edited and removed by its id', async () => {
  const { view } = await renderComposer();
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  const [first, second] = view.result.current.pastedTexts;
  assert.notEqual(first.id, second.id);

  act(() => { view.result.current.updatePastedText(first.id, 'edited'); });
  assert.deepEqual(view.result.current.pastedTexts.map((pasted) => pasted.text), ['edited', MANY_LINES]);

  act(() => { view.result.current.removePastedText(second.id); });
  assert.deepEqual(view.result.current.pastedTexts, [{ id: first.id, text: 'edited' }]);
});

test('sending puts each pasted text, in paste order, ahead of the typed text and clears the cards', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  act(() => { view.result.current.setInput('Summarize both'); });

  await submit(view);

  assert.deepEqual(
    chatSends().map((message) => [message.sessionId, message.content]),
    [['session-existing', `${LONG_TEXT}\n\n${MANY_LINES}\n\nSummarize both`]],
  );
  assert.deepEqual(view.result.current.pastedTexts, []);
  assert.equal(view.result.current.input, '');
});

test('a typed slash command leads the message, with the pasted text after it as its input', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('/review'); });

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), [`/review\n\n${LONG_TEXT}`]);
});

test('pasted text that starts with a command name is sent as text, not run as a command', async () => {
  const { view, chatSends } = await renderComposer();
  const pastedHelp = `/help ${LONG_TEXT}`;
  paste(view, pastedHelp);

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), [pastedHelp]);
});

test('a message of only a pasted card, with nothing typed, is sent', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, LONG_TEXT);

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), [LONG_TEXT]);
  assert.deepEqual(view.result.current.pastedTexts, []);
});

test('while a reply runs, the pasted and typed text are queued together and the cards clear', async () => {
  const { view, chatSends } = await renderComposer({ isLoading: true });
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('next'); });

  await submit(view);

  assert.equal(chatSends().length, 0, 'nothing is sent while the reply runs');
  assert.deepEqual(queuedMessages, [{ scope: 'session-existing', content: `${LONG_TEXT}\n\nnext` }]);
  assert.deepEqual(view.result.current.pastedTexts, []);
  assert.equal(view.result.current.input, '');
});
