import { AppError, readQueuedChatMessage } from '@/shared/utils.js';

type GitConfig = {
  git_name: string | null;
  git_email: string | null;
};

/** One chat scope's unsent composer text and queued messages, oldest first. */
type DraftRecord = {
  scope: string;
  text: string;
  queuedMessages: unknown[];
  updatedAt: string;
};

type UserDependencies = {
  users: {
    getGitConfig(userId: number): GitConfig | undefined;
    updateGitConfig(userId: number, gitName: string | null, gitEmail: string | null): void;
    completeOnboarding(userId: number): void;
    hasCompletedOnboarding(userId: number): boolean;
  };
  preferences: {
    getPreferences(userId: number): Record<string, unknown>;
    savePreferences(userId: number, updates: Record<string, unknown>): void;
  };
  drafts: {
    getDrafts(userId: number): DraftRecord[];
    saveDraft(userId: number, scope: string, draft: { text: string; queuedMessages?: unknown[] }): void;
    appendQueuedMessage(userId: number, scope: string, message: Record<string, unknown>, maxLength: number): boolean;
    removeQueuedMessage(userId: number, scope: string, id: string): void;
    deleteDraft(userId: number, scope: string): void;
  };
  readSystemGitConfig(): Promise<GitConfig>;
  applyGlobalGitConfig(gitName: string, gitEmail: string): Promise<void>;
  logInfo(message: string): void;
  logError(message: string, error: unknown): void;
};

/**
 * The longest a draft scope or preference key may be.
 *
 * Scopes are session UUIDs or `project:<id>`, and preference keys are fixed
 * identifiers, so anything longer is a client bug or an attempt to use the
 * table as general storage.
 */
const MAX_KEY_LENGTH = 200;

/** Guards against a runaway composer filling the database with one row. */
const MAX_DRAFT_TEXT_LENGTH = 100_000;

const readDraftScope = (value: unknown): string => {
  const scope = typeof value === 'string' ? value.trim() : '';
  if (!scope || scope.length > MAX_KEY_LENGTH) {
    throw new AppError('A draft scope of 1-200 characters is required', {
      code: 'INVALID_DRAFT_SCOPE',
      statusCode: 400,
    });
  }
  return scope;
};

/** Keeps a forgotten queue from growing without end; far more than anyone queues by hand. */
const MAX_QUEUED_MESSAGES = 50;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

/**
 * A replacement queue in a draft save, or undefined to leave the queue alone.
 * Only a tab still running the client from before the queue took several
 * messages sends one: a single `queuedMessage` (or null), which reads as a
 * queue of one (or none). Current clients append and remove instead.
 */
const readLegacyQueue = (payload: Record<string, unknown>): unknown[] | undefined => {
  if (!('queuedMessage' in payload)) {
    return undefined;
  }
  return isRecord(payload.queuedMessage) ? [payload.queuedMessage] : [];
};

/** A queued message as a client sends it: an id it chose, plus text, send options and uploaded attachments. */
const readQueuedMessage = (value: unknown): Record<string, unknown> => {
  const message = isRecord(value) ? value : {};
  const id = typeof message.id === 'string' ? message.id.trim() : '';
  if (!id || id.length > MAX_KEY_LENGTH) {
    throw new AppError('A queued message needs an id of 1-200 characters', {
      code: 'INVALID_QUEUED_MESSAGE',
      statusCode: 400,
    });
  }
  // Read the way the dispatcher reads it to send it, so the queue only takes
  // a message the dispatcher will send rather than silently drop.
  const sendable = readQueuedChatMessage(message);
  if (!sendable) {
    throw new AppError('A queued message needs text or attachments', {
      code: 'INVALID_QUEUED_MESSAGE',
      statusCode: 400,
    });
  }
  if (sendable.content.length > MAX_DRAFT_TEXT_LENGTH) {
    throw new AppError('Queued message is too long to store', {
      code: 'DRAFT_TEXT_TOO_LONG',
      statusCode: 413,
    });
  }
  return {
    id,
    content: sendable.content,
    options: sendable.options ?? {},
    attachments: sendable.attachments,
  };
};

const readPreferenceUpdates = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Preferences must be sent as an object', {
      code: 'INVALID_PREFERENCES',
      statusCode: 400,
    });
  }

  const updates = body as Record<string, unknown>;
  for (const key of Object.keys(updates)) {
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new AppError('Preference keys must be 1-200 characters', {
        code: 'INVALID_PREFERENCE_KEY',
        statusCode: 400,
      });
    }
  }

  return updates;
};

