import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { PaperclipIcon, PencilIcon, Trash2Icon, XIcon } from 'lucide-react';

import type { QueuedDraft } from '@/shared/types';

type QueuedMessageMergedCardProps = {
  /** Oldest first, in the order the server merges and sends them. */
  queuedDrafts: QueuedDraft[];
  onDelete: (id: string) => void;
  onEditAll: () => void;
  onDeleteAll: () => void;
};

type QueuedSectionProps = {
  draft: QueuedDraft;
  onDelete: (id: string) => void;
};

// Mirrors the server: a slash command cannot be merged into the combined
// message, so it goes as its own turn and merging resumes after it.
function isSlashCommand(draft: QueuedDraft): boolean {
  return draft.content.trimStart().startsWith('/');
}

function getAttachmentCount(draft: QueuedDraft): number {
  return draft.uploadedAttachments?.length ?? draft.attachments.length;
}

// Turns are runs of plain drafts (each run becomes one message) plus one turn per command.
function countTurns(queuedDrafts: QueuedDraft[]): number {
  let turns = 0;
  let inPlainRun = false;
  for (const draft of queuedDrafts) {
    if (isSlashCommand(draft)) {
      turns += 1;
      inPlainRun = false;
    } else if (!inPlainRun) {
      turns += 1;
      inPlainRun = true;
    }
  }
  return turns;
}

function AttachmentCount({ count }: { count: number }) {
  const { t } = useTranslation('chat');
  return (
    <span className="flex items-center gap-1 text-[11px] leading-4 text-muted-foreground">
      <PaperclipIcon className="h-3 w-3 shrink-0" aria-hidden />
      {t('input.queue.attachments', {
        count,
        defaultValue_one: '{{count}} file',
        defaultValue_other: '{{count}} files',
      })}
    </span>
  );
}

function RemoveSectionButton({ draftId, onDelete }: { draftId: string; onDelete: (id: string) => void }) {
  const { t } = useTranslation('chat');
  const removeLabel = t('input.queue.delete', { defaultValue: 'Delete queued message' });
  return (
    <button
      type="button"
      onClick={() => onDelete(draftId)}
      aria-label={removeLabel}
      title={removeLabel}
      // Hover-revealed on pointer screens; always shown where there is no hover.
      className="absolute right-0 top-1 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
    >
      <XIcon className="h-3.5 w-3.5" />
    </button>
  );
}

function MergedSection({ draft, onDelete }: QueuedSectionProps) {
  const attachmentCount = getAttachmentCount(draft);
  return (
    <li data-testid="queued-merged-section" className="group relative py-1.5 pr-7">
      {draft.content && (
        <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground/90">{draft.content}</p>
      )}
      {attachmentCount > 0 && (
        <div className={draft.content ? 'mt-0.5' : undefined}>
          <AttachmentCount count={attachmentCount} />
        </div>
      )}
      <RemoveSectionButton draftId={draft.id} onDelete={onDelete} />
    </li>
  );
}

function CommandSection({ draft, onDelete }: QueuedSectionProps) {
  const { t } = useTranslation('chat');
  const command = draft.content.trim();
  return (
    <li data-testid="queued-command-section" className="group relative flex items-center gap-2 py-1.5 pr-7">
      <code title={command} className="min-w-0 truncate font-mono text-xs leading-5 text-foreground/90">
        {command}
      </code>
      <span
        className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium leading-4 text-primary/80"
        title={t('input.queue.separateHint', {
          defaultValue: 'Commands cannot be merged, so this one is sent as its own message',
        })}
      >
        {t('input.queue.separate', { defaultValue: 'Sent on its own' })}
      </span>
      <RemoveSectionButton draftId={draft.id} onDelete={onDelete} />
    </li>
  );
}

/**
 * Rendered by the chat module's QueuedMessageRow in combined mode: shows every
 * queued follow-up as the single merged message the server sends when the
 * running reply finishes, inside one height-capped card so a long queue never
 * covers the transcript. Slash commands are listed as their own lines because
 * the server sends each of them as a separate turn.
 */
