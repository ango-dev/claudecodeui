import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { MAX_CHAT_ATTACHMENT_SIZE_BYTES } from '@/shared/constants';
import type { ChatMessage, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A long paste (1,000+ characters or 15+ lines) becomes a "Pasted" card next
 * to the attachments instead of filling the message box, as on claude.ai. On
 * send each card goes, like Claude sends a long paste, as a `.txt` file:
 * `Pasted text.txt`, `Pasted text (2).txt`, ... uploaded in paste order ahead
 * of the user's own files, while the message text is only what was typed.
 * After a typed slash command the pastes stay inline, as its argument text.
 */

// The queue is server-backed; only what the composer hands it matters here.
const queuedMessages = vi.hoisted(() => [] as Array<{ scope: string; content: string; attachments: unknown[] }>);
vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    appendQueuedMessage: async (scope: string, message: { content: string; attachments?: unknown[] }) => {
      queuedMessages.push({ scope, content: message.content, attachments: message.attachments ?? [] });
      return { kept: true };
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-existing' };

const LONG_TEXT = 'x'.repeat(1_000);
const MANY_LINES = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join('\n');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type SentFrame = {
  type: string;
  sessionId?: string;
  content?: string;
  clientMessageId?: string;
  options?: { attachments?: unknown[] };
};

/** One upload request as the server received it: each file's name, type and exact bytes. */
type ReceivedUpload = Array<{ name: string; type: string; bytes: Uint8Array }>;
let uploads: ReceivedUpload[];
// Set by a test to make the upload endpoint fail.
let uploadFails: boolean;

/** The stored descriptor the server returns for an uploaded file. */
const storedRecord = (name: string, index: number, size: number) => ({
  name,
  path: `/home/u/.cloudcli/assets/${index}-${name.replace(/[^a-zA-Z0-9.-]/g, '_')}`,
  size,
  mimeType: 'text/plain;charset=utf-8',
});

const readBytes = (file: File) => new Promise<Uint8Array>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(file);
});

// The upload endpoint, as the server implements it; every other request gets an empty list.
const fakeFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (String(url) === '/api/assets/files' && init?.method === 'POST') {
    if (uploadFails) {
      return jsonResponse({ error: 'Disk full' }, 500);
    }
    const files = (init.body as FormData).getAll('files') as File[];
    uploads.push(await Promise.all(files.map(async (file) => ({ name: file.name, type: file.type, bytes: await readBytes(file) }))));
    return jsonResponse({ attachments: files.map((file, index) => storedRecord(file.name, index, file.size)) });
  }
  return jsonResponse([]);
};

const uploadedNames = () => uploads.map((upload) => upload.map((file) => file.name));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const renderComposer = async (
  { isLoading = false, processingSessions }: { isLoading?: boolean; processingSessions?: SessionActivityMap } = {},
) => {
  const sent: SentFrame[] = [];
  const added: ChatMessage[] = [];
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
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as SentFrame); },
      scrollToBottom: () => undefined,
      addMessage: (message) => { added.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }));
  // Let the mount-time requests (slash commands, drafts) finish while fetch is stubbed.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return {
    view,
    chatSends: () => sent.filter((message) => message.type === 'chat.send'),
    errors: () => added.filter((message) => message.type === 'error').map((message) => String(message.content)),
    echoes: () => added.filter((message) => message.type === 'user'),
  };
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
  uploads = [];
  uploadFails = false;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
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

test('each card is sent as a .txt file, in paste order ahead of attached files, and the text is only what was typed', async () => {
  const { view, chatSends } = await renderComposer();
  const userFile = new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' });
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  act(() => {
    view.result.current.setAttachedFiles([userFile]);
    view.result.current.setInput('Summarize both');
  });

  await submit(view);

  assert.deepEqual(uploadedNames(), [['Pasted text.txt', 'Pasted text (2).txt', 'brief.pdf']]);
  const [upload] = uploads;
  assert.equal(decode(upload[0].bytes), LONG_TEXT);
  assert.equal(decode(upload[1].bytes), MANY_LINES);
  assert.equal(upload[0].type, 'text/plain;charset=utf-8');

  const [frame] = chatSends();
  assert.equal(frame.content, 'Summarize both', 'no pasted text is inlined');
  assert.deepEqual(
    ((frame.options?.attachments ?? []) as Array<{ name: string }>).map((attachment) => attachment.name),
    ['Pasted text.txt', 'Pasted text (2).txt', 'brief.pdf'],
  );
  assert.deepEqual(view.result.current.pastedTexts, []);
  assert.deepEqual(view.result.current.attachedFiles, []);
  assert.equal(view.result.current.input, '');
});

