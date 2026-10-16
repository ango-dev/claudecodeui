import { useSyncExternalStore } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';
import SettingsToggle from '@/modules/settings/SettingsToggle';

// Off unless turned on: it edits each Claude Code transcript after every turn.
const SHOW_SESSIONS_IN_VS_CODE_DEFAULT = false;

// Matches the server, which only counts a stored `true`.
const readShowSessionsInVsCode = () => (
  readUserPreference<unknown>('showSessionsInVsCode', SHOW_SESSIONS_IN_VS_CODE_DEFAULT) === true
);

/**
 * Rendered by AgentCategoryContentSection as Claude's Sessions tab. The
 * server reads the stored preference as each Claude run starts and, while it
 * is on, marks the session's transcript so the VS Code panel lists it.
 */
export default function VsCodeSessionsSwitch() {
  const { t } = useTranslation('settings');
  const showSessionsInVsCode = useSyncExternalStore(subscribeToUserPreferences, readShowSessionsInVsCode);
  const label = t('agents.vsCodeSessions.label');

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {/* The command stays on one line instead of breaking at its dashes. */}
          <Trans
            t={t}
            i18nKey="agents.vsCodeSessions.description"
            components={{ cmd: <code className="whitespace-nowrap font-mono" /> }}
          />
        </div>
      </div>
      <SettingsToggle
        checked={showSessionsInVsCode}
        onChange={(value) => writeUserPreference('showSessionsInVsCode', value)}
        ariaLabel={label}
      />
    </div>
  );
}
