import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

/**
 * Opening Settings used to save straight away: the auto-save skipped only the
 * first change after opening, but loading changes the state twice (the stored
 * preferences, then the notification preferences from the server), so the
 * second one saved and announced "Settings saved". With a slow server it saved
 * before the notification preferences arrived, writing the defaults over them.
 */

const saveCalls: unknown[] = [];

vi.mock('@/shared/api', () => {
  const ok = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  return {
    api: {
      settings: {
        // Slower than the 500ms auto-save debounce.
        notificationPreferences: () => new Promise((resolve) => setTimeout(() => resolve({
          ok: true,
          json: async () => ({
            success: true,
            preferences: { channels: { inApp: true, webPush: true, sound: false }, events: { actionRequired: true, stop: false, error: true } },
          }),
        }), 700)),
        saveNotificationPreferences: (preferences: unknown) => {
          saveCalls.push(preferences);
          return Promise.resolve({ ok: true, json: async () => ({}) });
        },
      },
      user: {
        preferences: async () => new Response(JSON.stringify({ preferences: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        savePreferences: ok,
        drafts: ok,
        saveDraft: ok,
        deleteDraft: ok,
      },
    },
  };
});

vi.mock('@/shared/context/ThemeContext', () => {
  const theme = { isDarkMode: false, toggleDarkMode: () => undefined };
  return { useTheme: () => theme };
});

vi.mock('@/modules/provider-auth', () => {
  const authStatus = {
    providerAuthStatus: {},
    checkProviderAuthStatus: () => Promise.resolve({ authenticated: false }),
    refreshProviderAuthStatuses: () => Promise.resolve(),
  };
  return { useProviderAuthStatus: () => authStatus };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  saveCalls.length = 0;
});

test('opening settings saves nothing, and an edit saves once', async () => {
  const { useSettingsController } = await import('@/modules/settings/hooks/useSettingsController');
  const { result } = renderHook(() => useSettingsController({ isOpen: true, initialTab: 'appearance' }));

  await waitFor(() => assert.equal(result.current.notificationPreferences.channels.webPush, true), { timeout: 2000 });
  await act(async () => { await sleep(800); });
  assert.equal(saveCalls.length, 0, 'opening the dialog must not save');
  assert.equal(result.current.saveStatus, null);

  act(() => { result.current.setProjectSortOrder('date'); });
  await waitFor(() => assert.equal(saveCalls.length, 1), { timeout: 2000 });
  // The loaded notification preferences, not the defaults, go back up.
  assert.equal((saveCalls[0] as { channels: { webPush: boolean } }).channels.webPush, true);
});
