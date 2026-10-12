import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo, Options, SlashCommand } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

/**
 * What Claude Code reports about itself when it starts: the models this
 * account and CLI version offer, and the slash commands it accepts.
 */
export type ClaudeCodeInitialization = {
  models: ModelInfo[];
  commands: SlashCommand[];
};

/** A successful reading is reused this long; models and commands change rarely. */
const CACHE_TTL_MS = 30 * 60_000;
/** After a failure (no CLI, no network) the fallback is used, and retried after this long. */
const FAILURE_RETRY_MS = 60_000;
/** A CLI that has not initialised by now is treated as unavailable. */
const INITIALIZE_TIMEOUT_MS = 30_000;

let cached: { value: ClaudeCodeInitialization | null; expiresAt: number } | null = null;
let inFlight: Promise<ClaudeCodeInitialization | null> | null = null;

/**
 * A prompt stream that never sends a message. Claude Code initialises and
 * answers control requests without one, so no turn runs and nothing is billed.
 */
function idlePrompt(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<never>>((resolve) => {
        signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
      }),
    }),
  };
}

async function readInitialization(): Promise<ClaudeCodeInitialization | null> {
  const abortController = new AbortController();
  const options: Options = {
    // A neutral folder, so project-specific commands do not leak into the
    // shared list; `persistSession: false` keeps it from writing a transcript,
    // which is why this lookup was once disabled.
    cwd: os.tmpdir(),
    persistSession: false,
    abortController,
    env: { ...process.env },
  };
  const executablePath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  if (executablePath) {
    options.pathToClaudeCodeExecutable = executablePath;
  }

  const timeout = setTimeout(() => abortController.abort(), INITIALIZE_TIMEOUT_MS);
  let handle: ReturnType<typeof query> | null = null;
  try {
    // Inside the try: `query` throws synchronously when it can find no Claude
    // Code executable at all, which is a normal "not installed" state here.
    handle = query({ prompt: idlePrompt(abortController.signal), options });
    const result = await handle.initializationResult();
    return { models: result.models ?? [], commands: result.commands ?? [] };
  } catch (error) {
    console.warn('[Claude] Could not read Claude Code models and commands:', error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
    abortController.abort();
    handle?.close();
  }
}

/**
 * Used by the Claude models provider and, through the providers barrel, the
 * Commands module: Claude Code's own model list and slash commands, read once
 * and cached. Resolves to null when Claude Code cannot be started, so callers
 * fall back to their static lists.
 */
export function loadClaudeCodeInitialization(): Promise<ClaudeCodeInitialization | null> {
  // Under `node --test` a route test must not start the real CLI; the static
  // lists stand in, as they do on a machine without Claude Code.
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.resolve(null);
  }
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.value);
  }
  // Settles to null rather than rejecting, and always clears `inFlight`: a
  // rejection kept here would be served to every caller until a restart.
  inFlight ??= readInitialization()
    .catch(() => null)
    .then((value) => {
      cached = { value, expiresAt: Date.now() + (value ? CACHE_TTL_MS : FAILURE_RETRY_MS) };
      inFlight = null;
      return value;
    });
  return inFlight;
}

/**
 * Used by the Commands module (through the providers barrel) to list the slash
 * commands Claude Code itself accepts, with their summaries; empty when Claude
 * Code cannot be started.
 */
export async function listClaudeCodeCommands(): Promise<SlashCommand[]> {
  return (await loadClaudeCodeInitialization())?.commands ?? [];
}
