import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui/Button';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/Dialog';
import {
  readCurrentDialogRequest,
  registerDialogHost,
  settleDialogRequest,
  subscribeToDialogRequests,
} from '@/shared/ui/appDialogRequests';

/**
 * Draws `confirmDialog` and `alertDialog` requests in the app's theme; mounted
 * once by App, above every route.
 */
export function AppDialogHost() {
  const { t } = useTranslation('common');
  const request = useSyncExternalStore(subscribeToDialogRequests, readCurrentDialogRequest);

  useEffect(() => registerDialogHost(), []);

  if (!request) {
    return null;
  }

  // Escape, the backdrop and Cancel all answer "no", as the browser's dialog does.
  const settle = (confirmed: boolean) => settleDialogRequest(request.id, confirmed);
  const isConfirm = request.kind === 'confirm';
  const messageId = `app-dialog-message-${request.id}`;

  return (
    // Keyed so a queued request opens as a fresh dialog with its own focus.
    <Dialog key={request.id} open onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent
        role="alertdialog"
        aria-describedby={messageId}
        // Above every other layer, the MCP form's z-[10000] included: a
        // question from inside Settings or a modal must not open behind it.
        wrapperClassName="z-[10050]"
        // Escape answers this dialog, not the Settings or editor beneath it.
        data-escape-layer=""
        className="w-[calc(100%-2rem)] max-w-sm p-5"
      >
        <DialogTitle>{isConfirm ? t('buttons.confirm', 'Confirm') : t('buttons.ok', 'OK')}</DialogTitle>
        <p id={messageId} className="whitespace-pre-line break-words text-sm text-foreground">
          {request.message}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          {/* First in the tab order, so Enter on a confirm takes the safe answer. */}
          {isConfirm && (
            <Button variant="ghost" size="sm" onClick={() => settle(false)}>
              {request.cancelLabel ?? t('buttons.cancel', 'Cancel')}
            </Button>
          )}
          <Button
            variant={request.destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? t('buttons.ok', 'OK')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
