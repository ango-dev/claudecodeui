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

// Separate-turns mode; the merged default is covered in queuedMessageMergedCard.test.tsx.
const STRIP_MODE = { combined: false, onEditAll: () => {}, onDeleteAll: () => {} };

describe('the queued message row', () => {
  const originalScrollTo = HTMLElement.prototype.scrollTo;
  afterEach(() => {
    HTMLElement.prototype.scrollTo = originalScrollTo;
  });

  it('shows one numbered card per draft, oldest first', () => {
    render(<QueuedMessageRow {...STRIP_MODE} queuedDrafts={THREE_DRAFTS} onEdit={() => {}} onDelete={() => {}} />);

    const cards = screen.getAllByTestId('queued-message-card');
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => within(card).getByText(/^(Run|Then|Finally)/).textContent)).toEqual([
      'Run the tests',
      'Then fix whatever fails',
      'Finally update the changelog',
    ]);
    // The badge leads each card; the first one is also marked as next.
    expect(cards.map((card) => card.firstElementChild?.textContent?.trim())).toEqual(['1 Next', '2', '3']);
    expect(within(cards[1]).getByText('2 files')).toBeTruthy();
    expect(within(cards[0]).getByText('Run the tests').getAttribute('title')).toBe('Run the tests');
  });

  it('edits and deletes the card that was clicked, by id', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<QueuedMessageRow {...STRIP_MODE} queuedDrafts={THREE_DRAFTS} onEdit={onEdit} onDelete={onDelete} />);

    const cards = screen.getAllByTestId('queued-message-card');
    fireEvent.click(within(cards[1]).getByRole('button', { name: 'Edit queued message' }));
    fireEvent.click(within(cards[2]).getByRole('button', { name: 'Delete queued message' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith('q-2');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('q-3');
  });

  it('renders nothing when the queue is empty', () => {
    const { container } = render(
      <QueuedMessageRow {...STRIP_MODE} queuedDrafts={[]} onEdit={() => {}} onDelete={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('scrolls the strip sideways to the newest card when one is added, not when one is removed', () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    const props = { onEdit: () => {}, onDelete: () => {} };
    const { rerender } = render(<QueuedMessageRow {...STRIP_MODE} queuedDrafts={THREE_DRAFTS.slice(0, 2)} {...props} />);
    expect(scrollTo).not.toHaveBeenCalled();

    rerender(<QueuedMessageRow {...STRIP_MODE} queuedDrafts={THREE_DRAFTS} {...props} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' });

    rerender(<QueuedMessageRow {...STRIP_MODE} queuedDrafts={THREE_DRAFTS.slice(1)} {...props} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
