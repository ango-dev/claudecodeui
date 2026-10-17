import assert from 'node:assert/strict';
import test from 'node:test';

import { createUserService } from '../user.service.js';

type UserDependencies = Parameters<typeof createUserService>[0];

function createDependencies(overrides: Partial<UserDependencies> = {}): UserDependencies {
  return {
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: () => undefined,
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    preferences: {
      getPreferences: () => ({}),
      savePreferences: () => undefined,
    },
    drafts: {
      getDrafts: () => [],
      saveDraft: () => undefined,
      appendQueuedMessage: () => true,
      removeQueuedMessage: () => undefined,
      deleteDraft: () => undefined,
    },
    readSystemGitConfig: async () => ({ git_name: null, git_email: null }),
    applyGlobalGitConfig: async () => undefined,
    logInfo: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
}

test('getGitConfig imports system configuration when the repository is empty', async () => {
  const updates: unknown[][] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (...args) => updates.push(args),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    readSystemGitConfig: async () => ({ git_name: 'Alice', git_email: 'alice@example.com' }),
  }));

  const result = await service.getGitConfig(7);

  assert.equal(result.gitName, 'Alice');
  assert.deepEqual(updates, [[7, 'Alice', 'alice@example.com']]);
});

test('updateGitConfig persists valid input and invokes the Git adapter', async () => {
  const operations: string[] = [];
  const service = createUserService(createDependencies({
    users: {
      getGitConfig: () => undefined,
      updateGitConfig: (_id, name, email) => operations.push(`persist:${name}:${email}`),
      completeOnboarding: () => undefined,
      hasCompletedOnboarding: () => false,
    },
    applyGlobalGitConfig: async (name, email) => {
      operations.push(`git:${name}:${email}`);
    },
  }));

  await service.updateGitConfig(1, 'Alice', 'alice@example.com');
  assert.deepEqual(operations, [
    'persist:Alice:alice@example.com',
    'git:Alice:alice@example.com',
  ]);
});

test('savePreferences forwards only the keys the client sent', () => {
  const saved: Array<Record<string, unknown>> = [];
  const service = createUserService(createDependencies({
    preferences: {
      getPreferences: () => ({ theme: 'dark' }),
      savePreferences: (_id, updates) => saved.push(updates),
    },
  }));

  const result = service.savePreferences(3, { theme: 'light' });

  assert.deepEqual(saved, [{ theme: 'light' }]);
  assert.deepEqual(result.preferences, { theme: 'dark' });
});

test('savePreferences rejects a non-object body', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, ['theme']), /object/i);
  assert.throws(() => service.savePreferences(3, 'theme'), /object/i);
});

test('savePreferences rejects an over-long preference key', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.savePreferences(3, { ['k'.repeat(201)]: 1 }), /1-200/);
});

test('saveDraft stores the text and leaves the queue alone', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...createDependencies().drafts,
      saveDraft: (...args) => saved.push(args),
    },
  }));

  service.saveDraft(5, 'session-1', { scope: 'session-1', text: 'half a thought' });
  service.saveDraft(5, 'session-1', { scope: 'session-1' });

  assert.deepEqual(saved, [
    [5, 'session-1', { text: 'half a thought', queuedMessages: undefined }],
    [5, 'session-1', { text: '', queuedMessages: undefined }],
  ]);
});

test('saveDraft reads a single queuedMessage from an older client as a queue of one', () => {
  const saved: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...createDependencies().drafts,
      saveDraft: (...args) => saved.push(args),
    },
  }));

  service.saveDraft(5, 'session-1', { text: '', queuedMessage: { content: 'later' } });
  service.saveDraft(5, 'session-1', { text: '', queuedMessage: null });

  assert.deepEqual(saved, [
    [5, 'session-1', { text: '', queuedMessages: [{ content: 'later' }] }],
    [5, 'session-1', { text: '', queuedMessages: [] }],
  ]);
});

test('queueMessage appends the message with its id, options and attachments', () => {
  const appended: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: {
      ...createDependencies().drafts,
      appendQueuedMessage: (...args) => {
        appended.push(args);
        return true;
      },
    },
  }));

  service.queueMessage(5, 'session-1', { id: 'q1', content: 'next', options: { model: 'm' }, extra: 'dropped' });

  assert.deepEqual(appended, [[5, 'session-1', { id: 'q1', content: 'next', options: { model: 'm' }, attachments: [] }, 50]]);
});

test('queueMessage refuses a message without an id or anything to send, and a full queue', () => {
  const service = createUserService(createDependencies());
  assert.throws(() => service.queueMessage(5, 'session-1', { content: 'no id' }), /id/);
  assert.throws(() => service.queueMessage(5, 'session-1', { id: 'q1', content: '   ' }), /text or attachments/);

  const full = createUserService(createDependencies({
    drafts: { ...createDependencies().drafts, appendQueuedMessage: () => false },
  }));
  assert.throws(() => full.queueMessage(5, 'session-1', { id: 'q1', content: 'one more' }), /At most 50/);
});

test('unqueueMessage removes by id', () => {
  const removed: unknown[][] = [];
  const service = createUserService(createDependencies({
    drafts: { ...createDependencies().drafts, removeQueuedMessage: (...args) => removed.push(args) },
  }));

  service.unqueueMessage(5, 'session-1', 'q2');
  assert.deepEqual(removed, [[5, 'session-1', 'q2']]);
  assert.throws(() => service.unqueueMessage(5, 'session-1', ''), /id is required/);
});

test('saveDraft rejects a blank or over-long scope', () => {
  const service = createUserService(createDependencies());

  assert.throws(() => service.saveDraft(5, '   ', { text: 'x' }), /scope/i);
  assert.throws(() => service.saveDraft(5, 'x'.repeat(201), { text: 'x' }), /scope/i);
});

test('saveDraft rejects text past the storage limit', () => {
  const service = createUserService(createDependencies());

  assert.throws(
    () => service.saveDraft(5, 'session-1', { text: 'x'.repeat(100_001) }),
    /too long/i,
  );
});
