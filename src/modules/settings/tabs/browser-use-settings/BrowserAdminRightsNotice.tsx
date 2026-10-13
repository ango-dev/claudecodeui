import { ShieldAlert } from 'lucide-react';
import type { TFunction } from 'i18next';

export type BrowserEngineChoice = 'patchright-chrome' | 'patchright-chromium' | 'playwright-chromium' | 'playwright-chrome';

type BrowserAdminRightsNoticeProps = {
  choice: BrowserEngineChoice;
  /** Node's process.platform on the server: where the browser runs, not this device. */
  platform: string;
  /** The server runs as root, so Install can do the admin steps itself. */
  isAdministrator: boolean;
  /**
   * The engine's CLI by full path, from the server: npx is often missing,
   * and sudo resets the PATH (an nvm-installed Node vanishes under it).
   */
  engineCommand: string | null;
  t: TFunction;
};

type Step = { text: string; command?: string };

/** A command, set apart so it can be selected and copied whole. */
function Command({ children }: { children: string }) {
  return (
    <code className="mt-1 block select-all whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5">
      {steps.map((step) => (
        <li key={step.text + (step.command ?? '')}>
          {step.text}
          {step.command && <Command>{step.command}</Command>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Used by BrowserUseSettingsTab under the engine choice. Installing Google
 * Chrome system-wide, and Chromium's system libraries on Linux, need
 * administrator rights that CloudCLI's Install button usually does not have;
 * this says which commands need them and how to get by without them, for the
 * server's own platform.
 */
export default function BrowserAdminRightsNotice({ choice, platform, isAdministrator, engineCommand, t }: BrowserAdminRightsNoticeProps) {
  const engine = engineCommand ?? `npx ${choice.startsWith('patchright') ? 'patchright' : 'playwright'}`;
  const usesChrome = choice.endsWith('chrome');
  const os = platform === 'darwin' || platform === 'win32' ? platform : 'linux';
  const k = (key: string) => `browserUseSettings.admin.${key}`;

  const needsAdmin: Step[] = [];
  const withoutAdmin: Step[] = [];

  if (os === 'linux') {
    if (usesChrome) {
      needsAdmin.push({ text: t(k('linuxInstallChrome')), command: `sudo ${engine} install chrome` });
    }
    needsAdmin.push({ text: t(k('linuxInstallDeps')), command: `sudo ${engine} install-deps chromium` });
    if (usesChrome) {
      withoutAdmin.push({
        text: t(k('linuxUnpackChrome')),
        command: 'curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb\ndpkg-deb -x google-chrome-stable_current_amd64.deb ~/chrome',
      });
      withoutAdmin.push({ text: t(k('linuxUnpackedLocation')), command: '~/chrome/opt/google/chrome/chrome' });
    }
  } else if (os === 'darwin') {
    if (usesChrome) {
      needsAdmin.push({ text: t(k('macInstallChrome')) });
      withoutAdmin.push({ text: t(k('macUserApplications')) });
    }
  } else if (usesChrome) {
    needsAdmin.push({ text: t(k('windowsInstallChrome')), command: `${engine} install chrome` });
    withoutAdmin.push({ text: t(k('windowsUserInstall')) });
  }

  if (usesChrome) {
    withoutAdmin.push({ text: t(k('useChromium')) });
  } else {
    withoutAdmin.push({ text: t(k('chromiumNoAdmin')) });
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div className="min-w-0 space-y-1">
          <div className="font-medium">{t(k('title'))}</div>
          <p>
            {isAdministrator
              ? t(k('runningAsAdmin'))
              : usesChrome
                ? t(k('summaryChrome'))
                : t(k('summaryChromium'))}
          </p>
        </div>
      </div>

      {needsAdmin.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium">{t(k('needsAdminTitle'))}</div>
          {needsAdmin.some((step) => step.command) && <p className="text-xs opacity-80">{t(k('runInFolder'))}</p>}
          <StepList steps={needsAdmin} />
        </div>
      )}

      <div className="space-y-2">
        <div className="font-medium">{t(k('withoutAdminTitle'))}</div>
        <StepList steps={withoutAdmin} />
      </div>
    </div>
  );
}
