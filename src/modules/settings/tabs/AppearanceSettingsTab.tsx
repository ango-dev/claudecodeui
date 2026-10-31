import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_MESSAGES_PER_PAGE, MESSAGES_PER_PAGE_OPTIONS } from '@/shared/constants';
import { useTheme } from '@/shared/context/ThemeContext';
import { useSetUiPreference, useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { CodeEditorSettingsState, PreferenceToggleKey, ProjectSortOrder, ThemeMode } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import { formatShortcut } from '@/shared/utils';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import { Switch } from '@/shared/ui';

/** The display and input toggles that used to live in the Quick Settings drawer. */
const CHAT_TOGGLES: { key: PreferenceToggleKey; labelKey: string; descriptionKey?: string }[] = [
  { key: 'showRawParameters', labelKey: 'quickSettings.showRawParameters' },
  { key: 'showThinking', labelKey: 'quickSettings.showThinking' },
  {
    key: 'sendByCtrlEnter',
    labelKey: 'quickSettings.sendByCtrlEnter',
    descriptionKey: 'quickSettings.sendByCtrlEnterDescription',
  },
  {
    key: 'combineQueuedMessages',
    labelKey: 'quickSettings.combineQueuedMessages',
    descriptionKey: 'quickSettings.combineQueuedMessagesDescription',
  },
];

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** The send shortcut named in the "Send by" toggle, as this client writes it (⌘↩ or Ctrl+Enter). */
const shortcutValues = { shortcut: formatShortcut('Mod', 'Enter') };

/** Rendered by Settings for the "appearance" tab, covering theme, layout, chat display, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { themeMode, setThemeMode } = useTheme();
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();
  const [messagesPerPage, setMessagesPerPage] = useState(() => {
    const stored = readUserPreference<unknown>('messagesPerPage', DEFAULT_MESSAGES_PER_PAGE);
    return MESSAGES_PER_PAGE_OPTIONS.includes(stored as (typeof MESSAGES_PER_PAGE_OPTIONS)[number])
      ? (stored as number)
      : DEFAULT_MESSAGES_PER_PAGE;
  });

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.theme.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.theme.label')}
            description={t('appearanceSettings.theme.description')}
          >
            <select
              value={themeMode}
              onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
              aria-label={t('appearanceSettings.theme.label')}
              className="touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary w-36 flex-shrink-0"
            >
              <option value="light">{t('appearanceSettings.theme.light')}</option>
              <option value="dark">{t('appearanceSettings.theme.dark')}</option>
              <option value="system">{t('appearanceSettings.theme.system')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.layout.title')}>
        <SettingsCard>
          <SettingsRow label={t('quickSettings.sidebarAsDrawer')}>
            <Switch
              checked={preferences.sidebarAsDrawer}
              onChange={(value) => setPreference('sidebarAsDrawer', value)}
              ariaLabel={t('quickSettings.sidebarAsDrawer')}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.chat.title')}>
        <SettingsCard divided>
          {CHAT_TOGGLES.map(({ key, labelKey, descriptionKey }) => (
            <SettingsRow
              key={key}
              label={t(labelKey, shortcutValues)}
              description={descriptionKey ? t(descriptionKey, shortcutValues) : undefined}
            >
              <Switch
                checked={preferences[key]}
                onChange={(value) => setPreference(key, value)}
                ariaLabel={t(labelKey, shortcutValues)}
              />
            </SettingsRow>
          ))}
          <SettingsRow
            label={t('appearanceSettings.chat.messagesPerPage')}
            description={t('appearanceSettings.chat.messagesPerPageDescription')}
          >
            <select
              value={messagesPerPage}
              onChange={(event) => {
                const value = Number(event.target.value);
                setMessagesPerPage(value);
                writeUserPreference('messagesPerPage', value);
              }}
              aria-label={t('appearanceSettings.chat.messagesPerPage')}
              className="w-36 flex-shrink-0 touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {MESSAGES_PER_PAGE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary w-36 flex-shrink-0"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.keepProjectsExpanded.section', { defaultValue: 'Sidebar' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            description={t('appearanceSettings.keepProjectsExpanded.description', { defaultValue: 'Open several projects together and remember them after reloading.' })}
          >
            <Switch
              checked={preferences.keepProjectsExpanded}
              onChange={(value) => setPreference('keepProjectsExpanded', value)}
              ariaLabel={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <Switch
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <Switch
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <Switch
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary w-28 flex-shrink-0"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
