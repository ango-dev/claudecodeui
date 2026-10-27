import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

import '@/modules/i18n';
import QueuedMessageRow from '@/modules/chat/composer/QueuedMessageRow';
import type { QueuedDraft } from '@/shared/types';

const draft = (id: string, content: string, attachmentCount = 0): QueuedDraft => ({
  id,
  content,
  attachments: Array.from({ length: attachmentCount }, (_, index) => new File(['x'], `file-${index}.txt`)),
});

const THREE_DRAFTS = [
  draft('q-1', 'Run the tests'),
  draft('q-2', 'Then fix whatever fails', 2),
  draft('q-3', 'Finally update the changelog'),
];

const renderMerged = (queuedDrafts: QueuedDraft[], handlers: Partial<Record<'onEdit' | 'onDelete' | 'onEditAll' | 'onDeleteAll', () => void>> = {}) =>
  render(
    <QueuedMessageRow
      combined
      queuedDrafts={queuedDrafts}
      onEdit={handlers.onEdit ?? (() => {})}
      onDelete={handlers.onDelete ?? (() => {})}
      onEditAll={handlers.onEditAll ?? (() => {})}
      onDeleteAll={handlers.onDeleteAll ?? (() => {})}
    />,
  );

describe('the merged queued message card', () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  afterEach(() => {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  });

  it('shows every follow-up in order inside one card, with the count and total attachments', () => {
    renderMerged(THREE_DRAFTS);

    const cards = screen.getAllByTestId('queued-message-merged-card');
    expect(cards).toHaveLength(1);
    expect(screen.queryByTestId('queued-message-card')).toBeNull();
    const sections = within(cards[0]).getAllByTestId('queued-merged-section');
    expect(sections.map((section) => section.querySelector('p')?.textContent)).toEqual([
      'Run the tests',
      'Then fix whatever fails',
      'Finally update the changelog',
    ]);
    expect(within(cards[0]).getByTestId('queued-merged-count').textContent).toContain('3 follow-ups');
    expect(within(cards[0]).getByText(/Sends as one message when this finishes/)).toBeTruthy();
    // The header total and the section that carries the files both say "2 files".
    expect(within(cards[0]).getAllByText('2 files')).toHaveLength(2);
    // The capped body is focusable so it can be scrolled from the keyboard.
    expect(screen.getByLabelText('Queued follow-ups, as they will be sent').getAttribute('tabindex')).toBe('0');
  });

  it('uses the single-message wording and no count for one follow-up', () => {
    renderMerged([draft('q-1', 'Run the tests')]);
    expect(screen.queryByTestId('queued-merged-count')).toBeNull();
    expect(screen.getByText(/Will send when this finishes/)).toBeTruthy();
  });

  it('removes a single follow-up by id from its section', () => {
    const onDelete = vi.fn();
    renderMerged(THREE_DRAFTS, { onDelete });

    const sections = screen.getAllByTestId('queued-merged-section');
    fireEvent.click(within(sections[1]).getByRole('button', { name: 'Delete queued message' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('q-2');
  });

  it('edits and deletes the whole queue from the header', () => {
    const onEditAll = vi.fn();
    const onDeleteAll = vi.fn();
    const onEdit = vi.fn();
    renderMerged(THREE_DRAFTS, { onEditAll, onDeleteAll, onEdit });

    fireEvent.click(screen.getByRole('button', { name: 'Edit all queued messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete all queued messages' }));
    expect(onEditAll).toHaveBeenCalledTimes(1);
    expect(onDeleteAll).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('lists a slash command as sent on its own and counts the separate turns', () => {
    const onDelete = vi.fn();
    renderMerged(
      [draft('q-1', 'Run the tests'), draft('q-2', '  /compact keep the plan'), draft('q-3', 'Then continue')],
      { onDelete },
    );

    const command = screen.getByTestId('queued-command-section');
    expect(within(command).getByText('/compact keep the plan')).toBeTruthy();
    expect(within(command).getByText('Sent on its own')).toBeTruthy();
    expect(screen.getAllByTestId('queued-merged-section')).toHaveLength(2);
    // Plain run, command, plain run: three turns.
    expect(screen.getByText(/Sends as 3 messages when this finishes/)).toBeTruthy();

    fireEvent.click(within(command).getByRole('button', { name: 'Delete queued message' }));
    expect(onDelete).toHaveBeenCalledWith('q-2');
  });

  it('counts the uploaded attachments when the draft has them', () => {
    renderMerged([{ ...draft('q-1', 'See attached'), uploadedAttachments: [{}, {}, {}] }]);
    expect(screen.getAllByText('3 files')).toHaveLength(2);
  });

  it('scrolls the capped body to the newest follow-up when one is added, not when one is removed', () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    const { rerender } = renderMerged(THREE_DRAFTS.slice(0, 2));
    const props = { onEdit: () => {}, onDelete: () => {}, onEditAll: () => {}, onDeleteAll: () => {} };
    expect(scrollTo).not.toHaveBeenCalled();

    rerender(<QueuedMessageRow combined queuedDrafts={THREE_DRAFTS} {...props} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    rerender(<QueuedMessageRow combined queuedDrafts={THREE_DRAFTS.slice(1)} {...props} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('renders the separate-cards row when combining is off', () => {
    render(
      <QueuedMessageRow
        combined={false}
        queuedDrafts={THREE_DRAFTS}
        onEdit={() => {}}
        onDelete={() => {}}
        onEditAll={() => {}}
        onDeleteAll={() => {}}
      />,
    );
    expect(screen.queryByTestId('queued-message-merged-card')).toBeNull();
    expect(screen.getAllByTestId('queued-message-card')).toHaveLength(3);
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = renderMerged([]);
    expect(container.innerHTML).toBe('');
  });
});
