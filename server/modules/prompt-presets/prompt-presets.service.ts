import type { PromptPresetChanges, PromptPresetRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** A saved prompt as the client receives it; mirrors `PromptPreset` in src/shared/types.ts. */
type PromptPreset = {
  id: string;
  projectId: string | null;
  title: string;
  content: string;
  global: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

type PromptPresetsDependencies = {
  presets: {
    listForProject(userId: number, projectId: string): PromptPresetRow[];
    getById(userId: number, id: string): PromptPresetRow | null;
    create(
      input: { userId: number; projectId: string | null; title: string; content: string },
      maxPerUser: number,
      now: Date,
    ): PromptPresetRow | null;
    update(userId: number, id: string, changes: PromptPresetChanges, now: Date): PromptPresetRow | null;
    markUsed(userId: number, id: string, now: Date): PromptPresetRow | null;
    delete(userId: number, id: string): boolean;
  };
  /** Whether a `projects` row with this id exists; presets may only be tied to a known project. */
  projectExists(projectId: string): boolean;
  now(): Date;
};

/** Input for creating a preset, with transport types already checked by the route. */
type CreatePromptPresetInput = {
  projectId?: string;
  title: string;
  content: string;
  global: boolean;
};

/** Requested changes for a preset, with transport types already checked by the route. */
type UpdatePromptPresetInput = {
  title?: string;
  content?: string;
  global?: boolean;
  projectId?: string;
};

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 100_000;
const MAX_PROJECT_ID_LENGTH = 200;
/** Far more than anyone curates by hand; stops a runaway client from filling the table. */
const MAX_PRESETS_PER_USER = 500;

function toPromptPreset(row: PromptPresetRow): PromptPreset {
  return {
    id: String(row.id),
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    global: row.project_id === null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function readTitle(value: string): string {
  const title = value.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new AppError(`A title of 1-${MAX_TITLE_LENGTH} characters is required`, {
      code: 'INVALID_PRESET_TITLE',
      statusCode: 400,
    });
  }
  return title;
}

/** Content is stored exactly as typed; only an all-whitespace prompt is refused. */
function readContent(value: string): string {
  if (!value.trim()) {
    throw new AppError('Preset content cannot be empty', {
      code: 'INVALID_PRESET_CONTENT',
      statusCode: 400,
    });
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new AppError(`Preset content must be at most ${MAX_CONTENT_LENGTH} characters`, {
      code: 'PRESET_CONTENT_TOO_LONG',
      statusCode: 413,
    });
  }
  return value;
}

function readProjectId(value: string | undefined): string {
  const projectId = typeof value === 'string' ? value.trim() : '';
  if (!projectId || projectId.length > MAX_PROJECT_ID_LENGTH) {
    throw new AppError(`A projectId of 1-${MAX_PROJECT_ID_LENGTH} characters is required`, {
      code: 'INVALID_PROJECT_ID',
      statusCode: 400,
    });
  }
  return projectId;
}

function presetNotFound(): AppError {
  return new AppError('Prompt preset not found', {
    code: 'PROMPT_PRESET_NOT_FOUND',
    statusCode: 404,
  });
}

/**
 * Creates the per-user prompt preset workflows over explicit repository,
 * project-lookup and clock adapters. Used by this module's wiring
 * (`prompt-presets.module.ts`) to back the routes, and by its tests with a
 * controllable clock.
 */
export function createPromptPresetsService(dependencies: PromptPresetsDependencies) {
  /** A project id that is well formed and names an existing project. */
  const readKnownProjectId = (value: string | undefined): string => {
    const projectId = readProjectId(value);
    if (!dependencies.projectExists(projectId)) {
      throw new AppError(`Unknown projectId: ${projectId}`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }
    return projectId;
  };

  return {
    /** The user's presets for the project plus their global ones, most recently used first. */
    list(userId: number, projectId: string | undefined): PromptPreset[] {
      return dependencies.presets.listForProject(userId, readProjectId(projectId)).map(toPromptPreset);
    },

    create(userId: number, input: CreatePromptPresetInput): PromptPreset {
      const title = readTitle(input.title);
      const content = readContent(input.content);
      // A global preset ignores any projectId the client also sent.
      const projectId = input.global ? null : readKnownProjectId(input.projectId);
      const row = dependencies.presets.create(
        { userId, projectId, title, content },
        MAX_PRESETS_PER_USER,
        dependencies.now(),
      );
      if (!row) {
        throw new AppError(`You can keep at most ${MAX_PRESETS_PER_USER} prompt presets`, {
          code: 'TOO_MANY_PROMPT_PRESETS',
          statusCode: 413,
        });
      }
      return toPromptPreset(row);
    },

    /**
     * Applies a partial edit. Scope rules: `global: true` makes the preset
     * global; `global: false` scopes it to `projectId`, which is required when
     * the preset is currently global and optional (kept) when it already has a
     * project; `projectId` alone moves a project preset and is ignored for a
     * global one, which needs `global: false` to be scoped.
     */
    update(userId: number, id: string, input: UpdatePromptPresetInput): PromptPreset {
      if (input.title === undefined && input.content === undefined
        && input.global === undefined && input.projectId === undefined) {
        throw new AppError('Nothing to update: send title, content, global or projectId', {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const existing = dependencies.presets.getById(userId, id);
      if (!existing) {
        throw presetNotFound();
      }

      const changes: PromptPresetChanges = {};
      if (input.title !== undefined) {
        changes.title = readTitle(input.title);
      }
      if (input.content !== undefined) {
        changes.content = readContent(input.content);
      }
      if (input.global === true) {
        changes.projectId = null;
      } else if (input.projectId !== undefined && (input.global === false || existing.project_id !== null)) {
        changes.projectId = readKnownProjectId(input.projectId);
      } else if (input.global === false && existing.project_id === null) {
        throw new AppError('projectId is required to tie a global preset to a project', {
          code: 'INVALID_PROJECT_ID',
          statusCode: 400,
        });
      }

      const row = dependencies.presets.update(userId, id, changes, dependencies.now());
      if (!row) {
        throw presetNotFound();
      }
      return toPromptPreset(row);
    },

    remove(userId: number, id: string): void {
      if (!dependencies.presets.delete(userId, id)) {
        throw presetNotFound();
      }
    },

    /** Stamps `lastUsedAt` so the preset sorts first the next time the list is read. */
    markUsed(userId: number, id: string): PromptPreset {
      const row = dependencies.presets.markUsed(userId, id, dependencies.now());
      if (!row) {
        throw presetNotFound();
      }
      return toPromptPreset(row);
    },
  };
}
