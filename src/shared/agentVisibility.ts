import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

/**
 * Whether the agents other than Claude Code (Cursor, Codex, OpenCode) are
 * shown. This fork is for Claude Code: they stay in the code, so CloudCLI
 * updates merge cleanly, but are hidden unless turned on at the bottom of
 * Settings -> Agents. The server keeps the setting (it skips hidden agents
 * in its own work too); a copy in localStorage avoids a flash of them while
 * it loads.
 *
 * Used by the chat, settings, mcp, skills, onboarding, sidebar, command
 * palette and project-workspace modules wherever an agent can be seen or
 * chosen.
 */

const CACHE_KEY = 'cloudcli-show-other-agents';
const listeners = new Set<() => void>();

const readCache = (): boolean => {
  try {
    return localStorage.getItem(CACHE_KEY) === 'true';
  } catch {
    return false;
  }
};

let showOtherAgents = readCache();
let loadPromise: Promise<void> | null = null;
// Bumped by each save, so a load that started before it cannot undo it.
let saveCount = 0;

function publish(next: boolean): void {
  try {
    localStorage.setItem(CACHE_KEY, String(next));
  } catch {
    // Private mode: the server copy still applies on the next load.
  }
  if (next === showOtherAgents) return;
  showOtherAgents = next;
  for (const listener of listeners) listener();
}

/** Reads the server's value once per page load; later calls reuse it. */
export function loadAgentVisibility(): Promise<void> {
  loadPromise ??= (async () => {
    const savesBefore = saveCount;
    try {
      const response = await api.providers.visibility();
      const body = await response.json();
      if (typeof body?.data?.showOtherAgents === 'boolean' && saveCount === savesBefore) {
        publish(body.data.showOtherAgents);
      }
    } catch {
      // Offline: keep the cached value.
    }
  })();
  return loadPromise;
}

export async function saveShowOtherAgents(show: boolean): Promise<void> {
  saveCount += 1;
  const response = await api.providers.setVisibility(show);
  if (!response.ok) throw new Error(`Failed to save (${response.status})`);
  publish(show);
}

export function getShowOtherAgents(): boolean {
  return showOtherAgents;
}

/** Claude Code always; the others only while shown. */
export function isAgentVisible(provider: LLMProvider | string | null | undefined): boolean {
  return !provider || provider === 'claude' || showOtherAgents;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The setting, kept current; loads the server's value on first use. */
export function useShowOtherAgents(): boolean {
  useEffect(() => {
    void loadAgentVisibility();
  }, []);
  return useSyncExternalStore(subscribe, getShowOtherAgents, () => false);
}
