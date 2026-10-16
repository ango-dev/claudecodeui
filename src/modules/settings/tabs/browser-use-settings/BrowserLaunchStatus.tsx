import { ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { TFunction } from 'i18next';

/** How the last browser started, as the server reports it after each launch. */
export type BrowserLaunchReport = {
  sandbox: 'on' | 'off';
  /** Why Chrome's sandbox is off; null while it is on. */
  sandboxReason: string | null;
  /** Each of CloudCLI's Chrome flag changes that the launched browser does not show. */
  warnings: string[];
  checkedAt: string;
};

type BrowserLaunchStatusProps = {
  report: BrowserLaunchReport | null;
  t: TFunction;
};

/**
 * Used by BrowserUseSettingsTab under the WebGL check. Says whether Chrome's
 * sandbox was on for the last browser started, and lists any Chrome flag
 * change that did not take, so an engine update that breaks one is seen
 * rather than silently undone. Nothing shows until a browser has started.
 */
export default function BrowserLaunchStatus({ report, t }: BrowserLaunchStatusProps) {
  if (!report) {
    return null;
  }
  const k = (key: string, values?: Record<string, string>) => t(`browserUseSettings.launch.${key}`, values);

  return (
    <div className="space-y-2">
      {report.sandbox === 'on' ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{k('sandboxOn')}</span>
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 break-words">{k('sandboxOff', { reason: report.sandboxReason ?? '' })}</span>
        </p>
      )}

      {report.warnings.length > 0 && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          <div className="flex items-start gap-2 font-medium">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{k('warningsTitle')}</span>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-9">
            {report.warnings.map((warning) => <li key={warning} className="break-words">{warning}</li>)}
          </ul>
          <p className="mt-1 pl-6">{k('warningsHint')}</p>
        </div>
      )}
    </div>
  );
}
