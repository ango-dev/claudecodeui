import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { api, readApiJson, ApiRequestError } from '@/shared/api';

type InstalledEngine = {
  engine: 'playwright' | 'patchright';
  installed: boolean;
  /** The engine's own Chromium build (Google Chrome is the system's, not listed here). */
  chromiumInstalled: boolean;
};

type BrowserInstalledEnginesProps = {
  engines: InstalledEngine[];
  /** The engine and browser in use, whose parts cannot be removed. */
  activeEngine: InstalledEngine['engine'];
  usesChromium: boolean;
  /** Reloads the browser status after a removal. */
  onChanged: () => Promise<void>;
  t: TFunction;
};

const ENGINE_LABELS: Record<InstalledEngine['engine'], string> = { playwright: 'Playwright', patchright: 'Patchright' };

/**
 * Used by BrowserUseSettingsTab to list both engines with their Chromium
 * builds: Install Runtime adds the chosen one beside the other, so any of the
 * four engine and browser choices can be switched to, and what is no longer
 * wanted is removed here rather than left behind.
 */
export default function BrowserInstalledEngines({ engines, activeEngine, usesChromium, onChanged, t }: BrowserInstalledEnginesProps) {
  // The removal running, as "engine:part", so only its button shows progress.
  const [removing, setRemoving] = useState<string | null>(null);
  // Why the last removal failed, from the server.
  const [failure, setFailure] = useState<string | null>(null);
  const k = (key: string) => `browserUseSettings.engineList.${key}`;
  const listed = engines.filter((item) => item.installed || item.chromiumInstalled);

  if (listed.length === 0) {
    return null;
  }

  const remove = async (engine: InstalledEngine['engine'], part: 'engine' | 'chromium') => {
    setRemoving(`${engine}:${part}`);
    setFailure(null);
    try {
      await readApiJson(await api.browserUse.removeRuntime(engine, part));
    } catch (err) {
      setFailure(err instanceof ApiRequestError && typeof err.details === 'string' ? err.details : t(k('removeFailed')));
    } finally {
      await onChanged().catch(() => undefined);
      setRemoving(null);
    }
  };

  const removeButton = (engine: InstalledEngine['engine'], part: 'engine' | 'chromium', inUse: boolean) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
      onClick={() => void remove(engine, part)}
      disabled={removing !== null || inUse}
      title={inUse ? t(k('inUse')) : undefined}
    >
      {removing === `${engine}:${part}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      {part === 'engine' ? t(k('removeEngine')) : t(k('removeChromium'))}
    </Button>
  );

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">{t(k('title'))}</div>
      <p className="text-sm text-muted-foreground">{t(k('description'))}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {listed.map((item) => {
          const isActive = item.engine === activeEngine;
          return (
            <li key={item.engine} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-foreground">{ENGINE_LABELS[item.engine]}</span>
                {isActive && <span className="ml-2 text-xs text-muted-foreground">{t(k('active'))}</span>}
                <div className="text-xs text-muted-foreground">
                  {item.chromiumInstalled ? t(k('withChromium')) : t(k('withoutChromium'))}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {item.chromiumInstalled && removeButton(item.engine, 'chromium', isActive && usesChromium)}
                {item.installed && removeButton(item.engine, 'engine', isActive)}
              </div>
            </li>
          );
        })}
      </ul>
      {failure && (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {failure}
        </p>
      )}
    </div>
  );
}
