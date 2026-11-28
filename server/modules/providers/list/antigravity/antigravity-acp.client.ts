/**
 * Agent Client Protocol client for `agy acp`.
 * =========================================
 *
 * Google Antigravity's CLI speaks the Agent Client Protocol (JSON-RPC 2.0,
 * one JSON message per line on stdio) when started as `agy acp`. This module
 * starts that process with the user's own environment, so agy uses the sign-in
 * the user made with it, and talks to it only through the protocol. It never
 * reads agy's data directory, its credentials or its conversation files, and
 * never contacts Google itself.
 *
 * Behaviour verified against agy 1.5.19:
 * - `initialize` answers in ~200 ms; nothing else is needed before sessions.
 * - Every session method answers `-32000 "Authentication required"` while agy
 *   is not signed in, which is how the auth facet tells signed-out from
 *   signed-in without touching any file.
 * - agy's own requests to the client (`session/request_permission`) use
 *   *string* ids (`"1"`), so ids are echoed back exactly as received.
 * - Closing stdin makes agy shut down cleanly within ~50 ms.
 *
 * One process serves one operation (a chat turn, a model lookup, a history
 * read): the handshake is cheap next to a model turn, and a process per turn
 * picks up MCP and settings changes the way a fresh `agy` in a terminal does.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';
import type {
  AnyRecord,
  AntigravityConfigOption,
  AntigravityConfigOptionValue,
  AntigravitySessionState,
} from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/** ACP protocol version this client implements (agy 1.5.19 answers 1). */
const ACP_PROTOCOL_VERSION = 1;

/** Default time a request may take; session methods that start agy's backend get longer. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** How long `close()` waits for agy to exit after stdin closes before signalling it. */
const DEFAULT_CLOSE_GRACE_MS = 3_000;

/** How long a SIGTERMed agy gets before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** JSON-RPC error code for a method the client does not implement. */
const METHOD_NOT_FOUND = -32601;

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type NotificationHandler = (method: string, params: unknown) => void;
type AgentRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/**
 * An error agy answered a request with, or a request that never got an answer
 * (timeout, process exit). Used by every Antigravity facet to tell
 * "not signed in" (`isAntigravityAuthRequiredError`) from real failures.
 */
export class AntigravityAcpError extends Error {
  readonly code: number | null;
  readonly method: string;
  readonly data: unknown;

  constructor(message: string, options: { code?: number | null; method: string; data?: unknown }) {
    super(message);
    this.name = 'AntigravityAcpError';
    this.code = options.code ?? null;
    this.method = options.method;
    this.data = options.data;
  }
}

/**
 * Whether `error` is agy's "not signed in" answer: JSON-RPC `-32000` with
 * "Authentication required", the ACP convention agy 1.5.19 follows for every
 * session method. Used by the auth, models, sessions and runtime facets.
 */
export function isAntigravityAuthRequiredError(error: unknown): boolean {
  return error instanceof AntigravityAcpError
    && error.code === -32000
    && /auth/i.test(error.message);
}

/** Connections still open, stopped by the exit hook when CloudCLI exits. */
const liveConnections = new Set<AntigravityAcpConnection>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const connection of liveConnections) {
      connection.killNow();
    }
  });
}

/**
 * One running `agy acp` process and its JSON-RPC session.
 *
 * Used by the Antigravity runtime (one per chat turn), and through
 * `withAntigravityAcp` by the auth, models, sessions and session-synchronizer
 * facets for one-shot operations.
 */
