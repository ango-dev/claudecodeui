import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionDraftsDb,
  userPreferencesDb,
} from '@/modules/database/index.js';

const USER_ID = 1;

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'user-prefs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  // Both tables cascade from users(id), so a row has to exist to write against.
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ID, 'tester', 'hash');

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('preferences round-trip every JSON shape a setting can take', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });
  });
});

test('saving preferences merge-patches instead of replacing the whole set', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { theme: 'light' });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), {
      theme: 'light',
      userLanguage: 'de',
    });
  });
});

test('a preference set to undefined is removed', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    userPreferencesDb.savePreferences(USER_ID, { userLanguage: undefined });

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('one unreadable preference value does not cost the user the others', async () => {
  await withDatabase(() => {
    userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    getConnection()
      .prepare(
        `INSERT INTO user_preferences (user_id, preference_key, preference_value)
         VALUES (?, ?, ?)`
      )
      .run(USER_ID, 'broken', 'not json');

    assert.deepEqual(userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('drafts round-trip text and queued messages per scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'half typed', queuedMessages: [] });
    sessionDraftsDb.saveDraft(USER_ID, 'project:p1', {
      text: '',
      queuedMessages: [{ content: 'run it' }, { content: 'then this' }],
    });

    const drafts = sessionDraftsDb.getDrafts(USER_ID);
    const byScope = new Map(drafts.map((draft) => [draft.scope, draft]));

    assert.equal(byScope.get('session-a')?.text, 'half typed');
    assert.deepEqual(byScope.get('session-a')?.queuedMessages, []);
    assert.equal(byScope.get('project:p1')?.text, '');
    assert.deepEqual(byScope.get('project:p1')?.queuedMessages.map((message) => (message as { content: string }).content), ['run it', 'then this']);
  });
});

test('a single queued message stored before the queue took several reads as a queue of one', async () => {
  await withDatabase(() => {
    getConnection()
      .prepare(`INSERT INTO session_drafts (user_id, draft_scope, draft_text, queued_message) VALUES (?, ?, '', ?)`)
      .run(USER_ID, 'session-old', JSON.stringify({ content: 'from before' }));

    const [legacy] = sessionDraftsDb.getDrafts(USER_ID)[0]!.queuedMessages as Array<{ id: string; content: string }>;
    assert.equal(legacy?.content, 'from before');
    assert.match(legacy?.id ?? '', /^legacy-/, 'given a stable id so it can be removed');

    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-old', legacy!.id);
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('queued messages are appended and removed one at a time, and a text save leaves them alone', async () => {
  await withDatabase(() => {
    assert.equal(sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'q1', content: 'one' }, 3), true);
    assert.equal(sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'q2', content: 'two' }, 3), true);
    assert.equal(sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'q2', content: 'two' }, 3), true, 'a retry is harmless');
    assert.equal(sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'q3', content: 'three' }, 3), true);
    assert.equal(sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'q4', content: 'four' }, 3), false, 'the queue is full');

    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typing' });
    const ids = () => sessionDraftsDb.getDrafts(USER_ID)[0]?.queuedMessages.map((message) => (message as { id: string }).id);
    assert.deepEqual(ids(), ['q1', 'q2', 'q3']);

    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-a', 'q2');
    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-a', 'gone');
    assert.deepEqual(ids(), ['q1', 'q3']);

    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-a', 'q1');
    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-a', 'q3');
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '' });
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), [], 'nothing left, so no row');
  });
});

test('saving an empty draft deletes the row rather than keeping a blank one', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typed', queuedMessages: [] });
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessages: [] });

    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('deleteDraft removes only the named scope', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'a', queuedMessages: [] });
    sessionDraftsDb.saveDraft(USER_ID, 'session-b', { text: 'b', queuedMessages: [] });

    sessionDraftsDb.deleteDraft(USER_ID, 'session-a');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(USER_ID).map((draft) => draft.scope),
      ['session-b'],
    );
  });
});

const queuedIdsIn = (scope: string) => (
  sessionDraftsDb.getDrafts(USER_ID)
    .find((draft) => draft.scope === scope)
    ?.queuedMessages.map((message) => (message as { id: string }).id) ?? null
);