export default function QueuedMessageMergedCard({
  queuedDrafts,
  onDelete,
  onEditAll,
  onDeleteAll,
}: QueuedMessageMergedCardProps) {
  const { t } = useTranslation('chat');
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Compared on each change so the body only scrolls when a follow-up was added, not when one is removed.
  const previousCountRef = useRef(queuedDrafts.length);

  useEffect(() => {
    const body = bodyRef.current;
    const grew = queuedDrafts.length > previousCountRef.current;
    previousCountRef.current = queuedDrafts.length;
    if (grew && body) {
      body.scrollTo?.({ top: body.scrollHeight, behavior: 'smooth' });
    }
  }, [queuedDrafts.length]);

  if (queuedDrafts.length === 0) {
    return null;
  }

  const count = queuedDrafts.length;
  const turnCount = countTurns(queuedDrafts);
  const totalAttachments = queuedDrafts.reduce((total, draft) => total + getAttachmentCount(draft), 0);
  let sendHint: string;
  if (count === 1) {
    sendHint = t('input.queue.willSend', { defaultValue: 'Will send when this finishes' });
  } else if (turnCount === 1) {
    sendHint = t('input.queue.willSendCombined', { defaultValue: 'Sends as one message when this finishes' });
  } else {
    sendHint = t('input.queue.willSendAsMessages', {
      count: turnCount,
      defaultValue_one: 'Sends as {{count}} message when this finishes',
      defaultValue_other: 'Sends as {{count}} messages when this finishes',
    });
  }
  const editAllLabel = t('input.queue.editAll', { defaultValue: 'Edit all queued messages' });
  const deleteAllLabel = t('input.queue.deleteAll', { defaultValue: 'Delete all queued messages' });

  return (
    <section
      data-testid="queued-message-merged-card"
      aria-label={t('input.queue.listLabel', { defaultValue: 'Queued messages' })}
      className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-dashed border-primary/25 bg-primary/[0.04]"
    >
      {/* On phones the send hint drops to its own line under the label and actions instead of truncating. */}
      <div className="flex flex-wrap items-center gap-x-1.5 py-1 pl-3 pr-1 text-[11px] font-medium leading-4 text-primary/70">
        <span className="shrink-0 uppercase tracking-wide">{t('input.queue.label', { defaultValue: 'Queued' })}</span>
        {count > 1 && (
          <span data-testid="queued-merged-count" className="shrink-0 tabular-nums">
            ·{' '}
            {t('input.queue.followUps', {
              count,
              defaultValue_one: '{{count}} follow-up',
              defaultValue_other: '{{count}} follow-ups',
            })}
          </span>
        )}
        <span
          title={sendHint}
          className="order-last min-w-0 basis-full truncate pb-0.5 pr-2 text-muted-foreground/60 sm:order-none sm:basis-auto sm:pb-0 sm:pr-0"
        >
          <span className="hidden sm:inline">· </span>
          {sendHint}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {totalAttachments > 0 && (
            <span className="mr-1 font-normal">
              <AttachmentCount count={totalAttachments} />
            </span>
          )}
          <button
            type="button"
            onClick={onEditAll}
            aria-label={editAllLabel}
            title={editAllLabel}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onDeleteAll}
            aria-label={deleteAllLabel}
            title={deleteAllLabel}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2Icon className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {/* Height-capped so a long queue scrolls inside the card instead of covering the chat;
          focusable so keyboard users can scroll it too. */}
      <div
        ref={bodyRef}
        tabIndex={0}
        aria-label={t('input.queue.mergedLabel', { defaultValue: 'Queued follow-ups, as they will be sent' })}
        className="scrollbar-thin max-h-32 overflow-y-auto overscroll-y-contain rounded-b-xl border-t border-dashed border-primary/15 px-3 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <ol className="divide-y divide-dashed divide-primary/15">
          {queuedDrafts.map((draft) =>
            isSlashCommand(draft) ? (
              <CommandSection key={draft.id} draft={draft} onDelete={onDelete} />
            ) : (
              <MergedSection key={draft.id} draft={draft} onDelete={onDelete} />
            ),
          )}
        </ol>
      </div>
    </section>
  );
}
