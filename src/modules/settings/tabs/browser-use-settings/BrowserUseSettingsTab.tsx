import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { api, readApiJson, ApiRequestError } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import BrowserAdminRightsNotice from '@/modules/settings/tabs/browser-use-settings/BrowserAdminRightsNotice';
import type { BrowserEngineChoice } from '@/modules/settings/tabs/browser-use-settings/BrowserAdminRightsNotice';

type BrowserUseEngine = 'playwright' | 'patchright';
type BrowserUseBrowser = 'chromium' | 'chrome';

type BrowserUseSettings = {
  enabled: boolean;
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  /** Where Google Chrome is, when it is not where its installer puts it. */
  chromePath: string | null;
};

type BrowserUseStatus = {
  enabled: boolean;
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  browserExecutablePath: string | null;
  isAdministrator: boolean;
  platform: string;
  available: boolean;
  /** Whether the chosen engine's package (Playwright or Patchright) loads. */
  playwrightInstalled: boolean;
  /** Whether the chosen browser (Chromium or Google Chrome) was found. */
  chromiumInstalled: boolean;
  installInProgress: boolean;
  message: string;
};

/** Recommended first: Patchright hides the automation tells sites check for, and real Chrome looks like a person's browser. */
const ENGINE_CHOICES: BrowserEngineChoice[] = ['patchright-chrome', 'patchright-chromium', 'playwright-chromium', 'playwright-chrome'];

/** Rendered by Settings for the "browser" tab, configuring the browser automation integration. */
const BROWSER_USE_ERROR_KEYS: Record<string, string> = {
  BROWSER_USE_STATUS_LOAD_FAILED: 'browserUseSettings.loadStatusFailed',
  BROWSER_USE_SETTINGS_LOAD_FAILED: 'browserUseSettings.loadSettingsFailed',
  BROWSER_USE_SETTINGS_SAVE_FAILED: 'browserUseSettings.saveFailed',
  BROWSER_USE_RUNTIME_INSTALL_FAILED: 'browserUseSettings.installFailed',
};

function localizeApiError(err: unknown, fallbackKey: string, t: (key: string) => string): string {
  if (err instanceof ApiRequestError && err.code && BROWSER_USE_ERROR_KEYS[err.code]) {
    return t(BROWSER_USE_ERROR_KEYS[err.code]);
  }
  return t(fallbackKey);
}

