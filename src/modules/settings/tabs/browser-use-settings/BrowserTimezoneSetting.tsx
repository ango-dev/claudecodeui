import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';

type BrowserTimezoneSettingProps = {
  /** The chosen zone, or null for the server's. */
  timezone: string | null;
  /** The server's own zone (often UTC), shown on the default option. */
  serverTimezone: string;
  disabled: boolean;
  onChange: (timezone: string | null) => void;
  t: TFunction;
};

/** Every zone this device's browser knows; a short list where it cannot say. */
function listTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  try {
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones?.length) return zones;
  } catch {
    // Older browsers: fall back below.
  }
  return ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney'];
}

/**
 * Used by BrowserUseSettingsTab for the browser's time zone. Sites compare it
 * with the IP's location, and a server's UTC next to a home IP is a classic
 * bot sign. The device viewing Settings is usually where the server's
 * internet connection is, so its zone is one tap away.
 */
export default function BrowserTimezoneSetting({ timezone, serverTimezone, disabled, onChange, t }: BrowserTimezoneSettingProps) {
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = listTimezones();
  // A saved zone this browser does not list still has to show as selected.
  const options = timezone && !zones.includes(timezone) ? [timezone, ...zones] : zones;

  return (
    <div className="space-y-1">
      <label htmlFor="browser-use-timezone" className="text-sm font-medium text-foreground">
        {t('browserUseSettings.timezone.label')}
      </label>
      <p className="text-sm text-muted-foreground">{t('browserUseSettings.timezone.description')}</p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <select
          id="browser-use-timezone"
          value={timezone ?? ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
          className="w-full max-w-md touch-manipulation rounded-lg border border-input bg-card p-2.5 pr-8 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-auto"
        >
          <option value="">{t('browserUseSettings.timezone.server', { zone: serverTimezone })}</option>
          {options.map((zone) => (
            <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {deviceTimezone && deviceTimezone !== timezone && (
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange(deviceTimezone)}>
            {t('browserUseSettings.timezone.useDevice', { zone: deviceTimezone.replace(/_/g, ' ') })}
          </Button>
        )}
      </div>
    </div>
  );
}