test('the .txt file holds the paste exactly, UTF-8 encoded, emoji and CJK included', async () => {
  const { view } = await renderComposer();
  const unicode = `${'日本語のテキスト 🚀 Ünïcødé — 中文 '.repeat(40)}\r\nend 👋🏽`;
  paste(view, unicode);
  act(() => { view.result.current.setInput('read it'); });

  await submit(view);

  const [[file]] = uploads;
  assert.deepEqual(Array.from(file.bytes), Array.from(new TextEncoder().encode(unicode)));
  assert.equal(decode(file.bytes), unicode);
});

test('numbering follows the cards left after one is removed', async () => {
  const { view } = await renderComposer();
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  paste(view, `${LONG_TEXT}!`);
  act(() => {
    view.result.current.removePastedText(view.result.current.pastedTexts[0].id);
    view.result.current.setInput('go');
  });

  await submit(view);

  assert.deepEqual(uploadedNames(), [['Pasted text.txt', 'Pasted text (2).txt']]);
  assert.equal(decode(uploads[0][0].bytes), MANY_LINES);
});

test('a message of only a pasted card, with nothing typed, is sent with the file and shows its card at once', async () => {
  const { view, chatSends, echoes } = await renderComposer();
  paste(view, LONG_TEXT);

  await submit(view);

  const [frame] = chatSends();
  assert.equal(frame.content, '');
  assert.equal(((frame.options?.attachments ?? []) as unknown[]).length, 1);
  // The optimistic echo carries the file card and no text, under the id sent with it.
  const [echo] = echoes();
  assert.equal(echo.content, '');
  assert.equal(echo.clientMessageId, frame.clientMessageId);
  assert.deepEqual((echo.files ?? []).map((file) => file.name), ['Pasted text.txt']);
  assert.deepEqual(echo.images, []);
  assert.deepEqual(view.result.current.pastedTexts, []);
});

test('a typed slash command keeps the pasted text inline after it, as its argument text', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('/review'); });

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), [`/review\n\n${LONG_TEXT}`]);
  assert.equal(uploads.length, 0, 'nothing is uploaded for the paste');
});

test('pasted text that starts with a command name is sent as a file, not run as a command', async () => {
  const { view, chatSends } = await renderComposer();
  const pastedHelp = `/help ${LONG_TEXT}`;
  paste(view, pastedHelp);

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), ['']);
  assert.equal(decode(uploads[0][0].bytes), pastedHelp);
});

test('"help" typed with a pasted card is a message about the paste, not the help alias', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('help'); });

  await submit(view);

  assert.deepEqual(chatSends().map((message) => message.content), ['help']);
  assert.deepEqual(uploadedNames(), [['Pasted text.txt']]);
});

test('while a reply runs, the typed text is queued with the uploaded pasted file and the cards clear', async () => {
  const { view, chatSends } = await renderComposer({ isLoading: true });
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('next'); });

  await submit(view);

  assert.equal(chatSends().length, 0, 'nothing is sent while the reply runs');
  assert.deepEqual(queuedMessages, [{
    scope: 'session-existing',
    content: 'next',
    attachments: [storedRecord('Pasted text.txt', 0, LONG_TEXT.length)],
  }]);
  assert.deepEqual(view.result.current.pastedTexts, []);
  assert.equal(view.result.current.input, '');
});

test('the background-work Queue choice queues the typed text with the uploaded pasted file', async () => {
  const processingSessions: SessionActivityMap = new Map([[SESSION.id as string, {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [{ taskId: 't1', toolUseId: 'toolu_1', taskType: 'local_agent', description: 'Survey', startedAt: 1 }],
  }]]);
  const { view, chatSends } = await renderComposer({ processingSessions });
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('after the work'); });

  await act(async () => { await view.result.current.handleSendMenuChoice('queue'); });

  assert.equal(chatSends().length, 0);
  assert.deepEqual(queuedMessages, [{
    scope: 'session-existing',
    content: 'after the work',
    attachments: [storedRecord('Pasted text.txt', 0, LONG_TEXT.length)],
  }]);
  assert.deepEqual(view.result.current.pastedTexts, []);
});

