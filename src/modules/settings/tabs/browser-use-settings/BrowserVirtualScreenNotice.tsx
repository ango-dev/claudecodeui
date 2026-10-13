import { useState } from 'react';
import { Download, Loader2, MonitorX } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { api, readApiJson, ApiRequestError } from '@/shared/api';

type BrowserVirtualScreenNoticeProps = {
  /** The command that installs Xvfb on the server, with sudo. */
  installCommand: string | null;
  /** Reloads the browser status once Xvfb may have been installed. */
  onInstalled: () => Promise<void>;
  t: TFunction;
};

/**
 * Used by BrowserUseSettingsTab while the real-window mode is chosen on a
 * Linux server without Xvfb: browser sessions cannot start until it is
 * installed. Its button installs Xvfb where CloudCLI has admin rights (root,
 * or sudo without a password); otherwise the server's answer, with the
 * command to run by hand, replaces the text.
 */
export default function BrowserVirtualScreenNotice({ installCommand, onInstalled, t }: BrowserVirtualScreenNoticeProps) {
  // Why the last install attempt failed: from the server, naming the command to run.
  const [failure, setFailure] = useState<string | null>(null);
  // Guards the button while the package manager runs, which can take a minute.
  const [isInstalling, setIsInstalling] = useState(false);
  const k = (key: string) => `browserUseSettings.virtualScreen.${key}`;

  const install = async () => {
    setIsInstalling(true);
    setFailure(null);
    try {
      await readApiJson(await api.browserUse.installVirtualScreen());
    } catch (err) {
      setFailure(err instanceof ApiRequestError && typeof err.details === 'string' ? err.details : t(k('installFailed')));
    } finally {
      await onInstalled().catch(() => undefined);
      setIsInstalling(false);
    }
  };

  return (
    <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-start gap-2">
        <MonitorX className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{t(k('missingTitle'))}</div>
          <p>{t(k('missingDescription'))}</p>
        </div>
      </div>

      {installCommand && (
        <div className="space-y-1">
          <p className="text-xs opacity-80">{t(k('manualCommand'))}</p>
          <code className="block select-all whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
            {installCommand}
          </code>
        </div>
      )}

      {failure && (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {failure}
        </p>
      )}

      <Button type="button" size="sm" onClick={() => void install()} disabled={isInstalling}>
        {isInstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {isInstalling ? t(k('installing')) : t(k('install'))}
      </Button>
    </div>
  );
}
