import { useEffect, useId, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle, Input, Switch } from '@/shared/ui';
import type { PromptPreset } from '@/shared/types';
import { cn, formatShortcut } from '@/shared/utils';

type PromptPresetEditorDialogProps = {
  open: boolean;
  /** 'create' for a new preset (blank, or holding the composer's message), 'edit' for an existing one. */
  mode: 'create' | 'edit';
  initial: Pick<PromptPreset, 'title' | 'content' | 'global'>;
  /** Resolves true once saved, which closes the editor; false keeps it open to try again. */
  onSave: (draft: Pick<PromptPreset, 'title' | 'content' | 'global'>) => Promise<boolean>;
  onClose: () => void;
  /** Why the last save failed, from the server, shown above the buttons. */
  saveError: string | null;
};

/**
 * Rendered by chat's PromptPresetMenu to write a new preset prompt or change
 * one: its title, its text and whether every project offers it.
 *
 * Drawn like the app's other themed dialogs (BackgroundSendDialog,
 * AppDialogHost): the same layer, Escape answered here first, Cancel ahead of
 * Save. The title field takes the focus, since a preset saved from the
 * message box arrives with its text and no name. Ctrl/Cmd+Enter saves.
 */
export default function PromptPresetEditorDialog({
  open,
  mode,
  initial,
  onSave,
  onClose,
  saveError,
}: PromptPresetEditorDialogProps) {
  const { t } = useTranslation('chat');
  const fieldId = useId();
  // The form's working copy; the menu remounts the editor for each opening,
  // so it always starts from the preset (or message) it was opened for.
  const [title, setTitle] = useState(initial.title);
  const [content, setContent] = useState(initial.content);
  const [isGlobal, setIsGlobal] = useState(initial.global);
  // The "required" messages appear only after a first try at saving, so an
  // empty form does not open already scolding.
  const [hasTriedSaving, setHasTriedSaving] = useState(false);
  // Holds Save while the request runs, so a double press cannot save twice.
  const [isSaving, setIsSaving] = useState(false);

  // Escape closes the editor and nothing else. The window capture phase runs
  // ahead of the chat's document-level Escape, which would otherwise also stop
  // a running reply, as in the pasted-text editor.
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape, { capture: true });
    return () => window.removeEventListener('keydown', closeOnEscape, { capture: true });
  }, [onClose, open]);

  const titleMissing = !title.trim();
  const contentMissing = !content.trim();
  const showTitleError = hasTriedSaving && titleMissing;
  const showContentError = hasTriedSaving && contentMissing;

  const save = async () => {
    setHasTriedSaving(true);
    if (titleMissing || contentMissing || isSaving) return;
    setIsSaving(true);
    try {
      // The title is trimmed; the prompt keeps its own spacing, as it is inserted as written.
      await onSave({ title: title.trim(), content, global: isGlobal });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  const heading = mode === 'edit'
    ? t('promptPresets.editor.editHeading', { defaultValue: 'Edit preset' })
    : t('promptPresets.editor.newHeading', { defaultValue: 'New preset' });
  const titleErrorId = `${fieldId}-title-error`;
  const contentErrorId = `${fieldId}-content-error`;
  const globalHintId = `${fieldId}-global-hint`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        // Same layer as the app's themed confirm: above Settings and modals.
        wrapperClassName="z-[10050]"
        // Escape answers this dialog, not the layer beneath it.
        data-escape-layer=""
        className="flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg flex-col p-5"
      >
        <DialogTitle className="not-sr-only text-sm font-semibold text-foreground">{heading}</DialogTitle>

        <form noValidate onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${fieldId}-title`} className="text-xs font-medium text-foreground">
              {t('promptPresets.editor.titleLabel', { defaultValue: 'Title' })}
            </label>
            <Input
              id={`${fieldId}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('promptPresets.editor.titlePlaceholder', { defaultValue: 'e.g. Review this diff' })}
              autoComplete="off"
              aria-invalid={showTitleError}
              aria-describedby={showTitleError ? titleErrorId : undefined}
              className={cn('bg-background', showTitleError && 'border-destructive focus-visible:ring-destructive')}
            />
            {showTitleError && (
              <p id={titleErrorId} className="text-xs text-destructive">
                {t('promptPresets.editor.titleRequired', { defaultValue: 'Give the preset a title.' })}
              </p>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <label htmlFor={`${fieldId}-content`} className="text-xs font-medium text-foreground">
              {t('promptPresets.editor.contentLabel', { defaultValue: 'Prompt' })}
            </label>
            <textarea
              id={`${fieldId}-content`}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t('promptPresets.editor.contentPlaceholder', {
                defaultValue: 'The text to put in the message box when you pick this preset',
              })}
              aria-invalid={showContentError}
              aria-describedby={showContentError ? contentErrorId : undefined}
              className={cn(
                'min-h-[12rem] w-full flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:min-h-[16rem]',
                showContentError && 'border-destructive focus-visible:ring-destructive',
              )}
            />
            {showContentError && (
              <p id={contentErrorId} className="text-xs text-destructive">
                {t('promptPresets.editor.contentRequired', { defaultValue: 'Write the prompt to save.' })}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {t('promptPresets.editor.globalLabel', { defaultValue: 'Available in all projects' })}
              </p>
              <p id={globalHintId} className="text-xs text-muted-foreground">
                {isGlobal
                  ? t('promptPresets.editor.globalOnHint', { defaultValue: 'Offered in every project’s composer.' })
                  : t('promptPresets.editor.globalOffHint', { defaultValue: 'Offered in this project only.' })}
              </p>
            </div>
            <Switch
              checked={isGlobal}
              onChange={setIsGlobal}
              ariaLabel={t('promptPresets.editor.globalLabel', { defaultValue: 'Available in all projects' })}
              ariaDescribedBy={globalHintId}
            />
          </div>

          {saveError && (
            <p role="alert" className="break-words rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto hidden text-xs text-muted-foreground touch:!hidden sm:inline">
              {t('promptPresets.editor.saveShortcut', {
                shortcut: formatShortcut('Mod', 'Enter'),
                defaultValue: '{{shortcut}} to save',
              })}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t('promptPresets.editor.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving
                ? t('promptPresets.editor.saving', { defaultValue: 'Saving…' })
                : t('promptPresets.editor.save', { defaultValue: 'Save' })}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