export default function BrowserUseSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<BrowserUseSettings | null>(null);
  const [status, setStatus] = useState<BrowserUseStatus | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The Chrome location as typed; saved on blur or Enter, not per keystroke,
  // since each change of location ends the open browser sessions.
  const [chromePathDraft, setChromePathDraft] = useState('');

  const loadSettings = useCallback(async () => {
    const settingsResponse = await api.browserUse.settings();
    const settingsData = await readApiJson<{ data: { settings: BrowserUseSettings } }>(settingsResponse);
    setSettings(settingsData.data.settings);
    setChromePathDraft(settingsData.data.settings.chromePath ?? '');
  }, [t]);

  const loadStatus = useCallback(async () => {
    const statusResponse = await api.browserUse.status();
    const statusData = await readApiJson<{ data: BrowserUseStatus }>(statusResponse);
    setStatus(statusData.data);
  }, [t]);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);

    void loadSettings()
      .catch((err) => setError(localizeApiError(err, 'browserUseSettings.loadSettingsFailed', t)))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(localizeApiError(err, 'browserUseSettings.loadStatusFailed', t)))
      .finally(() => setIsStatusLoading(false));
  }, [loadSettings, loadStatus, t]);

  const updateSettings = async (nextSettings: Partial<BrowserUseSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await api.browserUse.saveSettings(nextSettings);
      const data = await readApiJson<{ data: { settings: BrowserUseSettings } }>(response);
      setSettings(data.data.settings);
      setChromePathDraft(data.data.settings.chromePath ?? '');
      window.dispatchEvent(new Event('browserUseSettingsChanged'));
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(localizeApiError(err, 'browserUseSettings.saveFailed', t));
    } finally {
      setIsStatusLoading(false);
      setIsSaving(false);
    }
  };

  const installBrowserBinaries = async () => {
    setIsInstalling(true);
    setError(null);
    try {
      const response = await api.browserUse.installRuntime();
      await readApiJson(response);
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      // The server says what failed and, for Chrome, the admin commands to run.
      const details = err instanceof ApiRequestError && typeof err.details === 'string' ? err.details : null;
      setError(details ?? localizeApiError(err, 'browserUseSettings.installFailed', t));
      setIsStatusLoading(true);
      await loadStatus().catch(() => undefined);
    } finally {
      setIsStatusLoading(false);
      setIsInstalling(false);
    }
  };

  const browserEnabled = settings?.enabled === true;
  const engineChoice: BrowserEngineChoice = `${settings?.engine ?? 'playwright'}-${settings?.browser ?? 'chromium'}`;
  const usesChrome = settings?.browser === 'chrome';
  const engineLabel = settings?.engine === 'patchright' ? 'Patchright' : 'Playwright';
  const saveChromePath = () => {
    const next = chromePathDraft.trim() || null;
    if (next !== (settings?.chromePath ?? null)) {
      void updateSettings({ chromePath: next });
    }
  };
  const needsBrowserBinaries = Boolean(browserEnabled && status && (!status.playwrightInstalled || !status.chromiumInstalled));
  const runtimeLabel = (installed?: boolean) => {
    if (isStatusLoading && !status) {
      return t('browserUseSettings.checking');
    }
    return installed ? t('browserUseSettings.installed') : t('browserUseSettings.missing');
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('browserUseSettings.sectionTitle')}
        description={t('browserUseSettings.sectionDescription')}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('browserUseSettings.enableLabel')}
            description={t('browserUseSettings.enableDescription')}
          >
            {isSettingsLoading && !settings ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={browserEnabled}
                onChange={(value) => void updateSettings({ enabled: value })}
                ariaLabel={t('browserUseSettings.enableAriaLabel')}
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-3 px-4 py-4">
            <div>
              <label htmlFor="browser-use-engine" className="text-sm font-medium text-foreground">
                {t('browserUseSettings.engineLabel')}
              </label>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('browserUseSettings.engineDescription')}</p>
            </div>
            <select
              id="browser-use-engine"
              value={engineChoice}
              disabled={!settings || isSaving}
              onChange={(event) => {
                const [engine, browser] = event.target.value.split('-') as [BrowserUseEngine, BrowserUseBrowser];
                void updateSettings({ engine, browser });
              }}
              className="w-full max-w-md touch-manipulation rounded-lg border border-input bg-card p-2.5 pr-8 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {ENGINE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>{t(`browserUseSettings.engines.${choice}`)}</option>
              ))}
            </select>

            {usesChrome && (
              <div className="space-y-1">
                <label htmlFor="browser-use-chrome-path" className="text-sm font-medium text-foreground">
                  {t('browserUseSettings.chromePathLabel')}
                </label>
                <p className="text-sm text-muted-foreground">{t('browserUseSettings.chromePathDescription')}</p>
                <Input
                  id="browser-use-chrome-path"
                  value={chromePathDraft}
                  onChange={(event) => setChromePathDraft(event.target.value)}
                  onBlur={saveChromePath}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  disabled={isSaving}
                  placeholder={status?.browserExecutablePath ?? t('browserUseSettings.chromePathPlaceholder')}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="font-mono text-xs"
                />
                {status?.browserExecutablePath && status.chromiumInstalled && (
                  <p className="break-all text-xs text-muted-foreground">
                    {t('browserUseSettings.chromeFoundAt', { path: status.browserExecutablePath })}
                  </p>
                )}
              </div>
            )}

            {settings && (
              <BrowserAdminRightsNotice
                choice={engineChoice}
                platform={status?.platform ?? 'linux'}
                isAdministrator={status?.isAdministrator === true}
                t={t}
              />
            )}
          </div>

          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border px-2 py-1">
                {engineLabel}: {runtimeLabel(status?.playwrightInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                {usesChrome ? t('browserUseSettings.chromeLabel') : t('browserUseSettings.chromiumLabel')}: {runtimeLabel(status?.chromiumInstalled)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                {t('browserUseSettings.statusPrefix')}: {isStatusLoading && !status
                  ? t('browserUseSettings.checking')
                  : status?.available
                    ? t('browserUseSettings.ready')
                    : browserEnabled
                      ? t('browserUseSettings.setupRequired')
                      : t('browserUseSettings.disabled')}
              </span>
            </div>

            {needsBrowserBinaries && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-medium text-foreground">{t('browserUseSettings.runtimeRequiredTitle')}</div>
                  <p className="text-sm text-muted-foreground">
                    {status?.message || t('browserUseSettings.runtimeRequiredFallback')}
                  </p>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => void installBrowserBinaries()}
                  disabled={isInstalling || status?.installInProgress}
                  className="flex-shrink-0"
                >
                  {isInstalling || status?.installInProgress ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {isInstalling || status?.installInProgress
                    ? t('browserUseSettings.installing')
                    : t('browserUseSettings.installRuntime')}
                </Button>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
