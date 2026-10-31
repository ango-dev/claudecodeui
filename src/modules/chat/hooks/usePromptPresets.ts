import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { api, readApiErrorMessage } from '@/shared/api';
import type { PromptPreset } from '@/shared/types';

/** What the editor hands back on save; `global` makes the preset show in every project. */
type PromptPresetDraft = Pick<PromptPreset, 'title' | 'content' | 'global'>;

// ─── In-memory cache, shared by every composer ──────────────────────────────
// Keyed by project id. Each list holds that project's presets plus the global
// ones, in the server's order (most recently used first). Reopening a project
// shows its cached list at once while a fresh one loads, and every mounted
// composer reads the same lists, so a change made in one shows in the others.

const presetCache = new Map<string, PromptPreset[]>();
const cacheListeners = new Set<() => void>();
const EMPTY_PRESETS: PromptPreset[] = [];

const subscribeToPresetCache = (listener: () => void) => {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
};

const publishPresetCache = () => {
  // A copy: a listener can re-render a composer that subscribes afresh, and a
  // Set visits entries added while it is being iterated, which never ends.
  for (const listener of [...cacheListeners]) listener();
};

/** Whether a preset belongs in the list shown for a project. */
const belongsToProject = (preset: PromptPreset, projectId: string) =>
  preset.global || preset.projectId === projectId;

type CachedPosition = { projectId: string; index: number; preset: PromptPreset };

/** Where a preset sits in every cached list, so a refused change can put it back exactly. */
const findCachedPositions = (id: string): CachedPosition[] => {
  const positions: CachedPosition[] = [];
  for (const [projectId, list] of presetCache) {
    const index = list.findIndex((preset) => preset.id === id);
    if (index >= 0) positions.push({ projectId, index, preset: list[index] });
  }
  return positions;
};

/**
 * Writes one preset's new state into every cached list: kept in place where it
 * already is, added where it now belongs (at the front, or at the index
 * `position` gives for that list), dropped where it no longer belongs. `next`
 * null removes it everywhere. Toggling "all projects" therefore adds it to, or
 * takes it out of, the other projects' lists too.
 */
const writePresetToCache = (
  id: string,
  next: PromptPreset | null,
  options: { moveToFront?: boolean; position?: Map<string, number> } = {},
) => {
  for (const [projectId, list] of presetCache) {
    const index = list.findIndex((preset) => preset.id === id);
    const rest = index >= 0 ? list.filter((_, current) => current !== index) : list;
    if (!next || !belongsToProject(next, projectId)) {
      if (index >= 0) presetCache.set(projectId, rest);
      continue;
    }
    const target = options.moveToFront ? 0 : options.position?.get(projectId) ?? Math.max(0, index);
    const clamped = Math.min(target, rest.length);
    presetCache.set(projectId, [...rest.slice(0, clamped), next, ...rest.slice(clamped)]);
  }
  publishPresetCache();
};

/** Puts a preset back where it was in every list before a change the server refused. */
const restoreCachedPositions = (id: string, positions: CachedPosition[]) => {
  for (const [projectId, list] of presetCache) {
    const withoutCurrent = list.filter((preset) => preset.id !== id);
    const previous = positions.find((position) => position.projectId === projectId);
    if (!previous) {
      if (withoutCurrent.length !== list.length) presetCache.set(projectId, withoutCurrent);
      continue;
    }
    const clamped = Math.min(previous.index, withoutCurrent.length);
    presetCache.set(projectId, [
      ...withoutCurrent.slice(0, clamped),
      previous.preset,
      ...withoutCurrent.slice(clamped),
    ]);
  }
  publishPresetCache();
};

/** Reads a `{ success, data }` envelope, throwing the server's message (or `fallback`) on failure. */
const readPresetEnvelope = async <T>(response: Response, fallback: string): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  const envelope = body as { success?: boolean; data?: T } | null;
  if (!response.ok || envelope?.success !== true || envelope.data === undefined) {
    throw new Error(readApiErrorMessage(body) ?? fallback);
  }
  return envelope.data;
};

const describeFailure = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/**
 * Reads a project's list into the cache, under that project even when the user
 * has moved on; resolves with the reason when the read failed, else null.
 */
const loadProjectPresets = async (projectId: string): Promise<string | null> => {
  try {
    const data = await readPresetEnvelope<{ presets: PromptPreset[] }>(
      await api.promptPresets.list(projectId),
      'Could not load the preset prompts.',
    );
    presetCache.set(projectId, Array.isArray(data.presets) ? data.presets : []);
    publishPresetCache();
    return null;
  } catch (failure) {
    return describeFailure(failure);
  }
};

// A preset shown before the server has saved it carries a placeholder id the
// server does not know, so changes to it wait until it is saved.
const OPTIMISTIC_ID_PREFIX = 'optimistic-';
const isUnsaved = (id: string) => id.startsWith(OPTIMISTIC_ID_PREFIX);
let optimisticIdCounter = 0;

/**
 * The saved prompts offered in a project's composer: that project's own and the
 * global ones, most recently used first.
 *
 * Every change shows at once and is undone if the server refuses it; the
 * refusal's message is kept in `error` for the menu to show. Used by chat's
 * PromptPresetMenu.
 */
