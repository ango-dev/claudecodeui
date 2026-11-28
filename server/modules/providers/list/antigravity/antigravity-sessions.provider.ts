import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  isAntigravityAuthRequiredError,
  withAntigravityAcp,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';
import { antigravityUsageStore } from '@/modules/providers/list/antigravity/antigravity-usage.store.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  errorMessage,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity';

/** How long a loaded history is served from memory before agy is asked again. */
const HISTORY_CACHE_TTL_MS = 60_000;

/** How long `session/load` may take to replay a long conversation. */
const HISTORY_LOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/** What is known about one ACP tool call, merged from `tool_call` and its `tool_call_update`s. */
type ToolCallState = {
  toolCallId: string;
  /** agy's own tool name (`run_command`), a non-standard field agy 1.5.19 sends. */
  name?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: AnyRecord;
  rawOutput?: unknown;
  content: AnyRecord[];
  locations: AnyRecord[];
};

function mergeToolCall(previous: ToolCallState | undefined, update: AnyRecord): ToolCallState | null {
  const toolCallId = readOptionalString(update.toolCallId);
  if (!toolCallId) {
    return null;
  }
  const rawInput = readObjectRecord(update.rawInput) ?? readObjectRecord(update.args);
  return {
    toolCallId,
    name: readOptionalString(update.name) ?? previous?.name,
    kind: readOptionalString(update.kind) ?? previous?.kind,
    title: readOptionalString(update.title) ?? previous?.title,
    status: readOptionalString(update.status) ?? previous?.status,
    rawInput: rawInput ?? previous?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : previous?.rawOutput,
    content: Array.isArray(update.content)
      ? update.content.map((entry: unknown) => readObjectRecord(entry)).filter(Boolean) as AnyRecord[]
      : previous?.content ?? [],
    locations: Array.isArray(update.locations)
      ? update.locations.map((entry: unknown) => readObjectRecord(entry)).filter(Boolean) as AnyRecord[]
      : previous?.locations ?? [],
  };
}

