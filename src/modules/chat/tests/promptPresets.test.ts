import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { PromptPreset } from '@/shared/types';
import type { usePromptPresets as UsePromptPresets } from '@/modules/chat/hooks/usePromptPresets';

/**
 * The composer's preset prompts: read per project and cached in memory, so
 * reopening a project shows its list at once; every change shows straight
 * away and is undone, with the server's message kept, when the server refuses.
 */

const presetApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  markUsed: vi.fn(),
}));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return { ...actual, api: { ...actual.api, promptPresets: presetApi } };
});

const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { 'Content-Type': 'application/json' } });
const refused = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

const preset = (id: string, overrides: Partial<PromptPreset> = {}): PromptPreset => ({
  id,
  projectId: 'p',
  title: `Title ${id}`,
  content: `Content ${id}`,
  global: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  ...overrides,
});

// The cache is module state, so each test imports the hook afresh (below) and
// reads projects of its own.
let usePromptPresets: typeof UsePromptPresets;
let projectCounter = 0;
const nextProjectId = () => {
  projectCounter += 1;
  return `project-${projectCounter}`;
};

const ids = (presets: PromptPreset[]) => presets.map((item) => item.id);

/** A response the test settles itself, to look at the list while a request is in flight. */
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve };
};

const renderLoaded = async (projectId: string, presets: PromptPreset[]) => {
  presetApi.list.mockResolvedValueOnce(ok({ presets }));
  const view = renderHook(({ id }) => usePromptPresets(id), { initialProps: { id: projectId as string | null } });
  await waitFor(() => assert.deepEqual(ids(view.result.current.presets), ids(presets)));
  return view;
};

beforeEach(async () => {
  vi.resetModules();
  ({ usePromptPresets } = await import('@/modules/chat/hooks/usePromptPresets'));
  for (const mock of Object.values(presetApi)) mock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

test('loads the project’s presets and reads again when the project changes', async () => {
  const first = nextProjectId();
  const second = nextProjectId();
  const view = await renderLoaded(first, [preset('a', { projectId: first }), preset('g', { global: true, projectId: null })]);
  assert.deepEqual(presetApi.list.mock.calls, [[first]]);

  presetApi.list.mockResolvedValueOnce(ok({ presets: [preset('b', { projectId: second })] }));
  view.rerender({ id: second });
  await waitFor(() => assert.deepEqual(ids(view.result.current.presets), ['b']));
  assert.deepEqual(presetApi.list.mock.calls.at(-1), [second]);
});

test('says it is loading only until the first list arrives', async () => {
  const projectId = nextProjectId();
  const pending = deferred();
  presetApi.list.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => usePromptPresets(projectId));
  assert.equal(result.current.isLoading, true);

  await act(async () => { pending.resolve(ok({ presets: [] })); });
  assert.equal(result.current.isLoading, false);
  assert.deepEqual(result.current.presets, []);
});

test('a project opened again shows its cached list at once while it is read again', async () => {
  const projectId = nextProjectId();
  const first = await renderLoaded(projectId, [preset('a', { projectId })]);
  first.unmount();

  const pending = deferred();
  presetApi.list.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => usePromptPresets(projectId));
  assert.deepEqual(ids(result.current.presets), ['a'], 'shown before the second read lands');
  assert.equal(result.current.isLoading, false);

  await act(async () => { pending.resolve(ok({ presets: [preset('b', { projectId }), preset('a', { projectId })] })); });
  assert.deepEqual(ids(result.current.presets), ['b', 'a']);
});

test('no project reads nothing and offers nothing', () => {
  const { result } = renderHook(() => usePromptPresets(null));
  assert.equal(presetApi.list.mock.calls.length, 0);
  assert.deepEqual(result.current.presets, []);
});

test('a failed read keeps the server’s message, and dismissing it reads again', async () => {
  const projectId = nextProjectId();
  presetApi.list.mockResolvedValueOnce(refused(404, 'PROJECT_NOT_FOUND', 'Project not found'));
  const { result } = renderHook(() => usePromptPresets(projectId));
  await waitFor(() => assert.equal(result.current.error, 'Project not found'));
  assert.equal(result.current.isLoading, false, 'a failed read is not still loading');

  presetApi.list.mockResolvedValueOnce(ok({ presets: [preset('a', { projectId })] }));
  await act(async () => { result.current.clearError(); });
  assert.equal(result.current.error, null);
  await waitFor(() => assert.deepEqual(ids(result.current.presets), ['a']));
  assert.equal(presetApi.list.mock.calls.length, 2);
});

test('an error belongs to its project and does not follow a switch', async () => {
  const first = nextProjectId();
  const second = nextProjectId();
  presetApi.list.mockResolvedValueOnce(refused(404, 'PROJECT_NOT_FOUND', 'Project not found'));
  const view = renderHook(({ id }) => usePromptPresets(id), { initialProps: { id: first } });
  await waitFor(() => assert.equal(view.result.current.error, 'Project not found'));

  presetApi.list.mockResolvedValueOnce(ok({ presets: [] }));
  view.rerender({ id: second });
  assert.equal(view.result.current.error, null);
});

test('a new preset shows at the top at once and takes the saved preset’s id', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId })]);
  const pending = deferred();
  presetApi.create.mockReturnValueOnce(pending.promise);

  let saving!: Promise<PromptPreset | null>;
  act(() => { saving = result.current.createPreset({ title: 'New', content: 'Body', global: false }); });
  assert.equal(result.current.presets.length, 2);
  assert.equal(result.current.presets[0].title, 'New', 'shown before the server answers');
  assert.deepEqual(presetApi.create.mock.calls, [[{ projectId, title: 'New', content: 'Body', global: false }]]);

  await act(async () => { pending.resolve(ok({ preset: preset('saved', { projectId, title: 'New', content: 'Body' }) }, 201)); });
  assert.equal((await saving)?.id, 'saved');
  assert.deepEqual(ids(result.current.presets), ['saved', 'a']);
});