export class AntigravityAcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<(reason: string) => void>();
  private requestHandler: AgentRequestHandler | null = null;
  private nextRequestId = 1;
  private stderrTail = '';
  private exitReasonValue: string | null = null;
  private readonly exitedPromise: Promise<void>;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    let markExited!: () => void;
    this.exitedPromise = new Promise((resolve) => {
      markExited = resolve;
    });

    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', (line) => this.handleLine(line));

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      if (process.env.CLOUDCLI_ANTIGRAVITY_DEBUG === '1') {
        process.stderr.write(`[Antigravity:stderr] ${text}`);
      }
    });

    const fail = (reason: string) => {
      if (this.exitReasonValue !== null) {
        return;
      }
      this.exitReasonValue = reason;
      liveConnections.delete(this);
      reader.close();
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new AntigravityAcpError(`agy exited before answering "${request.method}" (${reason}).`, {
          method: request.method,
        }));
        this.pending.delete(id);
      }
      for (const handler of this.exitHandlers) {
        handler(reason);
      }
      markExited();
    };

    child.on('error', (error) => fail(error.message));
    child.on('exit', (code, signal) => fail(`code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    // A child that dies mid-write leaves a broken pipe that errors on the
    // stream rather than at the call site; unhandled, that would take the
    // whole server down.
    child.stdin.on('error', (error) => fail(error.message));
    child.stdout.on('error', (error) => fail(error.message));
    child.stderr.on('error', () => {});

    liveConnections.add(this);
    installExitHook();
  }

  /**
   * Starts `agy acp` in `cwd`. `extraArgs` go after `acp` (the runtime passes
   * `--dangerously-skip-permissions` there when the user chose to bypass
   * permissions). Throws when agy is not installed.
   */
  static start(options: { cwd: string; extraArgs?: string[]; env?: NodeJS.ProcessEnv }): AntigravityAcpConnection {
    const cli = resolveAntigravityCli(options.env ?? process.env);
    if (!cli) {
      throw new AntigravityAcpError('The Antigravity CLI (agy) is not installed.', { method: 'spawn', code: null });
    }
    const child = spawn(cli.command, ['acp', ...(options.extraArgs ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group on POSIX, so a stop also reaches the language
      // server and tool processes agy starts below itself.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    return new AntigravityAcpConnection(child);
  }

  /** Why the process ended, or null while it runs. */
  get exitReason(): string | null {
    return this.exitReasonValue;
  }

  /** The last few kilobytes agy wrote to stderr, for error messages. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Settles once the process has exited. */
  get exited(): Promise<void> {
    return this.exitedPromise;
  }

  /** Calls `handler` for every notification (`session/update`, ...). Returns the unsubscribe. */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** Calls `handler` once when the process exits or fails. Returns the unsubscribe. */
  onExit(handler: (reason: string) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /**
   * Answers agy's own requests (`session/request_permission`). Without a
   * handler, or for a method the handler throws `METHOD_NOT_FOUND` on, agy
   * gets JSON-RPC -32601: CloudCLI advertises no fs or terminal capability,
   * so agy uses its own file system and terminal.
   */
  setRequestHandler(handler: AgentRequestHandler | null): void {
    this.requestHandler = handler;
  }

  /** Sends a request and resolves its result. `timeoutMs: 0` waits forever. */
  request<T = unknown>(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.exitReasonValue !== null) {
        reject(new AntigravityAcpError(`agy is not running (${this.exitReasonValue}).`, { method }));
        return;
      }
      const id = this.nextRequestId++;
      const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new AntigravityAcpError(`agy did not answer "${method}" within ${timeoutMs} ms.`, { method }));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends a notification (`session/cancel`). */
  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * The ACP handshake. Advertises no client capabilities: agy reads and
   * writes files and runs commands itself, under its own permission rules.
   */
  initialize(): Promise<AnyRecord> {
    return this.request<AnyRecord>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: process.env.npm_package_version || '1' },
    }, { timeoutMs: 30_000 });
  }

  /**
   * Ends the process: closes stdin (agy then saves and exits by itself), and
   * signals its process group only if it is still up after `graceMs`.
   */
  async close(options: { graceMs?: number } = {}): Promise<void> {
    if (this.exitReasonValue !== null) {
      return;
    }
    try {
      this.child.stdin.end();
    } catch {
      // Already broken; the signals below still apply.
    }
    if (await this.waitForExit(options.graceMs ?? DEFAULT_CLOSE_GRACE_MS)) {
      return;
    }
    this.signal('SIGTERM');
    if (await this.waitForExit(KILL_GRACE_MS)) {
      return;
    }
    this.signal('SIGKILL');
    await this.waitForExit(KILL_GRACE_MS);
  }

  /** Kills the process at once (exit hook, synchronous). */
  killNow(): void {
    this.signal('SIGKILL');
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitReasonValue !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void this.exitedPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private signal(signal: NodeJS.Signals): void {
    const { pid } = this.child;
    if (!pid || this.exitReasonValue !== null) {
      return;
    }
    try {
      if (process.platform !== 'win32') {
        process.kill(-pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Gone already.
      }
    }
  }

  private write(message: AnyRecord): void {
    if (this.exitReasonValue !== null) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler fails whatever is pending.
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // A stray non-JSON line is not part of the protocol.
      return;
    }

    if (typeof message.method === 'string') {
      const hasId = message.id !== undefined && message.id !== null;
      if (hasId) {
        void this.answerAgentRequest(message.id as JsonRpcId, message.method, message.params);
        return;
      }
      for (const handler of this.notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch (error) {
          console.error('[Antigravity] Failed to handle a notification:', message.method, error);
        }
      }
      return;
    }

    if (message.id === undefined || message.id === null) {
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new AntigravityAcpError(message.error.message || `agy rejected "${request.method}".`, {
        code: typeof message.error.code === 'number' ? message.error.code : null,
        method: request.method,
        data: message.error.data,
      }));
      return;
    }
    request.resolve(message.result);
  }

  private async answerAgentRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.write({ jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: `CloudCLI does not implement ${method}.` } });
      return;
    }
    try {
      const result = await this.requestHandler(method, params);
      this.write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AntigravityAcpError && error.code !== null ? error.code : METHOD_NOT_FOUND;
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/**
 * Starts agy, runs the handshake, hands the connection to `run`, and always
 * closes it afterwards. Used by the auth, models, sessions and
 * session-synchronizer facets for their one-shot operations.
 */
export async function withAntigravityAcp<T>(
  options: { cwd: string },
  run: (connection: AntigravityAcpConnection, initializeResult: AnyRecord) => Promise<T>,
): Promise<T> {
  const connection = AntigravityAcpConnection.start({ cwd: options.cwd });
  try {
    const initializeResult = await connection.initialize();
    return await run(connection, initializeResult);
  } finally {
    await connection.close({ graceMs: 1_500 });
  }
}

/**
 * Flattens one ACP select option list, grouped (`{ group, name, options }`)
 * or not, into plain values.
 */
function readConfigOptionValues(value: unknown): AntigravityConfigOptionValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values: AntigravityConfigOptionValue[] = [];
  for (const entry of value) {
    const record = readObjectRecord(entry);
    if (!record) {
      continue;
    }
    if (Array.isArray(record.options)) {
      values.push(...readConfigOptionValues(record.options));
      continue;
    }
    const optionValue = readOptionalString(record.value);
    if (optionValue) {
      values.push({
        value: optionValue,
        name: readOptionalString(record.name) ?? optionValue,
        ...(readOptionalString(record.description) ? { description: readOptionalString(record.description) } : {}),
      });
    }
  }
  return values;
}

/**
 * Reads ACP `configOptions` (from a session result or a
 * `config_option_update`). Used by the runtime for live updates and by
 * `parseAntigravitySessionState`.
 */
export function parseAntigravityConfigOptions(value: unknown): AntigravityConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AntigravityConfigOption[] = [];
  for (const entry of value) {
    const record = readObjectRecord(entry);
    const id = readOptionalString(record?.id);
    if (!record || !id) {
      continue;
    }
    options.push({
      id,
      name: readOptionalString(record.name) ?? id,
      ...(readOptionalString(record.category) ? { category: readOptionalString(record.category) } : {}),
      type: readOptionalString(record.type) ?? 'select',
      currentValue: record.currentValue === undefined || record.currentValue === null ? '' : String(record.currentValue),
      options: readConfigOptionValues(record.options),
    });
  }
  return options;
}

/**
 * Normalizes a `session/new`, `session/load` or `session/resume` result. Used
 * by the models provider (catalog discovery) and the runtime (switching).
 */
export function parseAntigravitySessionState(result: unknown): AntigravitySessionState {
  const record = readObjectRecord(result) ?? {};
  const models = readObjectRecord(record.models) ?? {};
  const modes = readObjectRecord(record.modes) ?? {};
  const tier = readObjectRecord(readObjectRecord(readObjectRecord(record._meta)?.antigravity)?.tier);

  const availableModels = (Array.isArray(models.availableModels) ? models.availableModels : [])
    .map((entry: unknown) => readObjectRecord(entry))
    .filter((entry): entry is AnyRecord => Boolean(entry && readOptionalString(entry.modelId)))
    .map((entry) => ({
      modelId: String(entry.modelId),
      name: readOptionalString(entry.name) ?? String(entry.modelId),
      ...(readOptionalString(entry.description) ? { description: readOptionalString(entry.description) } : {}),
    }));

  const availableModes = (Array.isArray(modes.availableModes) ? modes.availableModes : [])
    .map((entry: unknown) => readObjectRecord(entry))
    .filter((entry): entry is AnyRecord => Boolean(entry && readOptionalString(entry.id)))
    .map((entry) => ({
      id: String(entry.id),
      name: readOptionalString(entry.name) ?? String(entry.id),
      ...(readOptionalString(entry.description) ? { description: readOptionalString(entry.description) } : {}),
    }));

  return {
    sessionId: readOptionalString(record.sessionId) ?? null,
    currentModelId: readOptionalString(models.currentModelId) ?? null,
    availableModels,
    currentModeId: readOptionalString(modes.currentModeId) ?? null,
    availableModes,
    configOptions: parseAntigravityConfigOptions(record.configOptions),
    tierName: readOptionalString(tier?.name) ?? null,
  };
}
