import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type * as SharedApi from '@/shared/api';
import type { PromptPreset } from '@/shared/types';
import PromptPresetMenu from '@/modules/chat/composer/PromptPresetMenu';

/**
 * The composer's preset menu: the open project's saved prompts and the ones
 * offered everywhere. Picking one puts its text in the message box (it never
 * sends) and records it as used; the menu also writes, edits and deletes them.
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

// The preset cache outlives a test, so each test has a project, and preset ids, of its own.
let projectCounter = 0;

const makePresets = (projectId: string, count: number, globalCount = 0): PromptPreset[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${projectId}-preset-${index}`,
    projectId: index < globalCount ? null : projectId,
    title: `Preset ${index}`,
    content: `Prompt body ${index}\nsecond line`,
    global: index < globalCount,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastUsedAt: null,
  }));

const renderMenu = async (
  presets: (projectId: string) => PromptPreset[],
  { hasMessage = false, message = '' }: { hasMessage?: boolean; message?: string } = {},
) => {
  projectCounter += 1;
  const projectId = `menu-project-${projectCounter}`;
  const list = presets(projectId);
  presetApi.list.mockResolvedValue(ok({ presets: list }));
  const onInsert = vi.fn();
  const view = render(
    <PromptPresetMenu projectId={projectId} hasMessage={hasMessage} readMessage={() => message} onInsert={onInsert} />,
  );
  // Let the list request land in the cache.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(presetApi.list.mock.calls.at(-1), [projectId]);
  return { ...view, projectId, list, onInsert };
};

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Preset prompts' }));
  return screen.getByRole('menu', { name: 'Preset prompts' });
};

/** Saves the open editor and lets the request settle, as the user would wait for it. */
const clickSave = async (dialog: HTMLElement) => {
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save' })); });
};

const presetRows = (menu: HTMLElement) =>
  within(menu).getAllByRole('menuitem').filter((item) => item.closest('[data-preset-item]'));

beforeEach(() => {
  for (const mock of Object.values(presetApi)) mock.mockReset();
});

test('lists each preset with its title, a one-line preview and an "All projects" badge for global ones', async () => {
  await renderMenu((projectId) => makePresets(projectId, 3, 1));
  const menu = openMenu();

  const rows = presetRows(menu);
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent ?? '', /Preset 0/);
  assert.match(rows[0].textContent ?? '', /All projects/);
  assert.match(rows[0].textContent ?? '', /Prompt body 0 second line/, 'line breaks fold into one line');
  assert.doesNotMatch(rows[1].textContent ?? '', /All projects/);
});

test('with no presets it says how to start, and saving the message needs a message', async () => {
  await renderMenu(() => []);
  const menu = openMenu();

  assert.ok(within(menu).getByText('No presets yet — save prompts you reuse here'));
  const saveMessage = within(menu).getByRole('menuitem', { name: 'Save message as preset' }) as HTMLButtonElement;
  assert.equal(saveMessage.disabled, true);
  assert.equal((within(menu).getByRole('menuitem', { name: 'New preset' }) as HTMLButtonElement).disabled, false);
});

test('the search field appears past five presets and filters by title and by prompt', async () => {
  const few = await renderMenu((projectId) => makePresets(projectId, 5));
  assert.equal(within(openMenu()).queryByRole('searchbox'), null);
  few.unmount();

  await renderMenu((projectId) => [
    ...makePresets(projectId, 5),
    { ...makePresets(projectId, 6)[5], title: 'Release notes', content: 'Summarise the CHANGELOG since the last tag' },
  ]);
  const menu = openMenu();
  const search = within(menu).getByRole('searchbox', { name: 'Search presets' });

  fireEvent.change(search, { target: { value: 'release' } });
  assert.deepEqual(presetRows(menu).map((row) => row.querySelector('span span')?.textContent), ['Release notes']);

  fireEvent.change(search, { target: { value: 'changelog' } });
  assert.equal(presetRows(menu).length, 1, 'the prompt text is searched too');

  fireEvent.change(search, { target: { value: 'nothing like this' } });
  assert.equal(presetRows(menu).length, 0);
  assert.ok(within(menu).getByText('No presets match your search'));
});

test('picking a preset inserts its text, closes the menu and records it as used — it never sends', async () => {
  const { onInsert, list } = await renderMenu((projectId) => makePresets(projectId, 3));
  presetApi.markUsed.mockResolvedValue(ok({ preset: list[1] }));
  const menu = openMenu();

  fireEvent.click(presetRows(menu)[1]);

  assert.deepEqual(onInsert.mock.calls, [[list[1].content]]);
  assert.equal(screen.queryByRole('menu'), null);
  assert.deepEqual(presetApi.markUsed.mock.calls, [[list[1].id]]);
  assert.equal(presetApi.create.mock.calls.length + presetApi.update.mock.calls.length, 0);
});