test('a refused new preset is taken away again and the server’s message kept', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId })]);
  presetApi.create.mockResolvedValueOnce(refused(413, 'TOO_MANY_PROMPT_PRESETS', 'You have too many presets'));

  let saved: PromptPreset | null = null;
  await act(async () => { saved = await result.current.createPreset({ title: 'New', content: 'Body', global: false }); });
  assert.equal(saved, null);
  assert.deepEqual(ids(result.current.presets), ['a']);
  assert.equal(result.current.error, 'You have too many presets');
});

test('an edit shows at once in place, and a refused one is put back', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId }), preset('b', { projectId })]);
  const pending = deferred();
  presetApi.update.mockReturnValueOnce(pending.promise);

  act(() => { void result.current.updatePreset('b', { title: 'Renamed', content: 'Content b', global: false }); });
  assert.deepEqual(result.current.presets.map((item) => item.title), ['Title a', 'Renamed']);

  await act(async () => { pending.resolve(refused(400, 'INVALID_PRESET_TITLE', 'The title is too long')); });
  assert.deepEqual(result.current.presets.map((item) => item.title), ['Title a', 'Title b']);
  assert.equal(result.current.error, 'The title is too long');
});

test('taking a preset out of all projects sends the project it now belongs to', async () => {
  const projectId = nextProjectId();
  const global = preset('g', { global: true, projectId: null });
  const { result } = await renderLoaded(projectId, [global]);
  presetApi.update.mockResolvedValueOnce(ok({ preset: { ...global, global: false, projectId } }));

  await act(async () => { await result.current.updatePreset('g', { title: global.title, content: global.content, global: false }); });
  assert.deepEqual(presetApi.update.mock.calls, [['g', { title: global.title, content: global.content, global: false, projectId }]]);
  assert.equal(result.current.presets[0].projectId, projectId);
});

test('a preset made global shows in another cached project, and leaves it when made local again', async () => {
  const home = nextProjectId();
  const other = nextProjectId();
  const homeView = await renderLoaded(home, [preset('a', { projectId: home })]);
  const otherView = await renderLoaded(other, [preset('o', { projectId: other })]);

  presetApi.update.mockResolvedValueOnce(ok({ preset: preset('a', { global: true, projectId: null }) }));
  await act(async () => { await homeView.result.current.updatePreset('a', { title: 'Title a', content: 'Content a', global: true }); });
  assert.deepEqual(ids(otherView.result.current.presets), ['a', 'o']);

  presetApi.update.mockResolvedValueOnce(ok({ preset: preset('a', { projectId: home }) }));
  await act(async () => { await homeView.result.current.updatePreset('a', { title: 'Title a', content: 'Content a', global: false }); });
  assert.deepEqual(ids(otherView.result.current.presets), ['o']);
  assert.deepEqual(ids(homeView.result.current.presets), ['a']);
});

test('a delete takes the preset away at once, and a refused one puts it back where it was', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId }), preset('b', { projectId }), preset('c', { projectId })]);
  const pending = deferred();
  presetApi.remove.mockReturnValueOnce(pending.promise);

  let removing!: Promise<boolean>;
  act(() => { removing = result.current.removePreset('b'); });
  assert.deepEqual(ids(result.current.presets), ['a', 'c']);

  await act(async () => { pending.resolve(refused(404, 'PROMPT_PRESET_NOT_FOUND', 'Preset not found')); });
  assert.equal(await removing, false);
  assert.deepEqual(ids(result.current.presets), ['a', 'b', 'c']);
  assert.equal(result.current.error, 'Preset not found');
});

test('a delete the server accepts stays done', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId }), preset('b', { projectId })]);
  presetApi.remove.mockResolvedValueOnce(ok({ deleted: true }));

  await act(async () => { assert.equal(await result.current.removePreset('a'), true); });
  assert.deepEqual(presetApi.remove.mock.calls, [['a']]);
  assert.deepEqual(ids(result.current.presets), ['b']);
});

test('a used preset moves to the top at once; a failure puts it back quietly', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId }), preset('b', { projectId })]);
  const pending = deferred();
  presetApi.markUsed.mockReturnValueOnce(pending.promise);

  act(() => { void result.current.markPresetUsed('b'); });
  assert.deepEqual(ids(result.current.presets), ['b', 'a']);
  assert.ok(result.current.presets[0].lastUsedAt);

  await act(async () => { pending.resolve(refused(404, 'PROMPT_PRESET_NOT_FOUND', 'Preset not found')); });
  assert.deepEqual(ids(result.current.presets), ['a', 'b']);
  assert.equal(result.current.presets[1].lastUsedAt, null);
  assert.equal(result.current.error, null, 'bookkeeping the user did not ask for is not reported');
});

test('a used preset takes the server’s record once it answers', async () => {
  const projectId = nextProjectId();
  const { result } = await renderLoaded(projectId, [preset('a', { projectId }), preset('b', { projectId })]);
  presetApi.markUsed.mockResolvedValueOnce(ok({ preset: preset('b', { projectId, lastUsedAt: '2026-10-31T12:00:00.000Z' }) }));

  await act(async () => { await result.current.markPresetUsed('b'); });
  assert.deepEqual(presetApi.markUsed.mock.calls, [['b']]);
  assert.deepEqual(ids(result.current.presets), ['b', 'a']);
  assert.equal(result.current.presets[0].lastUsedAt, '2026-10-31T12:00:00.000Z');
});