test('removing the last queued message keeps the draft text, and drops an emptied row', async () => {
  await withDatabase(() => {
    sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'keep me' });
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'qa', content: 'A', attachments: [] }, 50);
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-b', { id: 'qb', content: 'B', attachments: [] }, 50);

    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-a', 'qa');
    sessionDraftsDb.removeQueuedMessage(USER_ID, 'session-b', 'qb');

    assert.deepEqual(
      sessionDraftsDb.getDrafts(USER_ID).map((draft) => [draft.scope, draft.text, draft.queuedMessages]),
      [['session-a', 'keep me', []]],
    );
  });
});

test('a turn restored after its emptied row was removed is written back', async () => {
  await withDatabase(() => {
    // listQueuedMessages only lists real chat sessions, so the dispatcher's
    // candidate is built here the way it lists one.
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'qa', content: 'A', attachments: [] }, 50);
    const row = getConnection()
      .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
      .get(USER_ID, 'session-a') as { queued_message: string };
    const claimed = sessionDraftsDb.claimQueuedMessages({
      userId: USER_ID,
      sessionId: 'session-a',
      queuedMessages: sessionDraftsDb.getDrafts(USER_ID)[0]!.queuedMessages,
      claimToken: row.queued_message,
    }, 1);
    assert.notEqual(claimed, null);
    sessionDraftsDb.deleteEmptyDraft(USER_ID, 'session-a');
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);

    sessionDraftsDb.restoreQueuedMessages(USER_ID, 'session-a', claimed!);

    assert.deepEqual(queuedIdsIn('session-a'), ['qa']);
  });
});

/** The dispatcher's candidate for a scope, built the way listQueuedMessages lists one. */
function queuedCandidate(scope: string) {
  const row = getConnection()
    .prepare('SELECT queued_message FROM session_drafts WHERE user_id = ? AND draft_scope = ?')
    .get(USER_ID, scope) as { queued_message: string };
  return {
    userId: USER_ID,
    sessionId: scope,
    queuedMessages: sessionDraftsDb.getDrafts(USER_ID).find((draft) => draft.scope === scope)!.queuedMessages,
    claimToken: row.queued_message,
  };
}

test('several queued turns are claimed together, and restored together in front of later ones', async () => {
  await withDatabase(() => {
    for (const id of ['qa', 'qb', 'qc']) {
      sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id, content: id, attachments: [] }, 50);
    }
    const candidate = queuedCandidate('session-a');

    // More than the queue holds, or none, takes nothing.
    assert.equal(sessionDraftsDb.claimQueuedMessages(candidate, 4), null);
    assert.equal(sessionDraftsDb.claimQueuedMessages(candidate, 0), null);
    assert.deepEqual(queuedIdsIn('session-a'), ['qa', 'qb', 'qc']);

    const claimed = sessionDraftsDb.claimQueuedMessages(candidate, 2);
    assert.deepEqual(claimed!.map((message) => (message as { id: string }).id), ['qa', 'qb']);
    assert.deepEqual(queuedIdsIn('session-a'), ['qc']);
    // The same listing cannot be claimed from twice.
    assert.equal(sessionDraftsDb.claimQueuedMessages(candidate, 1), null);

    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'qd', content: 'qd', attachments: [] }, 50);
    sessionDraftsDb.restoreQueuedMessages(USER_ID, 'session-a', claimed!);
    assert.deepEqual(queuedIdsIn('session-a'), ['qa', 'qb', 'qc', 'qd']);
  });
});

test('claiming the whole queue empties it', async () => {
  await withDatabase(() => {
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'qa', content: 'A', attachments: [] }, 50);
    sessionDraftsDb.appendQueuedMessage(USER_ID, 'session-a', { id: 'qb', content: 'B', attachments: [] }, 50);

    assert.equal(sessionDraftsDb.claimQueuedMessages(queuedCandidate('session-a'), 2)?.length, 2);
    sessionDraftsDb.deleteEmptyDraft(USER_ID, 'session-a');
    assert.deepEqual(sessionDraftsDb.getDrafts(USER_ID), []);
  });
});
