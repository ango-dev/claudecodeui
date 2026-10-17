import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PaperclipIcon, PencilIcon, XIcon } from 'lucide-react';

import type { QueuedDraft } from '@/shared/types';

type QueuedMessageRowProps = {
  /** Oldest first: the first draft is the one sent when the current turn ends. */
  queuedDrafts: QueuedDraft[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

type QueuedMessageCardProps = {
  draft: QueuedDraft;
  position: number;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

function QueuedMessageCard({ draft, position, onEdit, onDelete }: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');
  const isNext = position === 1;
  const attachmentCount = draft.uploadedAttachments?.length ?? draft.attachments.length;
  const editLabel = t('input.queue.edit', { defaultValue: 'Edit queued message' });
  const deleteLabel = t('input.queue.delete', { defaultValue: 'Delete queued message' });
  const nextLabel = t('input.queue.next', { defaultValue: 'Next' });

  return (
    <li
      data-testid="queued-message-card"
      className="settings-content-enter flex h-14 w-[13.5rem] shrink-0 snap-start items-start gap-2 rounded-xl border border-dashed border-primary/25 bg-primary/[0.04] py-1.5 pl-2 pr-1 sm:w-60"
    >
      <span
        className={[
          'mt-px flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
          isNext ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary/80',
        ].join(' ')}
        title={isNext ? nextLabel : undefined}
      >
        {position}
        {isNext && <span className="sr-only"> {nextLabel}</span>}
      </span>

      <div className="min-w-0 flex-1 pt-0.5">
        {draft.content && (
          <p
            title={draft.content}
            // One line of text when the attachment line needs the second one, so the card keeps its height.
            className={`${attachmentCount > 0 ? 'line-clamp-1' : 'line-clamp-2'} break-words text-xs leading-4 text-foreground/90`}
          >
            {draft.content}
          </p>
        )}
        {attachmentCount > 0 && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
            <PaperclipIcon className="h-3 w-3 shrink-0" aria-hidden />
            {t('input.queue.attachments', {
              count: attachmentCount,
              defaultValue_one: '{{count}} file',
              defaultValue_other: '{{count}} files',
            })}
          </p>
        )}
      </div>

      <div className="-my-0.5 flex shrink-0 flex-col">
        <button
          type="button"
          onClick={() => onEdit(draft.id)}
          aria-label={editLabel}
          title={editLabel}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PencilIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(draft.id)}
          aria-label={deleteLabel}
          title={deleteLabel}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </li>
  );
}

/**
 * Rendered by chat's ChatComposer to show the messages queued for a busy
 * session as one short, sideways-scrolling strip of cards (so several of them
 * never push the transcript up), each with edit and delete actions before it
 * is auto-sent in order.
 */
export default function QueuedMessageRow({ queuedDrafts, onEdit, onDelete }: QueuedMessageRowProps) {
  const { t } = useTranslation('chat');
  const rowRef = useRef<HTMLOListElement | null>(null);
  // Compared on each change so the strip only scrolls when a card was added, not when one is removed.
  const previousCountRef = useRef(queuedDrafts.length);

  useEffect(() => {
    const row = rowRef.current;
    const grew = queuedDrafts.length > previousCountRef.current;
    previousCountRef.current = queuedDrafts.length;
    if (!grew || !row) {
      return;
    }
    // Scroll the strip itself rather than calling scrollIntoView on the card,
    // which would also scroll the page vertically. In RTL the newest card sits
    // at the left end, where scrollLeft is negative.
    const isRtl = getComputedStyle(row).direction === 'rtl';
    row.scrollTo?.({ left: isRtl ? -row.scrollWidth : row.scrollWidth, behavior: 'smooth' });
  }, [queuedDrafts.length]);

  if (queuedDrafts.length === 0) {
    return null;
  }

  const listLabel = t('input.queue.listLabel', { defaultValue: 'Queued messages' });

  return (
    <div className="mx-auto mb-2 max-w-[54.25rem]">
      <div className="mb-1 flex items-center gap-1.5 truncate px-1 text-[11px] font-medium leading-4 text-primary/70">
        <span className="uppercase tracking-wide">{t('input.queue.label', { defaultValue: 'Queued' })}</span>
        {queuedDrafts.length > 1 && <span className="tabular-nums">· {queuedDrafts.length}</span>}
        <span className="truncate text-muted-foreground/60">
          ·{' '}
          {queuedDrafts.length > 1
            ? t('input.queue.willSendInOrder', { defaultValue: 'Sends in order when this finishes' })
            : t('input.queue.willSend', { defaultValue: 'Will send when this finishes' })}
        </span>
      </div>
      <ol
        ref={rowRef}
        aria-label={listLabel}
        className="scrollbar-thin flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain"
      >
        {queuedDrafts.map((draft, index) => (
          <QueuedMessageCard
            key={draft.id}
            draft={draft}
            position={index + 1}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </ol>
    </div>
  );
}