test('a failed upload is reported and leaves the cards and the typed text in the composer', async () => {
  const { view, chatSends, errors } = await renderComposer();
  uploadFails = true;
  paste(view, LONG_TEXT);
  act(() => { view.result.current.setInput('keep me'); });
  const cards = view.result.current.pastedTexts;

  await submit(view);

  assert.equal(chatSends().length, 0);
  // The server's reason, with the request's reference for the server log.
  assert.equal(errors().length, 1);
  assert.match(errors()[0], /^Failed to upload files: Disk full Reference: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(view.result.current.pastedTexts, cards);
  assert.equal(view.result.current.input, 'keep me');
});

test('pasted files count toward the 10-file limit: over it, nothing is sent, nothing is dropped, and the paste is named', async () => {
  const { view, chatSends, errors } = await renderComposer();
  const files = Array.from({ length: 10 }, (_, index) => new File(['x'], `f${index}.txt`));
  act(() => { view.result.current.setAttachedFiles(files); });
  paste(view, LONG_TEXT);

  await submit(view);

  assert.equal(chatSends().length, 0);
  assert.equal(uploads.length, 0);
  assert.deepEqual(errors(), [], 'the composer says it, not the transcript');
  assert.deepEqual(view.result.current.attachmentRejections, [
    { fileName: 'Pasted text.txt', reason: 'too-many', pastedText: true },
  ]);
  assert.equal(view.result.current.pastedTexts.length, 1, 'the paste is kept');
  assert.equal(view.result.current.attachedFiles.length, 10);

  // Removing one file makes room; the paste then goes out with the rest.
  act(() => { view.result.current.setAttachedFiles(files.slice(1)); });
  await submit(view);
  assert.equal(chatSends().length, 1);
  const [names] = uploadedNames();
  assert.equal(names.length, 10);
  assert.equal(names[0], 'Pasted text.txt');
  assert.deepEqual(view.result.current.attachmentRejections, [], 'a send clears the notice');
});

test('over the limit, the newest pastes are the ones named, and changing the cards clears the notice', async () => {
  const { view } = await renderComposer();
  const files = Array.from({ length: 8 }, (_, index) => new File(['x'], `f${index}.txt`));
  act(() => { view.result.current.setAttachedFiles(files); });
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  paste(view, `${LONG_TEXT}!`);
  paste(view, `${MANY_LINES}!`);

  await submit(view);

  assert.deepEqual(view.result.current.attachmentRejections.map((rejection) => rejection.fileName), [
    'Pasted text (3).txt',
    'Pasted text (4).txt',
  ]);
  act(() => { view.result.current.removePastedText(view.result.current.pastedTexts[3].id); });
  assert.deepEqual(view.result.current.attachmentRejections, []);
  assert.equal(view.result.current.pastedTexts.length, 3, 'only the removed card goes');
});

test('a pasted text over the size limit is named and keeps its card', async () => {
  const { view, chatSends } = await renderComposer();
  paste(view, 'x'.repeat(MAX_CHAT_ATTACHMENT_SIZE_BYTES + 1));
  act(() => { view.result.current.setInput('summarize'); });

  await submit(view);

  assert.equal(chatSends().length, 0);
  assert.equal(uploads.length, 0);
  assert.deepEqual(view.result.current.attachmentRejections, [
    { fileName: 'Pasted text.txt', reason: 'too-large', pastedText: true },
  ]);
  assert.equal(view.result.current.pastedTexts.length, 1);
  assert.equal(view.result.current.input, 'summarize');
});

test('each pasted card takes an attachment slot, so an attach that would overfill the message names the files left out', async () => {
  const { view } = await renderComposer();
  paste(view, LONG_TEXT);
  paste(view, MANY_LINES);
  const images = Array.from({ length: 9 }, (_, index) => new File(['png'], `shot${index}.png`, { type: 'image/png' }));

  paste(view, '', images.map((image) => ({ type: 'image/png', getAsFile: () => image })));

  assert.equal(view.result.current.attachedFiles.length, 8);
  assert.deepEqual(view.result.current.attachmentRejections, [{ fileName: 'shot8.png', reason: 'too-many' }]);
});