export function usePromptPresets(projectId: string | null) {
  const presets = useSyncExternalStore(
    subscribeToPresetCache,
    () => (projectId ? presetCache.get(projectId) ?? EMPTY_PRESETS : EMPTY_PRESETS),
  );
  const hasCachedList = useSyncExternalStore(
    subscribeToPresetCache,
    () => Boolean(projectId && presetCache.has(projectId)),
  );
  // The last failure (a load, or a change the server refused), shown by the
  // menu until dismissed. Tagged with its project, so after a switch one
  // project's error never shows in another.
  const [lastFailure, setLastFailure] = useState<{ projectId: string | null; message: string } | null>(null);
  const error = lastFailure?.projectId === projectId ? lastFailure.message : null;
  const setError = useCallback((message: string) => setLastFailure({ projectId, message }), [projectId]);

  // Read again whenever the project changes; its cached list shows meanwhile.
  useEffect(() => {
    if (!projectId) return;
    void loadProjectPresets(projectId).then((message) => {
      if (message) setError(message);
    });
  }, [projectId, setError]);

  const createPreset = useCallback(async (draft: PromptPresetDraft): Promise<PromptPreset | null> => {
    if (!projectId) return null;
    const now = new Date().toISOString();
    optimisticIdCounter += 1;
    const placeholder: PromptPreset = {
      id: `${OPTIMISTIC_ID_PREFIX}${optimisticIdCounter}`,
      projectId: draft.global ? null : projectId,
      ...draft,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    };
    if (!presetCache.has(projectId)) presetCache.set(projectId, []);
    writePresetToCache(placeholder.id, placeholder, { moveToFront: true });
    try {
      const { preset } = await readPresetEnvelope<{ preset: PromptPreset }>(
        await api.promptPresets.create({ projectId, ...draft }),
        'Could not save the preset.',
      );
      // The saved preset takes the placeholder's place in each list.
      const position = new Map(findCachedPositions(placeholder.id).map((at) => [at.projectId, at.index]));
      writePresetToCache(placeholder.id, null);
      writePresetToCache(preset.id, preset, { position });
      return preset;
    } catch (failure) {
      writePresetToCache(placeholder.id, null);
      setError(describeFailure(failure));
      return null;
    }
  }, [projectId, setError]);

  const updatePreset = useCallback(async (id: string, draft: PromptPresetDraft): Promise<PromptPreset | null> => {
    const before = findCachedPositions(id);
    const current = before[0]?.preset;
    if (!current || !projectId || isUnsaved(id)) return null;
    // A preset taken out of "all projects" stays with the project it is edited in.
    const projectChange = current.global && !draft.global ? { projectId } : {};
    writePresetToCache(id, { ...current, ...draft, ...projectChange, updatedAt: new Date().toISOString() });
    try {
      const { preset } = await readPresetEnvelope<{ preset: PromptPreset }>(
        await api.promptPresets.update(id, { ...draft, ...projectChange }),
        'Could not save the preset.',
      );
      writePresetToCache(id, preset);
      return preset;
    } catch (failure) {
      restoreCachedPositions(id, before);
      setError(describeFailure(failure));
      return null;
    }
  }, [projectId, setError]);

  const removePreset = useCallback(async (id: string): Promise<boolean> => {
    if (isUnsaved(id)) return false;
    const before = findCachedPositions(id);
    writePresetToCache(id, null);
    try {
      await readPresetEnvelope<{ deleted: true }>(await api.promptPresets.remove(id), 'Could not delete the preset.');
      return true;
    } catch (failure) {
      restoreCachedPositions(id, before);
      setError(describeFailure(failure));
      return false;
    }
  }, [setError]);

  // Bookkeeping for the "most recently used first" order. A failure is undone
  // quietly: the user picked a preset, not a change they would expect to fail.
  const markPresetUsed = useCallback(async (id: string): Promise<void> => {
    const before = findCachedPositions(id);
    const current = before[0]?.preset;
    if (!current || isUnsaved(id)) return;
    writePresetToCache(id, { ...current, lastUsedAt: new Date().toISOString() }, { moveToFront: true });
    try {
      const { preset } = await readPresetEnvelope<{ preset: PromptPreset }>(
        await api.promptPresets.markUsed(id),
        'Could not record the preset as used.',
      );
      writePresetToCache(id, preset);
    } catch (failure) {
      restoreCachedPositions(id, before);
      console.warn('Failed to mark the preset prompt as used:', failure);
    }
  }, []);

  // Dismissing a failed first read tries it again, rather than leaving the
  // menu saying "Loading" with nothing on the way.
  const clearError = useCallback(() => {
    setLastFailure(null);
    if (!projectId || presetCache.has(projectId)) return;
    void loadProjectPresets(projectId).then((message) => {
      if (message) setError(message);
    });
  }, [projectId, setError]);

  return {
    presets,
    /** No list to show yet: the first read of this project has neither landed nor failed. */
    isLoading: Boolean(projectId) && !hasCachedList && error === null,
    error,
    clearError,
    createPreset,
    updatePreset,
    removePreset,
    markPresetUsed,
  };
}
