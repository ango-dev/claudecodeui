import { appConfigDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';

const SHOW_OTHER_AGENTS_KEY = 'show_other_agents';

/**
 * This fork is for Claude Code. The other agents (Cursor, Codex, OpenCode)
 * stay in the code, so CloudCLI updates still merge cleanly, but are hidden
 * unless turned on in Settings -> Agents. Hidden, they are left out wherever
 * CloudCLI acts on every agent by itself: MCP servers added to all agents
 * (Browser's included) and session discovery.
 *
 * Used by the providers module's MCP and session-synchronizer services and
 * routes; global, as background work has no user to ask.
 */
export const agentVisibilityService = {
  showOtherAgents(): boolean {
    return appConfigDb.get(SHOW_OTHER_AGENTS_KEY) === 'true';
  },

  isVisible(provider: LLMProvider): boolean {
    return provider === 'claude' || this.showOtherAgents();
  },

  /**
   * Turning the other agents on scans their sessions in full: while hidden
   * they were skipped, and the regular scan only looks at files changed
   * since the last one.
   */
  async setShowOtherAgents(show: boolean): Promise<boolean> {
    const wasShown = this.showOtherAgents();
    appConfigDb.set(SHOW_OTHER_AGENTS_KEY, show ? 'true' : 'false');
    if (show && !wasShown) {
      await Promise.allSettled(
        providerRegistry
          .listProviders()
          .filter((provider) => provider.id !== 'claude')
          .map((provider) => provider.sessionSynchronizer.synchronize()),
      );
    }
    return show;
  },
};
