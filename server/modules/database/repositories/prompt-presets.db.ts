import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import type { PromptPresetChanges, PromptPresetRow } from '@/shared/types.js';

const COLUMNS = 'id, user_id, project_id, title, content, created_at, updated_at, last_used_at';

/**
 * Persistence for saved composer prompts. Every query is scoped by `user_id`,
 * so a preset id belonging to another user reads exactly like an unknown one.
 */
export const promptPresetsDb = {
  /**
   * The user's presets for one project plus their global ones: most recently
   * used first, never-used ones after, then by title ignoring case. The id is
   * the final tie-break so the order is stable between reads.
   */
  listForProject(userId: number, projectId: string): PromptPresetRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM prompt_presets
         WHERE user_id = ? AND (project_id = ? OR project_id IS NULL)
         ORDER BY last_used_at IS NULL, last_used_at DESC, title COLLATE NOCASE ASC, id ASC`
      )
      .all(userId, projectId) as PromptPresetRow[];
  },

  getById(userId: number, id: string): PromptPresetRow | null {
    const row = getConnection()
      .prepare(`SELECT ${COLUMNS} FROM prompt_presets WHERE id = ? AND user_id = ?`)
      .get(id, userId) as PromptPresetRow | undefined;
    return row ?? null;
  },

  /**
   * Inserts a preset unless the user already holds `maxPerUser`, in which case
   * nothing is written and null is returned. Counting and inserting share one
   * transaction so concurrent creates cannot overshoot the limit.
   */
  create(
    input: { userId: number; projectId: string | null; title: string; content: string },
    maxPerUser: number,
    now: Date,
  ): PromptPresetRow | null {
    const db = getConnection();
    return db.transaction(() => {
      const { total } = db
        .prepare('SELECT COUNT(*) AS total FROM prompt_presets WHERE user_id = ?')
        .get(input.userId) as { total: number };
      if (total >= maxPerUser) {
        return null;
      }
      const timestamp = now.toISOString();
      return db
        .prepare(
          `INSERT INTO prompt_presets (id, user_id, project_id, title, content, created_at, updated_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
           RETURNING ${COLUMNS}`
        )
        .get(randomUUID(), input.userId, input.projectId, input.title, input.content, timestamp, timestamp) as PromptPresetRow;
    })();
  },

  /**
   * Applies the given changes and bumps `updated_at`. Returns the updated row,
   * or null when the user has no preset with that id.
   */
  update(userId: number, id: string, changes: PromptPresetChanges, now: Date): PromptPresetRow | null {
    const assignments: string[] = ['updated_at = ?'];
    const values: unknown[] = [now.toISOString()];
    if (changes.title !== undefined) {
      assignments.push('title = ?');
      values.push(changes.title);
    }
    if (changes.content !== undefined) {
      assignments.push('content = ?');
      values.push(changes.content);
    }
    if (changes.projectId !== undefined) {
      assignments.push('project_id = ?');
      values.push(changes.projectId);
    }
    const row = getConnection()
      .prepare(
        `UPDATE prompt_presets SET ${assignments.join(', ')}
         WHERE id = ? AND user_id = ?
         RETURNING ${COLUMNS}`
      )
      .get(...values, id, userId) as PromptPresetRow | undefined;
    return row ?? null;
  },

  /** Records a use without touching `updated_at`. Null when the preset is not the user's. */
  markUsed(userId: number, id: string, now: Date): PromptPresetRow | null {
    const row = getConnection()
      .prepare(
        `UPDATE prompt_presets SET last_used_at = ?
         WHERE id = ? AND user_id = ?
         RETURNING ${COLUMNS}`
      )
      .get(now.toISOString(), id, userId) as PromptPresetRow | undefined;
    return row ?? null;
  },

  /** Returns false when the user had no preset with that id. */
  delete(userId: number, id: string): boolean {
    const result = getConnection()
      .prepare('DELETE FROM prompt_presets WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return result.changes > 0;
  },
};