test('the arrow keys move between the presets and the footer actions, and Escape closes back to the button', async () => {
  await renderMenu((projectId) => makePresets(projectId, 3));
  const menu = openMenu();
  const rows = presetRows(menu);
  assert.equal(document.activeElement, rows[0], 'the first preset takes the focus');

  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  assert.equal(document.activeElement, rows[1]);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  assert.equal(document.activeElement, within(menu).getByRole('menuitem', { name: 'New preset' }), 'wraps past the top, skipping the disabled action');
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  assert.equal(document.activeElement, rows[0]);

  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Preset prompts' }));
});

test('Enter in the search field picks the first match', async () => {
  const { onInsert, list } = await renderMenu((projectId) => makePresets(projectId, 7));
  presetApi.markUsed.mockResolvedValue(ok({ preset: list[4] }));
  const menu = openMenu();
  const search = within(menu).getByRole('searchbox');
  assert.equal(document.activeElement, search, 'the search field takes the focus where there is one');

  fireEvent.change(search, { target: { value: 'body 4' } });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  assert.equal(document.activeElement, presetRows(menu)[0]);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(search, { key: 'Enter' });

  assert.deepEqual(onInsert.mock.calls, [[list[4].content]]);
});

test('edit opens the editor on the preset and saves the change through', async () => {
  const { list } = await renderMenu((projectId) => makePresets(projectId, 2));
  presetApi.update.mockResolvedValue(ok({ preset: { ...list[1], title: 'Renamed' } }));
  const menu = openMenu();

  fireEvent.click(within(menu).getByRole('button', { name: 'Edit “Preset 1”' }));
  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('Edit preset'));
  const title = within(dialog).getByLabelText('Title') as HTMLInputElement;
  assert.equal(title.value, 'Preset 1');
  assert.equal((within(dialog).getByLabelText('Prompt') as HTMLTextAreaElement).value, list[1].content);

  fireEvent.change(title, { target: { value: 'Renamed' } });
  await clickSave(dialog);

  assert.equal(screen.queryByRole('dialog'), null);
  assert.deepEqual(presetApi.update.mock.calls, [[list[1].id, { title: 'Renamed', content: list[1].content, global: false }]]);
  const reopened = screen.getByRole('menu', { name: 'Preset prompts' });
  assert.ok(within(reopened).getByText('Renamed'), 'the menu opens again on the saved list');
});

test('delete asks first, and only a yes deletes', async () => {
  const { list } = await renderMenu((projectId) => makePresets(projectId, 2));
  presetApi.remove.mockResolvedValue(ok({ deleted: true }));
  const confirm = vi.spyOn(window, 'confirm');

  confirm.mockReturnValueOnce(false);
  fireEvent.click(within(openMenu()).getByRole('button', { name: 'Delete “Preset 0”' }));
  await waitFor(() => assert.ok(screen.getByRole('menu')));
  assert.match(String(confirm.mock.calls[0][0]), /Delete the preset “Preset 0”\?/);
  assert.equal(presetApi.remove.mock.calls.length, 0);

  confirm.mockReturnValueOnce(true);
  fireEvent.click(within(screen.getByRole('menu')).getByRole('button', { name: 'Delete “Preset 0”' }));
  await waitFor(() => assert.deepEqual(presetApi.remove.mock.calls, [[list[0].id]]));
  await waitFor(() => assert.equal(presetRows(screen.getByRole('menu')).length, 1));
});

test('"Save message as preset" opens the editor holding the message', async () => {
  const { projectId } = await renderMenu(() => [], { hasMessage: true, message: '  Explain this stack trace step by step\n' });
  presetApi.create.mockImplementation(async (body: { title: string; content: string; global: boolean }) =>
    ok({ preset: { ...makePresets(projectId, 1)[0], ...body } }, 201));
  const menu = openMenu();

  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Save message as preset' }));
  const dialog = await screen.findByRole('dialog');
  assert.ok(within(dialog).getByText('New preset'));
  assert.equal((within(dialog).getByLabelText('Prompt') as HTMLTextAreaElement).value, 'Explain this stack trace step by step');

  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Explain trace' } });
  await clickSave(dialog);
  assert.equal(presetApi.create.mock.calls.length, 1);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.deepEqual(presetApi.create.mock.calls[0], [{
    projectId,
    title: 'Explain trace',
    content: 'Explain this stack trace step by step',
    global: false,
  }]);
});

test('"New preset" opens an empty editor', async () => {
  await renderMenu((projectId) => makePresets(projectId, 1), { hasMessage: true, message: 'typed' });
  fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'New preset' }));
  const dialog = await screen.findByRole('dialog');
  assert.equal((within(dialog).getByLabelText('Title') as HTMLInputElement).value, '');
  assert.equal((within(dialog).getByLabelText('Prompt') as HTMLTextAreaElement).value, '');
});
