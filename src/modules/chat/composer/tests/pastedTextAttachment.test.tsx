import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import PastedTextAttachment from '@/modules/chat/composer/PastedTextAttachment';

const PAGE_TEXT = `Skip to main content\nDocs Home\n${'A long web page paragraph. '.repeat(80)}`;

const renderCard = () => {
  const onChange = vi.fn();
  const onRemove = vi.fn();
  render(<PastedTextAttachment text={PAGE_TEXT} onChange={onChange} onRemove={onRemove} />);
  return { onChange, onRemove };
};

const openEditor = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Edit pasted text' }));
  return screen.getByRole('dialog');
};

const editorTextarea = () => screen.getByRole('textbox', { name: 'Edit pasted text' }) as HTMLTextAreaElement;

describe('the pasted text card', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the start of the text and the Pasted label', () => {
    renderCard();

    const card = screen.getByRole('button', { name: 'Edit pasted text' });
    expect(card.textContent).toContain('Skip to main content');
    expect(card.textContent).toContain('Pasted');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the editor with the whole text when the card is clicked', () => {
    renderCard();

    const dialog = openEditor();

    expect(dialog).toBeTruthy();
    expect(editorTextarea().value).toBe(PAGE_TEXT);
  });

  it('saves the edited text', () => {
    const { onChange, onRemove } = renderCard();
    openEditor();

    fireEvent.change(editorTextarea(), { target: { value: 'just this part' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('just this part');
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves with Ctrl+Enter', () => {
    const { onChange } = renderCard();
    openEditor();

    fireEvent.change(editorTextarea(), { target: { value: 'shortcut' } });
    fireEvent.keyDown(editorTextarea(), { key: 'Enter', ctrlKey: true });

    expect(onChange).toHaveBeenCalledWith('shortcut');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removes the card when saved empty', () => {
    const { onChange, onRemove } = renderCard();
    openEditor();

    fireEvent.change(editorTextarea(), { target: { value: '   \n ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('changes nothing on Cancel', () => {
    const { onChange, onRemove } = renderCard();
    openEditor();

    fireEvent.change(editorTextarea(), { target: { value: 'discarded' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reopening starts from the card's text, not the discarded edit.
    openEditor();
    expect(editorTextarea().value).toBe(PAGE_TEXT);
  });

  it('closes on Escape without the Escape reaching the chat (which would stop a running reply)', () => {
    const { onChange } = renderCard();
    const chatEscape = vi.fn((event: KeyboardEvent) => { if (!event.defaultPrevented) event.preventDefault(); });
    document.addEventListener('keydown', chatEscape, { capture: true });
    try {
      openEditor();
      fireEvent.keyDown(editorTextarea(), { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', chatEscape, { capture: true });
    }

    expect(chatEscape).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('removes the card with its X', () => {
    const { onChange, onRemove } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Remove pasted text' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