/** Creates user-profile workflows with explicit repository and Git adapters. */
export function createUserService(dependencies: UserDependencies) {
  return {
    async getGitConfig(userId: number) {
      let gitConfig = dependencies.users.getGitConfig(userId);
      if (!gitConfig || (!gitConfig.git_name && !gitConfig.git_email)) {
        const systemConfig = await dependencies.readSystemGitConfig();
        if (systemConfig.git_name || systemConfig.git_email) {
          dependencies.users.updateGitConfig(
            userId,
            systemConfig.git_name,
            systemConfig.git_email,
          );
          gitConfig = systemConfig;
          dependencies.logInfo(`Auto-populated Git config for user ${userId}`);
        }
      }

      return {
        success: true,
        gitName: gitConfig?.git_name ?? null,
        gitEmail: gitConfig?.git_email ?? null,
      };
    },

    async updateGitConfig(userId: number, gitNameInput: unknown, gitEmailInput: unknown) {
      const gitName = typeof gitNameInput === 'string' ? gitNameInput.trim() : '';
      const gitEmail = typeof gitEmailInput === 'string' ? gitEmailInput.trim() : '';
      if (!gitName || !gitEmail) {
        throw new AppError('Git name and email are required', {
          code: 'GIT_CONFIG_REQUIRED',
          statusCode: 400,
        });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gitEmail)) {
        throw new AppError('Invalid email format', {
          code: 'INVALID_GIT_EMAIL',
          statusCode: 400,
        });
      }

      dependencies.users.updateGitConfig(userId, gitName, gitEmail);
      try {
        await dependencies.applyGlobalGitConfig(gitName, gitEmail);
      } catch (error) {
        // Persisted user settings remain authoritative even if the host Git
        // installation cannot be updated (matching the previous behavior).
        dependencies.logError('Failed to apply global Git config', error);
      }
      return { success: true, gitName, gitEmail };
    },

    completeOnboarding(userId: number) {
      dependencies.users.completeOnboarding(userId);
      return { success: true, message: 'Onboarding completed successfully' };
    },

    getOnboardingStatus(userId: number) {
      return {
        success: true,
        hasCompletedOnboarding: dependencies.users.hasCompletedOnboarding(userId),
      };
    },

    /** Every stored preference at once; the client fills gaps with its defaults. */
    getPreferences(userId: number) {
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    /**
     * Merge-patch: only the keys in the request body are touched, so two
     * independent settings screens can save concurrently without one erasing
     * the other's work.
     */
    savePreferences(userId: number, body: unknown) {
      const updates = readPreferenceUpdates(body);
      dependencies.preferences.savePreferences(userId, updates);
      return { success: true, preferences: dependencies.preferences.getPreferences(userId) };
    },

    getDrafts(userId: number) {
      return { success: true, drafts: dependencies.drafts.getDrafts(userId) };
    },

    saveDraft(userId: number, scopeInput: unknown, body: unknown) {
      const scope = readDraftScope(scopeInput);
      const payload = isRecord(body) ? body : {};
      const text = typeof payload.text === 'string' ? payload.text : '';

      if (text.length > MAX_DRAFT_TEXT_LENGTH) {
        throw new AppError('Draft text is too long to store', {
          code: 'DRAFT_TEXT_TOO_LONG',
          statusCode: 413,
        });
      }

      dependencies.drafts.saveDraft(userId, scope, {
        text,
        queuedMessages: readLegacyQueue(payload),
      });
      return { success: true };
    },

    /** Adds a message to the end of a session's queue; the server sends it when its turn comes. */
    queueMessage(userId: number, scopeInput: unknown, messageInput: unknown) {
      const scope = readDraftScope(scopeInput);
      const message = readQueuedMessage(messageInput);
      if (!dependencies.drafts.appendQueuedMessage(userId, scope, message, MAX_QUEUED_MESSAGES)) {
        throw new AppError(`At most ${MAX_QUEUED_MESSAGES} messages can be queued`, {
          code: 'TOO_MANY_QUEUED_MESSAGES',
          statusCode: 413,
        });
      }
      return { success: true };
    },

    /** Takes a message out of a session's queue; one already sent is gone, which is not an error. */
    unqueueMessage(userId: number, scopeInput: unknown, idInput: unknown) {
      const scope = readDraftScope(scopeInput);
      const id = typeof idInput === 'string' ? idInput : '';
      if (!id) {
        throw new AppError('A queued message id is required', {
          code: 'INVALID_QUEUED_MESSAGE',
          statusCode: 400,
        });
      }
      dependencies.drafts.removeQueuedMessage(userId, scope, id);
      return { success: true };
    },

    deleteDraft(userId: number, scopeInput: unknown) {
      dependencies.drafts.deleteDraft(userId, readDraftScope(scopeInput));
      return { success: true };
    },
  };
}
