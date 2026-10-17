import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type PastedTextAttachmentProps = {
  text: string;
  onChange: (text: string) => void;
  onRemove: () => void;
};

/**
 * Rendered by chat's ChatComposer for each long paste, as Claude does: a small
 * card with the start of the text instead of the text filling the message box.
 * The card opens the text in an editor; it is sent ahead of the typed message.
 */
export default function PastedTextAttachment({ text, onChange, onRemove }: PastedTextAttachmentProps) {
  const { t } = useTranslation('chat');
  // The editor's working copy while it is open; saved to the card only on Save.
  const [editing, setEditing] = useState<string | null>(null);
  const label = t('input.pasted.label', { defaultValue: 'Pasted' });
  const editLabel = t('input.pasted.edit', { defaultValue: 'Edit pasted text' });
  const removeLabel = t('input.pasted.remove', { defaultValue: 'Remove pasted text' });
  // The text's size, as the card's tooltip and the editor's subtitle show it.
  const describeSize = (value: string) => t('input.pasted.size', {
    count: value.split('\n').length,
    characters: value.length.toLocaleString(),
    defaultValue_one: '{{count}} line · {{characters}} characters',
    defaultValue_other: '{{count}} lines · {{characters}} characters',
  });

  // Escape closes the editor and nothing else. The window capture phase runs
  // ahead of the chat's document-level Escape, which would otherwise also stop
  // a running reply (the editor can be open while one runs, to queue a message).
  const isEditorOpen = editing !== null;
  useEffect(() => {
    if (!isEditorOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setEditing(null);
    };
    window.addEventListener('keydown', closeOnEscape, { capture: true });
    return () => window.removeEventListener('keydown', closeOnEscape, { capture: true });
  }, [isEditorOpen]);

  const save = () => {
    if (editing === null) {
      return;
    }
    if (editing.trim()) {
      onChange(editing);
    } else {
      onRemove();
    }
    setEditing(null);
  };

  return (
    <div className="group relative max-w-full">
      <button
        type="button"
        onClick={() => setEditing(text)}
        title={describeSize(text)}
        aria-label={editLabel}
        className="flex h-20 w-40 max-w-full flex-col justify-between overflow-hidden rounded-xl border border-border/50 bg-background/80 px-2.5 py-1.5 text-left shadow-sm transition-colors hover:border-border focus:outline-none focus:ring-2 focus:ring-primary/60"
      >
        {/* Leading blank lines would leave the preview empty; words wrap whole. */}
        <span className="line-clamp-3 w-full whitespace-pre-wrap break-words text-[10px] leading-[13px] text-muted-foreground">
          {text.trimStart().slice(0, 400)}
        </span>
        <span className="flex w-full items-center justify-between">
          <span className="rounded border border-border/70 px-1 text-[9px] font-semibold uppercase leading-[14px] tracking-wide text-foreground/80">
            {label}
          </span>
          <PencilIcon className="h-3 w-3 text-muted-foreground group-hover:text-foreground" aria-hidden />
        </span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 touch:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={removeLabel}
        title={removeLabel}
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>

      <Dialog open={isEditorOpen} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-3xl flex-col gap-3 p-4">
          <DialogTitle>{t('input.pasted.title', { defaultValue: 'Pasted text' })}</DialogTitle>
          <div className="flex items-baseline justify-between gap-3" aria-hidden>
            <span className="text-sm font-medium text-foreground">
              {t('input.pasted.title', { defaultValue: 'Pasted text' })}
            </span>
            <span className="text-xs text-muted-foreground">{describeSize(editing ?? text)}</span>
          </div>
          <textarea
            value={editing ?? ''}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                save();
              }
            }}
            spellCheck={false}
            aria-label={editLabel}
            className="min-h-[40vh] w-full flex-1 resize-none rounded-lg border border-border bg-background p-3 font-mono text-xs leading-5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {t('input.pasted.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t('input.pasted.save', { defaultValue: 'Save' })}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
