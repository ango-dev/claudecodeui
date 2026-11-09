import { useTranslation } from 'react-i18next';

import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import type { BackgroundSendChoice, BackgroundSendPrompt } from '@/shared/types';

type BackgroundSendDialogProps = {
  prompt: BackgroundSendPrompt | null;
  /** False until the capability matrix has loaded, or for a provider it does not list; the side-question button is left out rather than offered and then refused. */
  supportsSideQuestions?: boolean;
  /** False only for an attachment-only composer: a side question cannot carry attachments, so an empty question would be refused silently. Defaults to true so existing callers, which only ever opened this dialog with typed text, keep working. */
  hasText?: boolean;
  onResolve: (choice: BackgroundSendChoice) => void;
};

/**
 * Rendered by chat's ChatComposer when sending a message would stop a
 * session's background work: an edit of a sent message, or a message the
 * process holding that work cannot take (a different reasoning effort, say).
 * The choices are to send anyway, queue the message until the work finishes,
 * ask it as a side question instead (when the provider can), or cancel; an
 * edit can be neither queued nor asked on the side, so it has only Send anyway.
 *
 * Drawn like the app's other themed dialogs (AppDialogHost). Cancel comes
 * first in the DOM so Dialog's open-focus lands on it: an Enter pressed right
 * after the send that opened the prompt cancels instead of stopping the work.
 * Escape and a click outside also cancel; sending anyway takes a deliberate
 * click or Tab.
 */
export default function BackgroundSendDialog({ prompt, supportsSideQuestions = false, hasText = true, onResolve }: BackgroundSendDialogProps) {
  const { t } = useTranslation('chat');
  const isEdit = prompt?.reason === 'edit';

  const description = (() => {
    switch (prompt?.reason) {
      case 'edit':
        return t('claudeStatus.backgroundTask.prompt.editDescription', {
          defaultValue: 'Editing a message restarts the session, which stops that work; anything it has not reported yet is lost.',
        });
      case 'effort':
        return t('claudeStatus.backgroundTask.prompt.effortDescription', {
          defaultValue: 'This message uses a different reasoning effort, so it needs a new session process, which stops that work; anything it has not reported yet is lost. Queue it to send when the work finishes, or switch back to the earlier effort.',
        });
      default:
        return t('claudeStatus.backgroundTask.prompt.description', {
          defaultValue: 'This message cannot go to the process running that work, so sending it now stops the work; anything it has not reported yet is lost. Queue it to send when the work finishes.',
        });
    }
  })();

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) {
          onResolve('cancel');
        }
      }}
    >
      <DialogContent
        role="alertdialog"
        aria-describedby="background-send-dialog-description"
        // Same layer as the app's themed confirm: above Settings and modals.
        wrapperClassName="z-[10050]"
        // Escape answers this dialog, not the layer beneath it.
        data-escape-layer=""
        className="w-[calc(100%-2rem)] max-w-sm p-5"
      >
        <DialogTitle className="not-sr-only text-sm font-semibold text-foreground">
          {t('claudeStatus.backgroundTask.prompt.title', {
            defaultValue: 'This session still has background work running',
          })}
        </DialogTitle>

        {prompt && prompt.work.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-foreground/90">
            {prompt.work.map((item, index) => (
              <li key={`${index}-${item}`} className="break-words">{item}</li>
            ))}
          </ul>
        )}

        <p id="background-send-dialog-description" className="mt-2 break-words text-sm text-muted-foreground">
          {description}
        </p>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onResolve('cancel')}>
            {t('claudeStatus.backgroundTask.prompt.cancel', { defaultValue: 'Cancel' })}
          </Button>
          {/* Outlined, not filled: the theme's clay primary is too close to the
              destructive red to tell Queue from Send anyway, in dark mode above all. */}
          {!isEdit && (
            <Button type="button" variant="outline" size="sm" onClick={() => onResolve('queue')}>
              {t('claudeStatus.backgroundTask.prompt.queue', { defaultValue: 'Queue' })}
            </Button>
          )}
          {/* An edit replaces a sent message, so asking on the side instead is no answer to it. */}
          {!isEdit && supportsSideQuestions && hasText && (
            <Button type="button" variant="outline" size="sm" onClick={() => onResolve('sideQuestion')}>
              {t('claudeStatus.backgroundTask.prompt.sideQuestion', { defaultValue: 'Side question' })}
            </Button>
          )}
          <Button type="button" variant="destructive" size="sm" onClick={() => onResolve('send')}>
            {isEdit
              ? t('claudeStatus.backgroundTask.prompt.editAnyway', { defaultValue: 'Edit anyway' })
              : t('claudeStatus.backgroundTask.prompt.sendAnyway', { defaultValue: 'Send anyway' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
