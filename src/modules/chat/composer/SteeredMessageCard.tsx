import { useTranslation } from 'react-i18next';
import { PaperclipIcon } from 'lucide-react';

import type { PendingSteer } from '@/shared/types';

type SteeredMessageCardProps = {
  steer: PendingSteer;
  /** The provider's display name, e.g. "Claude". */
  providerLabel: string;
};

/**
 * Rendered by chat's ChatComposer for a message sent into the running turn
 * that the agent has not read yet, as a section of the block drawn on top of
 * the message box (the composer owns that block's border and surface, shared
 * with the queued follow-ups under it). It reads like the queued card, so the
 * two stack as one: a small uppercase label and status, then the text. There
 * is no edit or delete: the message is already in the agent's input. The
 * section goes away when the agent reads it and it appears in the transcript,
 * where it was read.
 */
export default function SteeredMessageCard({ steer, providerLabel }: SteeredMessageCardProps) {
  const { t } = useTranslation('chat');
  const attachmentCount = steer.uploadedAttachments.length || steer.attachments.length;
  const status = steer.status === 'sending'
    ? t('input.steer.sending', { defaultValue: 'Sending…' })
    : t('input.steer.willRead', { provider: providerLabel, defaultValue: '{{provider}} reads it at its next tool call' });

  return (
    <section data-testid="steered-message-card" aria-label={t('input.steer.label', { defaultValue: 'Steering' })}>
      <div className="flex flex-wrap items-center gap-x-1.5 py-1 pl-3 pr-2 text-[11px] font-medium leading-4 text-primary/70">
        {/* Pulses until the agent reads it, like the activity tab's dot. */}
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="shrink-0 uppercase tracking-wide">{t('input.steer.label', { defaultValue: 'Steering' })}</span>
        <span role="status" title={status} className="min-w-0 flex-1 truncate font-normal text-muted-foreground/70">
          · {status}
        </span>
        {attachmentCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 font-normal text-muted-foreground">
            <PaperclipIcon className="h-3 w-3 shrink-0" aria-hidden />
            {t('input.steer.attachments', {
              count: attachmentCount,
              defaultValue_one: '{{count}} file attached',
              defaultValue_other: '{{count}} files attached',
            })}
          </span>
        )}
      </div>
      {steer.content && (
        // Height-capped like the queued card's body, so a long message never covers the chat.
        <p className="scrollbar-thin max-h-24 overflow-y-auto overscroll-y-contain whitespace-pre-wrap break-words border-t border-primary/15 px-3 py-1.5 text-sm leading-5 text-foreground/90">
          {steer.content}
        </p>
      )}
    </section>
  );
}
