import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    credentials: { list: () => [], create: () => ({}), remove: () => false, toggle: () => false },
    notifications: {
      getPreferences: () => undefined,
      updatePreferences: () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: () => undefined,
    },
    pushSubscriptions: { save: () => undefined, remove: () => undefined },
    getVapidPublicKey: () => null,
    preferences: { getPreferences: () => ({}) },
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: () => [{ id: 1, api_key: '1234567890-secret' }],
      create: () => ({}), remove: () => false, toggle: () => false,
    },
  }));
  assert.equal(service.listApiKeys(1).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: () => undefined,
    },
    notifications: {
      getPreferences: () => ({ channels: { webPush: false } }),
      updatePreferences: () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: () => { operations.push('notify'); },
    },
  }));

  service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});

test('"Show these sessions in VS Code" is off until the user stores true', () => {
  const stored: Record<number, Record<string, unknown>> = {
    1: {},
    2: { showSessionsInVsCode: true },
    3: { showSessionsInVsCode: 'true' },
    4: { showSessionsInVsCode: false },
  };
  const service = createSettingsService(dependencies({
    preferences: { getPreferences: (userId) => stored[userId] ?? {} },
  }));

  assert.equal(service.isVsCodeSessionListingEnabled(1), false);
  assert.equal(service.isVsCodeSessionListingEnabled(2), true);
  assert.equal(service.isVsCodeSessionListingEnabled(3), false);
  assert.equal(service.isVsCodeSessionListingEnabled(4), false);
  // Chat writers can carry the id as a string; a run with no user is always off.
  assert.equal(service.isVsCodeSessionListingEnabled('2'), true);
  assert.equal(service.isVsCodeSessionListingEnabled(null), false);
  assert.equal(service.isVsCodeSessionListingEnabled(undefined), false);
});
