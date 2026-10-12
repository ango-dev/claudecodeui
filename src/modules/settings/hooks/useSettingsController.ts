import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { setNotificationSoundEnabled } from '@/shared/utils';
import {
  readCodeEditorSettings,
  writeCodeEditorSettings,
} from '@/shared/codeEditorSettings';
import {
  readUserPreference,
  writeUserPreferences,
} from '@/shared/userSettings';
import { useProviderAuthStatus } from '@/modules/provider-auth';
import type { AgentProvider, ClaudePermissionsState, CodeEditorSettingsState, CodexPermissionMode, CursorPermissionsState, NotificationPreferencesState, ProjectSortOrder, SettingsMainTab } from '@/shared/types';

const DEFAULT_CURSOR_PERMISSIONS: CursorPermissionsState = {
  allowedCommands: [],
  disallowedCommands: [],
  skipPermissions: false,
};

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type CursorSettingsStorage = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  skipPermissions?: boolean;
};

type CodexSettingsStorage = {
  permissionMode?: CodexPermissionMode;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'appearance', 'git', 'api', 'tasks', 'browser', 'notifications', 'plugins', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

/** The settings this dialog auto-saves, as they were loaded or last saved. */
type SettingsSnapshot = {
  claudePermissions: ClaudePermissionsState;
  cursorPermissions: CursorPermissionsState;
  codexPermissionMode: CodexPermissionMode;
  projectSortOrder: ProjectSortOrder;
  notificationPreferences: NotificationPreferencesState;
};

/** Compares two snapshots by value; key order is fixed by SettingsSnapshot. */
const settingsSnapshotKey = (snapshot: SettingsSnapshot): string => JSON.stringify([
  snapshot.claudePermissions,
  snapshot.cursorPermissions,
  snapshot.codexPermissionMode,
  snapshot.projectSortOrder,
  snapshot.notificationPreferences,
]);

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);
  // See loadSettings and the auto-save effect.
  const isLoadingSettingsRef = useRef(false);
  const persistedSettingsKeyRef = useRef<string | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [cursorPermissions, setCursorPermissions] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('default');

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const loadSettings = useCallback(async () => {
    // No auto-save until everything has arrived: the notification preferences
    // come from the server after the rest, and a save in between wrote the
    // defaults over them.
    isLoadingSettingsRef.current = true;
    const loaded: SettingsSnapshot = {
      claudePermissions: createEmptyClaudePermissions(),
      cursorPermissions: createEmptyCursorPermissions(),
      codexPermissionMode: 'default',
      projectSortOrder: 'name',
      notificationPreferences: createDefaultNotificationPreferences(),
    };
    try {
      const savedClaudeSettings = readUserPreference<ClaudeSettingsStorage>('claudePermissions', {});
      loaded.claudePermissions = {
        allowedTools: savedClaudeSettings.allowedTools || [],
        disallowedTools: savedClaudeSettings.disallowedTools || [],
        skipPermissions: Boolean(savedClaudeSettings.skipPermissions),
      };
      loaded.projectSortOrder = readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name';

      const savedCursorSettings = readUserPreference<CursorSettingsStorage>('cursorPermissions', {});
      loaded.cursorPermissions = {
        allowedCommands: savedCursorSettings.allowedCommands || [],
        disallowedCommands: savedCursorSettings.disallowedCommands || [],
        skipPermissions: Boolean(savedCursorSettings.skipPermissions),
      };

      const savedCodexSettings = readUserPreference<CodexSettingsStorage>('codexPermissions', {});
      loaded.codexPermissionMode = toCodexPermissionMode(savedCodexSettings.permissionMode);

      try {
        const notificationResponse = await api.settings.notificationPreferences();
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            loaded.notificationPreferences = normalizeNotificationPreferences(notificationData.preferences);
          }
        }
      } catch {
        // Defaults stand in.
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }

    setClaudePermissions(loaded.claudePermissions);
    setCursorPermissions(loaded.cursorPermissions);
    setCodexPermissionMode(loaded.codexPermissionMode);
    setProjectSortOrder(loaded.projectSortOrder);
    setNotificationPreferences(loaded.notificationPreferences);
    // What is on the server now: only a change from this is worth saving.
    persistedSettingsKeyRef.current = settingsSnapshotKey(loaded);
    isLoadingSettingsRef.current = false;
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      // One call so the whole dialog's state reaches the server as a single
      // merge-patch rather than four racing requests.
      writeUserPreferences({
        claudePermissions: {
          allowedTools: claudePermissions.allowedTools,
          disallowedTools: claudePermissions.disallowedTools,
          skipPermissions: claudePermissions.skipPermissions,
        },
        projectSortOrder,
        cursorPermissions: {
          allowedCommands: cursorPermissions.allowedCommands,
          disallowedCommands: cursorPermissions.disallowedCommands,
          skipPermissions: cursorPermissions.skipPermissions,
        },
        codexPermissions: {
          permissionMode: codexPermissionMode,
        },
      });

      const notificationResponse = await api.settings.saveNotificationPreferences(
        notificationPreferences,
      );
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    claudePermissions.allowedTools,
    claudePermissions.disallowedTools,
    claudePermissions.skipPermissions,
    codexPermissionMode,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    notificationPreferences,
    projectSortOrder,
  ]);

  // Persist on the user's edit rather than in an effect keyed on the settings
  // object. The effect form also ran on mount, so merely opening this dialog
  // rewrote all four keys — which reset the editor's font size for anyone who
  // had never changed it.
  //
  // The other three keys are merged from storage rather than from the rendered
  // state, so two edits landing in one React batch cannot write the second one
  // on top of a pre-first-edit snapshot. Storage is the newest value because
  // this is the only writer that can be behind — the editor's own wordWrap
  // mirror in useCodeEditorSettings only ever writes back what it just read.
  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      const next = { ...readCodeEditorSettings(), [key]: value };
      setCodeEditorSettings(next);
      writeCodeEditorSettings(next);
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  // Auto-save permissions, sort order and notifications with debounce, but
  // only an actual edit: opening the dialog used to save (and announce
  // "Settings saved") as its stored values arrived.
  const autoSaveTimerRef = useRef<number | null>(null);
  const settingsKey = settingsSnapshotKey({
    claudePermissions,
    cursorPermissions,
    codexPermissionMode,
    projectSortOrder,
    notificationPreferences,
  });

  useEffect(() => {
    // Nothing to compare against until the stored settings have loaded once.
    if (
      isLoadingSettingsRef.current
      || persistedSettingsKeyRef.current === null
      || settingsKey === persistedSettingsKeyRef.current
    ) {
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      persistedSettingsKeyRef.current = settingsKey;
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings, settingsKey]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    cursorPermissions,
    setCursorPermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
