import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import PromptPresetEditorDialog from '@/modules/chat/modals/PromptPresetEditorDialog';

/**
 * The preset editor: a title and a prompt, both required, and whether every
 * project offers it. Saving waits for the server; a refusal keeps the editor
 * open with the server's reason.
 */

const renderEditor = ({
  initial = { title: '', content: '', global: false },
  onSave = vi.fn(async () => true),
  onClose = vi.fn(),
  saveError = null as string | null,
} = {}) => {
  render(
    <PromptPresetEditorDialog
      open
      mode="create"
      initial={initial}
      onSave={onSave}
      onClose={onClose}
      saveError={saveError}
    />,
  );
  const dialog = screen.getByRole('dialog');
  return { dialog, onSave, onClose };
};

test('a save with a blank title or prompt says what is missing and saves nothing', () => {
  const { dialog, onSave } = renderEditor();
  assert.equal(within(dialog).queryByText('Give the preset a title.'), null, 'no scolding before a first try');

  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  assert.ok(within(dialog).getByText('Give the preset a title.'));
  assert.ok(within(dialog).getByText('Write the prompt to save.'));
  assert.equal(within(dialog).getByLabelText('Title').getAttribute('aria-invalid'), 'true');
  assert.equal(onSave.mock.calls.length, 0);

  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '   ' } });
  fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Body' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  assert.ok(within(dialog).getByText('Give the preset a title.'), 'spaces are not a title');
  assert.equal(within(dialog).queryByText('Write the prompt to save.'), null);
  assert.equal(onSave.mock.calls.length, 0);
});

test('save hands over the trimmed title, the prompt as written and the global choice', async () => {
  const { dialog, onSave } = renderEditor();
  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: '  Review diff ' } });
  fireEvent.change(within(dialog).getByLabelText('Prompt'), { target: { value: 'Review this diff:\n\n' } });

  const globalSwitch = within(dialog).getByRole('switch', { name: 'Available in all projects' });
  assert.equal(globalSwitch.getAttribute('aria-checked'), 'false');
  assert.ok(within(dialog).getByText('Offered in this project only.'));
  fireEvent.click(globalSwitch);
  assert.equal(globalSwitch.getAttribute('aria-checked'), 'true');
  assert.ok(within(dialog).getByText('Offered in every project’s composer.'));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.equal(onSave.mock.calls.length, 1));
  assert.deepEqual(onSave.mock.calls[0], [{ title: 'Review diff', content: 'Review this diff:\n\n', global: true }]);
});

test('Ctrl+Enter saves from any field', async () => {
  const { dialog, onSave } = renderEditor({ initial: { title: 'T', content: 'C', global: true } });
  fireEvent.keyDown(within(dialog).getByLabelText('Prompt'), { key: 'Enter', ctrlKey: true });
  await waitFor(() => assert.deepEqual(onSave.mock.calls, [[{ title: 'T', content: 'C', global: true }]]));
});

test('Cancel and Escape close without saving; Cancel comes before Save', () => {
  const { dialog, onSave, onClose } = renderEditor({ initial: { title: 'T', content: 'C', global: false } });
  const buttons = within(dialog).getAllByRole('button').map((button) => button.textContent);
  assert.ok(buttons.indexOf('Cancel') < buttons.indexOf('Save'));

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(onClose.mock.calls.length, 2);
  assert.equal(onSave.mock.calls.length, 0);
});

test('the server’s reason for a refused save is shown', () => {
  const { dialog } = renderEditor({ saveError: 'The prompt is too long' });
  assert.equal(within(dialog).getByRole('alert').textContent, 'The prompt is too long');
});

test('the dialog sits on the themed-dialog layer and answers Escape first', () => {
  const { dialog } = renderEditor();
  assert.ok(dialog.hasAttribute('data-escape-layer'));
  assert.match(dialog.parentElement?.className ?? '', /z-\[10050\]/);
});