/** The first string among `keys` in `input`, matched case-insensitively. */
function pickString(input: AnyRecord | undefined, ...keys: string[]): string | undefined {
  if (!input) {
    return undefined;
  }
  const lowerCased = new Map(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowerCased.get(key.toLowerCase());
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(input: AnyRecord | undefined, ...keys: string[]): number | undefined {
  if (!input) {
    return undefined;
  }
  const lowerCased = new Map(Object.entries(input).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lowerCased.get(key.toLowerCase());
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'File', 'FilePath', 'file_path', 'Path', 'path', 'Uri'];
const DIRECTORY_KEYS = ['SearchPath', 'SearchDirectory', 'DirectoryPath', 'Directory', 'Path', 'path'];

const BASH_TOOLS = new Set(['run_command']);
const READ_TOOLS = new Set(['view_file', 'view_file_outline', 'view_code_item', 'read_file']);
const WRITE_TOOLS = new Set(['write_to_file', 'create_file']);
const EDIT_TOOLS = new Set(['replace_file_content', 'multi_replace_file_content', 'edit_file']);
const GREP_TOOLS = new Set(['grep_search', 'codebase_search']);
const GLOB_TOOLS = new Set(['find_by_name']);
const LIST_TOOLS = new Set(['list_dir']);
const FETCH_TOOLS = new Set(['read_url_content']);
const SEARCH_WEB_TOOLS = new Set(['search_web']);
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'browser_subagent']);

/**
 * Maps one agy tool call onto the tool rows the chat already renders, by agy's
 * tool name first and the ACP `kind` second:
 *
 * | agy tool / ACP kind                                   | Row       |
 * | ----------------------------------------------------- | --------- |
 * | `run_command`, kind `execute`                         | Bash      |
 * | `view_file*`, `view_code_item`, kind `read`           | Read      |
 * | `write_to_file`, `create_file`, a diff with no old text | Write   |
 * | `replace_file_content`, `edit_file`, kind `edit`      | Edit      |
 * | `grep_search`, `codebase_search`, kind `search`       | Grep      |
 * | `find_by_name`, `list_dir`                            | Glob      |
 * | `read_url_content`, kind `fetch`                      | WebFetch  |
 * | `search_web`                                          | WebSearch |
 * | `invoke_subagent`, `browser_subagent`                 | Task      |
 *
 * Anything else keeps agy's own name and raw input, which the chat shows as a
 * generic tool row. Only `run_command` and its `CommandLine` argument are
 * verified against agy 1.5.19; the other names come from the 1.5.19 binary
 * and their argument names are read loosely (several spellings each).
 */
function mapAntigravityToolCall(state: ToolCallState): { toolName: string; toolInput: AnyRecord } {
  const name = (state.name ?? '').toLowerCase();
  const kind = state.kind ?? '';
  const input = state.rawInput ?? {};
  const locationPath = readOptionalString(state.locations[0]?.path);
  const diff = state.content.find((entry) => entry.type === 'diff');
  const filePath = () => pickString(input, ...PATH_KEYS) ?? readOptionalString(diff?.path) ?? locationPath;

  const knownName = name.length > 0 && [
    BASH_TOOLS, READ_TOOLS, WRITE_TOOLS, EDIT_TOOLS, GREP_TOOLS, GLOB_TOOLS, LIST_TOOLS, FETCH_TOOLS, SEARCH_WEB_TOOLS, SUBAGENT_TOOLS,
  ].some((names) => names.has(name));
  // The ACP kind decides only for a tool agy names differently, and only when
  // the input has what the row needs.
  const byKind = (expected: string, hasField: boolean) => !knownName && kind === expected && hasField;

  const commandLine = pickString(input, 'CommandLine', 'command', 'cmd');
  if (BASH_TOOLS.has(name) || byKind('execute', Boolean(commandLine))) {
    const command = commandLine ?? state.title ?? '';
    const description = pickString(input, 'toolSummary', 'description');
    return { toolName: 'Bash', toolInput: { command, ...(description ? { description } : {}) } };
  }

  const isEdit = EDIT_TOOLS.has(name) || byKind('edit', true);
  if (WRITE_TOOLS.has(name) || (isEdit && diff && !readOptionalString(diff.oldText))) {
    return {
      toolName: 'Write',
      toolInput: {
        file_path: filePath() ?? '',
        content: pickString(input, 'CodeContent', 'Content', 'content') ?? readOptionalString(diff?.newText) ?? '',
      },
    };
  }

  if (isEdit) {
    const chunks = Array.isArray(input.ReplacementChunks) ? input.ReplacementChunks.map((chunk: unknown) => readObjectRecord(chunk)) : [];
    const firstChunk = chunks.find(Boolean) ?? undefined;
    return {
      toolName: 'Edit',
      toolInput: {
        file_path: filePath() ?? '',
        old_string: readOptionalString(diff?.oldText) ?? pickString(input, 'TargetContent') ?? pickString(firstChunk, 'TargetContent') ?? '',
        new_string: readOptionalString(diff?.newText) ?? pickString(input, 'ReplacementContent') ?? pickString(firstChunk, 'ReplacementContent') ?? '',
      },
    };
  }

  if (LIST_TOOLS.has(name)) {
    return { toolName: 'Glob', toolInput: { pattern: '*', path: pickString(input, ...DIRECTORY_KEYS) ?? locationPath ?? '' } };
  }

  if (GLOB_TOOLS.has(name)) {
    return {
      toolName: 'Glob',
      toolInput: {
        pattern: pickString(input, 'Pattern', 'pattern', 'Query', 'Name') ?? state.title ?? '',
        path: pickString(input, ...DIRECTORY_KEYS) ?? locationPath ?? '',
      },
    };
  }

  if (READ_TOOLS.has(name) || byKind('read', Boolean(filePath()))) {
    const offset = pickNumber(input, 'StartLine', 'offset');
    const endLine = pickNumber(input, 'EndLine');
    return {
      toolName: 'Read',
      toolInput: {
        file_path: filePath() ?? state.title ?? '',
        ...(offset !== undefined ? { offset } : {}),
        ...(offset !== undefined && endLine !== undefined ? { limit: Math.max(0, endLine - offset + 1) } : {}),
      },
    };
  }

  if (GREP_TOOLS.has(name) || byKind('search', Boolean(pickString(input, 'Query', 'Pattern', 'query', 'pattern')))) {
    return {
      toolName: 'Grep',
      toolInput: {
        pattern: pickString(input, 'Query', 'Pattern', 'pattern', 'query', 'SearchTerm') ?? state.title ?? '',
        path: pickString(input, ...DIRECTORY_KEYS) ?? locationPath ?? '',
      },
    };
  }

  if (FETCH_TOOLS.has(name) || byKind('fetch', Boolean(pickString(input, 'Url', 'url', 'Uri')))) {
    return { toolName: 'WebFetch', toolInput: { url: pickString(input, 'Url', 'url', 'Uri') ?? state.title ?? '' } };
  }

  if (SEARCH_WEB_TOOLS.has(name)) {
    return { toolName: 'WebSearch', toolInput: { query: pickString(input, 'query', 'Query') ?? state.title ?? '' } };
  }

  if (SUBAGENT_TOOLS.has(name)) {
    return {
      toolName: 'Task',
      toolInput: {
        subagent_type: state.name,
        description: state.title ?? pickString(input, 'toolSummary', 'Description') ?? state.name,
        prompt: pickString(input, 'Prompt', 'prompt', 'Task', 'Instruction') ?? '',
      },
    };
  }

  return {
    toolName: state.name ?? state.title ?? (kind ? `agy:${kind}` : 'Tool'),
    toolInput: state.title ? { ...input, title: state.title } : input,
  };
}

/**
 * The chat tool row for one ACP tool call (`tool_call`, or the `toolCall` of a
 * `session/request_permission`), plus the one-line target it acts on. Used by
 * the Antigravity runtime to show a permission request the way the call's row
 * will look, and by the tests of the tool mapping above.
 */
export function describeAntigravityToolCall(toolCall: unknown): {
  toolCallId: string;
  toolName: string;
  toolInput: AnyRecord;
  target: string;
} | null {
  const record = readObjectRecord(toolCall);
  const state = record ? mergeToolCall(undefined, record) : null;
  if (!state) {
    return null;
  }
  const { toolName, toolInput } = mapAntigravityToolCall(state);
  const target = pickString(toolInput, 'command', 'file_path', 'url', 'pattern', 'query', 'description')
    ?? state.title
    ?? toolName;
  return { toolCallId: state.toolCallId, toolName, toolInput, target };
}

/** The text of a finished tool call: its `rawOutput.output`, else its text content blocks. */
function readToolResultText(state: ToolCallState, toolName: string): string {
  const rawOutput = readObjectRecord(state.rawOutput);
  let text = typeof rawOutput?.output === 'string'
    ? rawOutput.output
    : state.content
      .map((entry) => (entry.type === 'content' ? readOptionalString(readObjectRecord(entry.content)?.text) : undefined))
      .filter((value): value is string => Boolean(value))
      .join('\n');
  if (!text && typeof state.rawOutput === 'string') {
    text = state.rawOutput;
  }
  if (!text && rawOutput && Object.keys(rawOutput).length > 0) {
    text = JSON.stringify(rawOutput, null, 2);
  }
  if (toolName === 'Bash') {
    // agy prefixes command output with its own run record ("Created At: …,
    // Command exited with code 0.\n\nCommand output:\n"); the row shows the output.
    const marker = text.indexOf('Command output:\n');
    if (marker >= 0) {
      text = text.slice(marker + 'Command output:\n'.length);
    }
    text = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  }
  return text;
}

function isFinishedStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

function isToolFailure(state: ToolCallState): boolean {
  if (state.status === 'failed') {
    return true;
  }
  const exitCode = readObjectRecord(state.rawOutput)?.exit_code;
  return typeof exitCode === 'number' && exitCode !== 0;
}

// ---------------------------------------------------------------------------
// Session updates
// ---------------------------------------------------------------------------

type UserAttachment = { path: string; name?: string; mimeType?: string; data?: string };

function readUriPath(uri: string | undefined): string | undefined {
  if (!uri) {
    return undefined;
  }
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  return uri;
}

/**
 * Turns the `session/update` notifications of one Antigravity session into
 * chat messages, statefully: agy streams assistant text and thoughts as many
 * small chunks and a tool call as a `tool_call` followed by updates.
 *
 * - `live` (a running turn): assistant text streams as `stream_delta` and ends
 *   with `stream_end` when something else arrives; a thought is sent as one
 *   `thinking` message when it ends; a tool call is sent as `tool_use` when it
 *   first appears and as `tool_result` when it finishes; user chunks are
 *   dropped (the chat gateway announces the turn's prompt itself).
 * - `history` (a `session/load` replay): chunks are joined into whole `text`,
 *   `thinking` and user messages, and a tool call's result is attached to its
 *   `tool_use` row.
 *
 * In both modes `plan` becomes a `TodoWrite` row, the fork's checklist, and
 * `usage_update` / `session_info_update` are kept on the normalizer
 * (`usage`, `title`) rather than turned into rows.
 *
 * Used by the Antigravity runtime (live) and this provider's history reader.
 */
export class AntigravityUpdateNormalizer {
  /** Last `usage_update`: tokens in context and the window size. */
  usage: { used: number; size: number } | null = null;
  /** Last title agy gave the session (`session_info_update`). */
  title: string | null = null;

  private readonly mode: 'live' | 'history';
  private readonly sessionId: string;
  private readonly idPrefix: string;
  private counter = 0;
  private segment: { kind: 'assistant' | 'thought' | 'user'; text: string; images: UserAttachment[]; files: UserAttachment[] } | null = null;
  private liveTextOpen = false;
  private readonly tools = new Map<string, ToolCallState>();
  private readonly emittedToolUse = new Set<string>();
  private readonly emittedToolResult = new Set<string>();
  private readonly historyToolMessages = new Map<string, NormalizedMessage>();

  constructor(options: { mode: 'live' | 'history'; sessionId: string; idPrefix: string }) {
    this.mode = options.mode;
    this.sessionId = options.sessionId;
    this.idPrefix = options.idPrefix;
  }

  /** Normalizes one `session/update` notification's `update` object. */
  push(update: unknown): NormalizedMessage[] {
    const record = readObjectRecord(update);
    const kind = readOptionalString(record?.sessionUpdate);
    if (!record || !kind) {
      return [];
    }

    switch (kind) {
      case 'agent_message_chunk':
        return this.pushChunk('assistant', record.content);
      case 'agent_thought_chunk':
        return this.pushChunk('thought', record.content);
      case 'user_message_chunk':
        return this.mode === 'live' ? [] : this.pushChunk('user', record.content);
      case 'tool_call':
      case 'tool_call_update':
        return this.pushToolCall(record);
      case 'plan':
        return [...this.closeSegment(), ...this.pushPlan(record)];
      case 'usage_update': {
        const used = Number(record.used);
        const size = Number(record.size);
        if (Number.isFinite(used)) {
          this.usage = { used, size: Number.isFinite(size) ? size : 0 };
        }
        return [];
      }
      case 'session_info_update': {
        const title = readOptionalString(record.title);
        if (title) {
          this.title = title;
        }
        return [];
      }
      default:
        // available_commands_update, current_mode_update, config_option_update,
        // background_commands_update: session state, not transcript rows.
        return [];
    }
  }

  /** Ends whatever text or thought is still open (turn end, replay end). */
  flush(): NormalizedMessage[] {
    return this.closeSegment();
  }

  private nextId(label: string): string {
    this.counter += 1;
    return `${this.idPrefix}_${label}_${this.counter}`;
  }

  private message(fields: { kind: NormalizedMessage['kind'] } & Record<string, unknown>): NormalizedMessage {
    return createNormalizedMessage({ ...fields, sessionId: this.sessionId, provider: PROVIDER });
  }

  private pushChunk(kind: 'assistant' | 'thought' | 'user', contentValue: unknown): NormalizedMessage[] {
    const content = readObjectRecord(contentValue);
    const messages: NormalizedMessage[] = [];
    if (this.segment && this.segment.kind !== kind) {
      messages.push(...this.closeSegment());
    }
    this.segment ??= { kind, text: '', images: [], files: [] };

    const type = readOptionalString(content?.type);
    if (type === 'text') {
      const text = typeof content?.text === 'string' ? content.text : '';
      this.segment.text += text;
      if (kind === 'assistant' && this.mode === 'live' && text) {
        this.liveTextOpen = true;
        messages.push(this.message({ kind: 'stream_delta', content: text }));
      }
    } else if (kind === 'user' && type === 'image' && typeof content?.data === 'string') {
      const mimeType = readOptionalString(content.mimeType) ?? 'image/png';
      this.segment.images.push({
        path: readUriPath(readOptionalString(content.uri)) ?? 'image',
        mimeType,
        data: `data:${mimeType};base64,${content.data}`,
      });
    } else if (kind === 'user' && (type === 'resource_link' || type === 'resource')) {
      const resource = type === 'resource' ? readObjectRecord(content?.resource) : content;
      const filePath = readUriPath(readOptionalString(resource?.uri));
      if (filePath) {
        this.segment.files.push({
          path: filePath,
          name: readOptionalString(content?.name) ?? filePath.split(/[\\/]/).pop(),
          ...(readOptionalString(resource?.mimeType) ? { mimeType: readOptionalString(resource?.mimeType) } : {}),
        });
      }
    }
    return messages;
  }

  private closeSegment(): NormalizedMessage[] {
    const segment = this.segment;
    this.segment = null;
    const messages: NormalizedMessage[] = [];
    if (this.liveTextOpen) {
      this.liveTextOpen = false;
      messages.push(this.message({ kind: 'stream_end' }));
    }
    if (!segment) {
      return messages;
    }

    if (segment.kind === 'thought' && segment.text.trim()) {
      messages.push(this.message({ id: this.nextId('thinking'), kind: 'thinking', content: segment.text }));
    } else if (segment.kind === 'assistant' && this.mode === 'history' && segment.text.trim()) {
      messages.push(this.message({ id: this.nextId('text'), kind: 'text', role: 'assistant', content: segment.text }));
    } else if (segment.kind === 'user' && (segment.text.trim() || segment.images.length || segment.files.length)) {
      messages.push(this.message({
        id: this.nextId('user'),
        kind: 'text',
        role: 'user',
        content: segment.text,
        ...(segment.images.length ? { images: segment.images } : {}),
        ...(segment.files.length ? { files: segment.files } : {}),
      }));
    }
    return messages;
  }

  private pushToolCall(update: AnyRecord): NormalizedMessage[] {
    const toolCallId = readOptionalString(update.toolCallId);
    const state = mergeToolCall(toolCallId ? this.tools.get(toolCallId) : undefined, update);
    if (!state) {
      return [];
    }
    this.tools.set(state.toolCallId, state);
    const messages = this.closeSegment();
    const { toolName, toolInput } = mapAntigravityToolCall(state);
    const toolId = state.toolCallId;

    if (this.mode === 'history') {
      let toolMessage = this.historyToolMessages.get(toolId);
      if (!toolMessage) {
        toolMessage = this.message({ id: `agy_tool_${toolId}`, kind: 'tool_use', toolName, toolInput, toolId });
        this.historyToolMessages.set(toolId, toolMessage);
        messages.push(toolMessage);
      } else {
        toolMessage.toolName = toolName;
        toolMessage.toolInput = toolInput;
      }
      if (isFinishedStatus(state.status)) {
        toolMessage.toolResult = { content: readToolResultText(state, toolName), isError: isToolFailure(state) };
      }
      return messages;
    }

    if (!this.emittedToolUse.has(toolId)) {
      this.emittedToolUse.add(toolId);
      messages.push(this.message({ id: `agy_tool_${toolId}`, kind: 'tool_use', toolName, toolInput, toolId }));
    }
    if (isFinishedStatus(state.status) && !this.emittedToolResult.has(toolId)) {
      this.emittedToolResult.add(toolId);
      messages.push(this.message({
        id: `agy_tool_${toolId}_result`,
        kind: 'tool_result',
        toolId,
        content: readToolResultText(state, toolName),
        isError: isToolFailure(state),
      }));
    }
    return messages;
  }

  private pushPlan(update: AnyRecord): NormalizedMessage[] {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const todos = entries
      .map((entry: unknown) => readObjectRecord(entry))
      .filter((entry): entry is AnyRecord => Boolean(entry && readOptionalString(entry.content)))
      .map((entry) => ({
        content: String(entry.content),
        status: readOptionalString(entry.status) ?? 'pending',
        ...(readOptionalString(entry.priority) ? { priority: readOptionalString(entry.priority) } : {}),
      }));
    if (todos.length === 0) {
      return [];
    }
    const toolId = this.nextId('plan');
    return [this.message({
      id: toolId,
      kind: 'tool_use',
      toolName: 'TodoWrite',
      toolInput: { todos },
      toolId,
      toolResult: { content: '', isError: false },
    })];
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

type CachedHistory = { loadedAt: number; messages: NormalizedMessage[] };

const historyCache = new Map<string, CachedHistory>();
const MAX_CACHED_HISTORIES = 16;
/** Sessions a turn is running for: their history is not reloaded mid-turn. */
const busySessions = new Set<string>();

/**
 * Drops a session's cached history, or all of them. Used by the Antigravity
 * runtime when a turn ends and by the session synchronizer when agy's
 * conversation store changes.
 */
export function invalidateAntigravityHistory(providerSessionId?: string): void {
  if (providerSessionId) {
    historyCache.delete(providerSessionId);
  } else {
    historyCache.clear();
  }
}

/**
 * Marks a session as having a turn running (or not). Used by the Antigravity
 * runtime: reloading a conversation from a second agy process while the
 * first is writing it would race the turn, so the cached copy is served.
 */
export function setAntigravitySessionBusy(providerSessionId: string, busy: boolean): void {
  if (busy) {
    busySessions.add(providerSessionId);
  } else {
    busySessions.delete(providerSessionId);
  }
}

/**
 * Replays a session's history through `session/load` (agy sends the whole
 * conversation as `session/update` notifications before answering) in a
 * short-lived agy process. agy's replay carries no timestamps, so rows get
 * one-millisecond steps ending now, which keeps them in transcript order.
 */
async function loadHistory(providerSessionId: string, cwd: string): Promise<NormalizedMessage[]> {
  const normalizer = new AntigravityUpdateNormalizer({
    mode: 'history',
    sessionId: providerSessionId,
    idPrefix: `agy_${providerSessionId}`,
  });
  const messages: NormalizedMessage[] = [];
  await withAntigravityAcp({ cwd }, async (connection) => {
    connection.onNotification((method, params) => {
      const record = readObjectRecord(params);
      if (method !== 'session/update' || readOptionalString(record?.sessionId) !== providerSessionId) {
        return;
      }
      messages.push(...normalizer.push(record?.update));
    });
    await connection.request('session/load', { sessionId: providerSessionId, cwd, mcpServers: [] }, {
      timeoutMs: HISTORY_LOAD_TIMEOUT_MS,
    });
    // Closed so agy stops its backend for this session right away.
    await connection.request('session/close', { sessionId: providerSessionId }, { timeoutMs: 5_000 }).catch(() => undefined);
  });
  messages.push(...normalizer.flush());
  if (normalizer.usage) {
    antigravityUsageStore.recordContext(providerSessionId, normalizer.usage.used, normalizer.usage.size);
  }

  const end = Date.now();
  messages.forEach((message, index) => {
    message.timestamp = new Date(end - (messages.length - index)).toISOString();
  });
  return messages;
}

export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Stateless mapping of one `session/update` (or its `update` object), for
   * callers that hold no normalizer. Live turns use `AntigravityUpdateNormalizer`
   * directly, which joins chunks and pairs tool results.
   */
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(raw);
    const update = readObjectRecord(record?.update) ?? record;
    const normalizer = new AntigravityUpdateNormalizer({
      mode: 'live',
      sessionId: sessionId ?? readOptionalString(record?.sessionId) ?? '',
      idPrefix: `agy_${Date.now().toString(36)}`,
    });
    return [...normalizer.push(update), ...normalizer.flush()];
  }

  /**
   * Reads history by replaying the conversation through agy (`session/load`),
   * cached for a minute and dropped when a turn ends. Returns an empty page
   * when agy is not installed or not signed in.
   */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;
    const empty: FetchHistoryResult = { messages: [], total: 0, hasMore: false, offset, limit };
    if (!resolveAntigravityCli()) {
      return empty;
    }

    let cached = historyCache.get(providerSessionId);
    const fresh = cached && (busySessions.has(providerSessionId) || Date.now() - cached.loadedAt < HISTORY_CACHE_TTL_MS);
    if (!fresh) {
      try {
        const messages = await loadHistory(providerSessionId, options.projectPath || os.homedir());
        cached = { loadedAt: Date.now(), messages };
        historyCache.delete(providerSessionId);
        historyCache.set(providerSessionId, cached);
        while (historyCache.size > MAX_CACHED_HISTORIES) {
          const oldest = historyCache.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          historyCache.delete(oldest);
        }
      } catch (error) {
        if (!isAntigravityAuthRequiredError(error)) {
          console.warn(`[Antigravity] Could not load the history of ${providerSessionId}:`, errorMessage(error));
        }
        if (!cached) {
          return empty;
        }
      }
    }

    const all = (cached?.messages ?? []).map((message) => ({ ...message, sessionId }));
    const { page, hasMore } = sliceTailPage(all, limit, Math.max(0, offset));
    const usage = antigravityUsageStore.read(providerSessionId);
    return {
      messages: page,
      total: all.length,
      hasMore,
      offset,
      limit,
      ...(usage ? { tokenUsage: { used: usage.used, total: usage.size, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}),
    };
  }
}
