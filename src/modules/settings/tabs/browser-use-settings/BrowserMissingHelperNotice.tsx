import { useState } from 'react';
import { Download, Loader2, PackageX } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { api, readApiJson, ApiRequestError } from '@/shared/api';

/** A program a browser setting needs on the server, as the status reports it. */
export type BrowserSystemHelper = {
  id: 'xvfb' | 'pulseaudio' | 'fluxbox';
  label: string;
  /** The current settings use it. */
  required: boolean;
  installed: boolean;
  /** The command that installs it, with sudo; null off Linux. */
  installCommand: string | null;
};

type BrowserMissingHelperNoticeProps = {
  helper: BrowserSystemHelper;
  /** Reloads the browser status once the program may have been installed. */
  onInstalled: () => Promise<void>;
  t: TFunction;
};

/**
 * Used by BrowserUseSettingsTab for each program the chosen settings need but
 * the server lacks (Xvfb for a real window, PulseAudio for the virtual
 * speaker and mic, Fluxbox for the taskbar): sessions cannot start without
 * it. Its button installs it where CloudCLI has admin rights (root, or sudo
 * without a password); otherwise the server's answer, naming the command to
 * run, replaces the text.
 */
export default function BrowserMissingHelperNotice({ helper, onInstalled, t }: BrowserMissingHelperNoticeProps) {
  // Why the last install attempt failed: from the server, naming the command to run.
  const [failure, setFailure] = useState<string | null>(null);
  // Guards the button while the package manager runs, which can take a minute.
  const [isInstalling, setIsInstalling] = useState(false);
  const k = (key: string) => t(`browserUseSettings.helpers.${key}`, { label: helper.label });

  const install = async () => {
    setIsInstalling(true);
    setFailure(null);
    try {
      await readApiJson(await api.browserUse.installSystemHelper(helper.id));
    } catch (err) {
      setFailure(err instanceof ApiRequestError && typeof err.details === 'string' ? err.details : k('installFailed'));
    } finally {
      await onInstalled().catch(() => undefined);
      setIsInstalling(false);
    }
  };

  return (
    <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-start gap-2">
        <PackageX className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{k('missingTitle')}</div>
          <p>{k(`why.${helper.id}`)}</p>
        </div>
      </div>

      {helper.installCommand && (
        <div className="space-y-1">
          <p className="text-xs opacity-80">{k('manualCommand')}</p>
          <code className="block select-all whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
            {helper.installCommand}
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
        {isInstalling ? k('installing') : k('install')}
      </Button>
    </div>
  );
}
