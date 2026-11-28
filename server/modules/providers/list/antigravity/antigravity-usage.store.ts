/**
 * Last token usage agy reported per Antigravity session, in memory.
 *
 * agy reports context usage on the ACP stream only (`usage_update` with
 * `used`/`size`, and a per-prompt `usage` on the `session/prompt` result);
 * CloudCLI does not read agy's conversation files, so this is the only place
 * the token-usage endpoint can answer from. It is refilled by every turn and
 * every history load, and starts empty after a restart.
 */

type AntigravityUsage = {
  /** Tokens in the context window right now (`usage_update.used`). */
  used: number;
  /** The context window size (`usage_update.size`), 0 when unknown. */
  size: number;
  /** Input and output tokens of the last prompt (`session/prompt` result `usage`). */
  inputTokens: number;
  outputTokens: number;
};

const MAX_TRACKED_SESSIONS = 500;
const usageBySession = new Map<string, AntigravityUsage>();

function remember(providerSessionId: string, usage: AntigravityUsage): void {
  usageBySession.delete(providerSessionId);
  usageBySession.set(providerSessionId, usage);
  while (usageBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = usageBySession.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    usageBySession.delete(oldest);
  }
}

/**
 * Used by the Antigravity runtime (live turns), the Antigravity sessions
 * provider (history loads) and the providers module's token-usage service.
 */
export const antigravityUsageStore = {
  recordContext(providerSessionId: string, used: number, size: number): void {
    const previous = usageBySession.get(providerSessionId);
    remember(providerSessionId, {
      used,
      size: size || previous?.size || 0,
      inputTokens: previous?.inputTokens ?? 0,
      outputTokens: previous?.outputTokens ?? 0,
    });
  },

  recordPrompt(providerSessionId: string, inputTokens: number, outputTokens: number): void {
    const previous = usageBySession.get(providerSessionId);
    remember(providerSessionId, {
      used: previous?.used ?? 0,
      size: previous?.size ?? 0,
      inputTokens,
      outputTokens,
    });
  },

  read(providerSessionId: string): AntigravityUsage | null {
    return usageBySession.get(providerSessionId) ?? null;
  },
};
