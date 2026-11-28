/**
 * Antigravity runtime
 * ===================
 *
 * Runs Antigravity chat turns through `agy acp` (Agent Client Protocol over
 * stdio), one agy process per turn:
 *
 * 1. start `agy acp` in the project (with `--dangerously-skip-permissions`
 *    only when the user picked Bypass permissions), `initialize`;
 * 2. `session/new`, or `session/resume` for a session that already has an agy
 *    id (falling back to `session/load`, whose history replay is ignored);
 * 3. apply the turn's permission mode (`session/set_mode`), model and effort
 *    (`session/set_config_option` for `model` and `thought_level`, or
 *    `session/set_model` with an effort-suffixed model id) — every turn,
 *    because agy does not keep them across processes;
 * 4. `session/prompt` with the text, images (base64 `image` blocks) and files
 *    (embedded text `resource`s, or `resource_link`s for binary or large ones);
 * 5. stream `session/update` into the chat, turn `session/request_permission`
 *    into the chat's permission banner, and close agy when the prompt answers.
 *
 * Stop sends `session/cancel` (answering any open permission request with
 * `cancelled`) and waits for agy to end the prompt. A message sent while a
 * turn runs is steered in as a second `session/prompt`: verified against agy
 * 1.5.19, the running prompt then answers `end_turn` at once and the new one
 * carries on the same turn, so the turn ends when its last prompt answers.
 *
 * Verified against agy 1.5.19 with a signed-in account: session/new,
 * set_model, set_config_option, set_mode, prompt streaming, a `run_command`
 * permission round trip (options `allow`/allow_once and `deny`/reject_once),
 * cancel (`stopReason: "cancelled"`), steering, session/resume and
 * session/load. Image and file prompt blocks follow the ACP spec and agy's
 * advertised `promptCapabilities` (image, embeddedContext) only.
 */

import crypto from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AntigravityAcpConnection,
  isAntigravityAuthRequiredError,
  parseAntigravityConfigOptions,
  parseAntigravitySessionState,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import {
  AntigravityUpdateNormalizer,
  describeAntigravityToolCall,
  invalidateAntigravityHistory,
  setAntigravitySessionBusy,
} from '@/modules/providers/list/antigravity/antigravity-sessions.provider.js';
import { antigravityUsageStore } from '@/modules/providers/list/antigravity/antigravity-usage.store.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import {
  isAllowedImageSourcePath,
  normalizeAttachmentDescriptors,
  resolveImageAbsolutePath,
  resolveImageMediaType,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  AntigravityConfigOption,
  AntigravitySessionState,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  createCompleteMessage,
  createNormalizedMessage,
  errorMessage,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

// The notifications module is still JavaScript; these state the shapes callers pass.
const notificationEvent = createNotificationEvent as (event: AnyRecord) => unknown;
const reportRunStopped = notifyRunStopped as (input: AnyRecord) => void;
const reportRunFailed = notifyRunFailed as (input: AnyRecord) => void;

const PROVIDER = 'antigravity';

const NOT_INSTALLED_MESSAGE = 'The Antigravity CLI (agy) is not installed. Install it from https://antigravity.google, then sign in by running `agy` once.';
const NOT_SIGNED_IN_MESSAGE = 'Antigravity is not signed in. Run `agy` in a terminal once and sign in with your Google account.';

const readTimeoutFromEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** Unanswered permission requests are denied after this long (0 waits), like the other runtimes. */
const TOOL_APPROVAL_TIMEOUT_MS = readTimeoutFromEnv('ANTIGRAVITY_TOOL_APPROVAL_TIMEOUT_MS', 55_000);

/** How long a stop waits for agy to end the prompt after `session/cancel` before closing agy anyway. */
const CANCEL_WAIT_MS = 5_000;

/** How long session/new, resume and load may take: the first start of agy's backend can be slow. */
const SESSION_START_TIMEOUT_MS = 120_000;

/** Largest attached file embedded as text; bigger or binary files go as a `resource_link`. */
const MAX_EMBEDDED_FILE_BYTES = 512 * 1024;

const MAX_REMEMBERED_APPROVAL_SESSIONS = 500;

type AcpContentBlock = AnyRecord;

type PermissionOption = { optionId: string; kind: string; name: string };

/** One running turn, keyed in `activeTurns` by the app session id (else agy's id). */
type AntigravityTurn = {
  key: string;
  cwd: string;
  connection: AntigravityAcpConnection | null;
  providerSessionId: string | null;
  aborted: boolean;
  ended: boolean;
  abortFinished: Promise<void> | null;
  /** Prompts sent and not yet answered (more than one only while steering). */
  outstandingPrompts: number;
  /** Sends another prompt into the turn; null until the first prompt is out. */
  sendPrompt: ((blocks: AcpContentBlock[]) => void) | null;
  send(message: unknown): void;
  sessionIdForChat(): string;
  /** Wakes the turn waiting on its prompts (stop, agy exit). */
  finish(): void;
};

/** A permission request waiting for the chat's answer. */
type PendingAntigravityPrompt = {
  requestId: string;
  sessionId: string | null;
  toolName: string;
  input: unknown;
  context: AnyRecord;
  receivedAt: Date;
  answer(decision: ProviderPermissionDecision): void;
  /** Withdraws the prompt; agy gets `cancelled` (stop, turn end) or a denial (timeout). */
  settle(reason: 'cancelled' | 'timeout'): void;
};

const activeTurns = new Map<string, AntigravityTurn>();
const pendingPrompts = new Map<string, PendingAntigravityPrompt>();
/**
 * "Always allow" answers per chat (tool row + target), in memory only. agy
 * 1.5.19 offered no allow_always option for commands, so CloudCLI remembers
 * the approval itself and answers agy's later identical requests with
 * allow_once; when agy does offer allow_always it gets that too.
 */
const rememberedApprovals = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Permission modes, models and effort
// ---------------------------------------------------------------------------

/** agy mode ids for each CloudCLI permission mode, preferred first (agy 1.5.19 ids first). */
const MODE_CANDIDATES: Record<string, string[]> = {
  default: ['default'],
  acceptEdits: ['accept-edits', 'acceptEdits', 'accept_edits'],
  auto: ['auto'],
  plan: ['plan'],
  // Bypass runs agy with --dangerously-skip-permissions, in its default mode.
  bypassPermissions: ['default'],
};

/**
 * Picks the agy session mode for a CloudCLI permission mode among the modes
 * agy offers (verified 1.5.19: `default`, `accept-edits`, `auto`, `plan`), and
 * whether agy must start with `--dangerously-skip-permissions`, which only
 * Bypass permissions sets. null when agy offers no matching mode.
 *
 * Exported for tests only.
 */
export function resolveAntigravityMode(
  permissionMode: unknown,
  availableModeIds: string[],
): { modeId: string | null; skipPermissions: boolean } {
  const mode = typeof permissionMode === 'string' && MODE_CANDIDATES[permissionMode] ? permissionMode : 'default';
  const candidates = MODE_CANDIDATES[mode];
  const modeId = availableModeIds.length === 0
    ? candidates[0]
    : candidates.find((candidate) => availableModeIds.includes(candidate)) ?? null;
  return { modeId, skipPermissions: mode === 'bypassPermissions' };
}

function findOption(state: Pick<AntigravitySessionState, 'configOptions'>, category: string): AntigravityConfigOption | undefined {
  return state.configOptions.find((option) => option.category === category || option.id === category);
}

/**
 * Plans the calls that put a session on `model` with `effort`, given what
 * agy reported for the session. The picker's values are model families
 * (`gemini-3.8-flash`) with effort levels (`low`), so the preferred way is
 * agy's own split: `model` and `thought_level` config options. Without them,
 * or for a model id that is not a family (a custom model), it is
 * `session/set_model` with an exact id, the effort suffix added when that id
 * exists. Returns an empty plan for a model agy does not offer.
 *
 * The thought-level step is planned against the options agy reported before
 * the model switch; the runtime re-checks it against the options the switch
 * returns.
 *
 * Exported for tests only.
 */
export function planAntigravityModelSelection(
  state: Pick<AntigravitySessionState, 'configOptions' | 'availableModels' | 'currentModelId'>,
  model: string | undefined,
  effort: unknown,
): Array<{ method: string; params: AnyRecord }> {
  const level = typeof effort === 'string' && effort && effort !== 'default' ? effort : null;
  const modelOption = findOption(state, 'model');
  const thoughtOption = findOption(state, 'thought_level');
  const modelIds = new Set(state.availableModels.map((entry) => entry.modelId));
  const calls: Array<{ method: string; params: AnyRecord }> = [];

  if (!model || (modelOption && modelOption.options.some((option) => option.value === model))) {
    if (model && modelOption && modelOption.currentValue !== model) {
      calls.push({ method: 'session/set_config_option', params: { configId: modelOption.id, value: model } });
    }
    if (level && thoughtOption && (calls.length > 0 || thoughtOption.currentValue !== level)) {
      calls.push({ method: 'session/set_config_option', params: { configId: thoughtOption.id, value: level } });
    }
    return calls;
  }

  const candidates = [
    level ? `${model}-${level}` : null,
    model,
    `${model}-high`,
    `${model}-medium`,
    ...state.availableModels.map((entry) => entry.modelId).filter((id) => id.startsWith(`${model}-`)),
  ].filter((id): id is string => Boolean(id));
  const modelId = candidates.find((id) => modelIds.has(id));
  if (modelId && modelId !== state.currentModelId) {
    calls.push({ method: 'session/set_model', params: { modelId } });
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Prompt content
// ---------------------------------------------------------------------------

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) {
    return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves an attachment to a real path inside the upload store or the
 * project, the same trust boundary the Claude and Codex image builders use.
 */
async function resolveAttachmentPath(descriptorPath: string, cwd: string): Promise<string | null> {
  const resolved = resolveImageAbsolutePath(cwd, descriptorPath);
  if (!isAllowedImageSourcePath(resolved, cwd)) {
    console.warn(`[Antigravity] Refusing to attach a file outside the allowed roots: ${descriptorPath}`);
    return null;
  }
  try {
    const canonical = await realpath(resolved);
    if (!isAllowedImageSourcePath(canonical, cwd)) {
      console.warn(`[Antigravity] Refusing to attach a symlinked file outside the allowed roots: ${descriptorPath}`);
      return null;
    }
    return canonical;
  } catch (error) {
    console.warn(`[Antigravity] Could not read attachment ${descriptorPath}:`, errorMessage(error));
    return null;
  }
}

/**
 * Builds the `session/prompt` content: the message text, each image as a
 * base64 `image` block, and each other file as an embedded text `resource`
 * (so agy sees exactly what was uploaded) or, when it is binary or larger
 * than 512 KiB, a `resource_link` agy opens itself.
 *
 * Exported for tests only.
 */
export async function buildAntigravityPrompt(
  command: string,
  images: unknown,
  files: unknown,
  cwd: string,
): Promise<AcpContentBlock[]> {
  const blocks: AcpContentBlock[] = [];
  const text = typeof command === 'string' ? command : '';
  if (text.trim()) {
    blocks.push({ type: 'text', text });
  }

  for (const descriptor of normalizeAttachmentDescriptors(images)) {
    const mimeType = resolveImageMediaType(descriptor);
    const filePath = mimeType ? await resolveAttachmentPath(descriptor.path, cwd) : null;
    if (!filePath || !mimeType) {
      continue;
    }
    try {
      const bytes = await readFile(filePath);
      blocks.push({ type: 'image', mimeType, data: bytes.toString('base64'), uri: pathToFileURL(filePath).href });
    } catch (error) {
      console.warn(`[Antigravity] Could not read image ${descriptor.path}:`, errorMessage(error));
    }
  }

  for (const descriptor of normalizeAttachmentDescriptors(files)) {
    const filePath = await resolveAttachmentPath(descriptor.path, cwd);
    if (!filePath) {
      continue;
    }
    const uri = pathToFileURL(filePath).href;
    const name = descriptor.name || path.basename(filePath);
    try {
      const { size } = await stat(filePath);
      if (size > 0 && size <= MAX_EMBEDDED_FILE_BYTES) {
        const bytes = await readFile(filePath);
        if (looksLikeText(bytes)) {
          blocks.push({
            type: 'resource',
            resource: { uri, mimeType: descriptor.mimeType || 'text/plain', text: bytes.toString('utf8') },
          });
          continue;
        }
      }
      blocks.push({
        type: 'resource_link',
        uri,
        name,
        size,
        ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
      });
    } catch (error) {
      console.warn(`[Antigravity] Could not read attachment ${descriptor.path}:`, errorMessage(error));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

function readPermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readObjectRecord(entry))
    .filter((entry): entry is AnyRecord => Boolean(entry && readOptionalString(entry.optionId)))
    .map((entry) => ({
      optionId: String(entry.optionId),
      kind: readOptionalString(entry.kind) ?? '',
      name: readOptionalString(entry.name) ?? String(entry.optionId),
    }));
}

/**
 * The ACP answer for a chat decision: the option of the matching kind, by
 * preference (allow + remember: allow_always, else allow_once; allow:
 * allow_once; deny: reject_once, else reject_always). `cancelled` when agy
 * offered nothing that fits.
 *
 * Exported for tests only.
 */
export function selectAntigravityPermissionOutcome(
  options: Array<{ optionId: string; kind: string }>,
  decision: { allow: boolean; remember?: boolean },
): AnyRecord {
  const preference = decision.allow
    ? (decision.remember ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'])
    : ['reject_once', 'reject_always'];
  for (const kind of preference) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

function rememberApproval(chatKey: string, rule: string): void {
  const rules = rememberedApprovals.get(chatKey) ?? new Set<string>();
  rules.add(rule);
  rememberedApprovals.delete(chatKey);
  rememberedApprovals.set(chatKey, rules);
  while (rememberedApprovals.size > MAX_REMEMBERED_APPROVAL_SESSIONS) {
    const oldest = rememberedApprovals.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    rememberedApprovals.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

function readStopReason(result: unknown): string | null {
  return readOptionalString(readObjectRecord(result)?.stopReason) ?? null;
}

/** Message for a stop reason that is not a normal end, or null. */
function describeStopReason(stopReason: string | null): string | null {
  switch (stopReason) {
    case 'refusal':
      return 'The model refused to continue this turn.';
    case 'max_tokens':
      return 'The turn stopped: the model reached its output token limit.';
    case 'max_turn_requests':
      return 'The turn stopped: it reached the maximum number of model requests.';
    default:
      return null;
  }
}

async function runAntigravityTurn(
  command: string,
  options: AnyRecord = {},
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, files, permissionMode } = options;
  const appSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  const resumeSessionId = context.resolveProviderSessionId(appSessionId);
  const workingDir: string = cwd || projectPath || process.cwd();
  const userId = writer?.userId ?? null;

  let wakeTurn!: () => void;
  const promptsSettled = new Promise<void>((resolve) => {
    wakeTurn = resolve;
  });
  const turn: AntigravityTurn = {
    key: appSessionId ?? resumeSessionId ?? `antigravity-${Date.now()}`,
    cwd: workingDir,
    connection: null,
    providerSessionId: resumeSessionId,
    aborted: false,
    ended: false,
    abortFinished: null,
    outstandingPrompts: 0,
    sendPrompt: null,
    send: (message) => writer.send(message),
    sessionIdForChat: () => appSessionId ?? turn.providerSessionId ?? turn.key,
    finish: () => wakeTurn(),
  };
  activeTurns.set(turn.key, turn);

  const send = turn.send;
  const sentErrors = new Set<string>();
  const sendError = (content: string) => {
    if (sentErrors.has(content)) {
      return;
    }
    sentErrors.add(content);
    send(createNormalizedMessage({ kind: 'error', content, sessionId: turn.sessionIdForChat(), provider: PROVIDER }));
  };
  const notify = (event: AnyRecord) => notifyUserIfEnabled({ userId, event: notificationEvent(event) });
  const approvalsKey = () => appSessionId ?? turn.providerSessionId ?? turn.key;

  let normalizer: AntigravityUpdateNormalizer | null = null;
  let replaying = false;
  let turnError: string | null = null;
  let lastStopReason: string | null = null;
  let lastUsage: AnyRecord | null = null;
  const turnPromptIds = new Set<string>();

  const sendTokenBudget = () => {
    const providerSessionId = turn.providerSessionId;
    const usage = providerSessionId ? antigravityUsageStore.read(providerSessionId) : null;
    if (!usage || (usage.used <= 0 && usage.inputTokens <= 0)) {
      return;
    }
    send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget: {
        used: usage.used,
        ...(usage.size > 0 ? { total: usage.size } : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        breakdown: { input: usage.inputTokens, output: usage.outputTokens },
      },
      sessionId: turn.sessionIdForChat(),
      provider: PROVIDER,
    }));
  };

  const registerProviderSession = (providerSessionId: string) => {
    turn.providerSessionId = providerSessionId;
    if (!appSessionId && turn.key !== providerSessionId) {
      if (activeTurns.get(turn.key) === turn) {
        activeTurns.delete(turn.key);
      }
      turn.key = providerSessionId;
      activeTurns.set(turn.key, turn);
    }
    writer.setSessionId?.(providerSessionId);
    send(createNormalizedMessage({
      kind: 'session_created',
      newSessionId: providerSessionId,
      sessionId: providerSessionId,
      provider: PROVIDER,
    }));
  };

  const handleSessionUpdate = (params: unknown) => {
    const record = readObjectRecord(params);
    if (!record || replaying || readOptionalString(record.sessionId) !== turn.providerSessionId) {
      return;
    }
    const update = readObjectRecord(record.update);
    normalizer ??= new AntigravityUpdateNormalizer({
      mode: 'live',
      sessionId: turn.sessionIdForChat(),
      idPrefix: `agy_${crypto.randomUUID().slice(0, 8)}`,
    });
    for (const message of normalizer.push(update)) {
      send(message);
    }
    if (update?.sessionUpdate === 'usage_update' && normalizer.usage && turn.providerSessionId) {
      antigravityUsageStore.recordContext(turn.providerSessionId, normalizer.usage.used, normalizer.usage.size);
      sendTokenBudget();
    }
  };

  /** Shows agy's permission request in the chat and resolves agy's answer. */
  const handlePermissionRequest = (params: unknown): Promise<AnyRecord> => {
    const record = readObjectRecord(params) ?? {};
    const permissionOptions = readPermissionOptions(record.options);
    const described = describeAntigravityToolCall(record.toolCall);
    const toolName = described?.toolName ?? 'Tool';
    const target = described?.target ?? toolName;
    const rule = `${toolName}: ${target}`;

    if (turn.aborted || turn.ended) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    if (permissionMode === 'bypassPermissions' || rememberedApprovals.get(approvalsKey())?.has(rule)) {
      return Promise.resolve(selectAntigravityPermissionOutcome(permissionOptions, { allow: true }));
    }

    return new Promise((resolve) => {
      const requestId = `agy_permission_${crypto.randomUUID()}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const withdraw = (kind: 'permission_resolved' | 'permission_cancelled', reason?: string) => {
        clearTimeout(timer);
        pendingPrompts.delete(requestId);
        turnPromptIds.delete(requestId);
        send(createNormalizedMessage({
          kind,
          requestId,
          ...(reason ? { reason } : {}),
          sessionId: turn.sessionIdForChat(),
          provider: PROVIDER,
        }));
      };
      const pending: PendingAntigravityPrompt = {
        requestId,
        sessionId: appSessionId ?? turn.providerSessionId,
        toolName,
        input: described?.toolInput ?? {},
        context: { patterns: [target], always: [rule] },
        receivedAt: new Date(),
        answer: (decision) => {
          if (pendingPrompts.get(requestId) !== pending) {
            return;
          }
          withdraw('permission_resolved');
          const remember = Boolean(decision.allow && decision.rememberEntry);
          if (remember) {
            rememberApproval(approvalsKey(), rule);
          }
          resolve(selectAntigravityPermissionOutcome(permissionOptions, { allow: decision.allow, remember }));
        },
        settle: (reason) => {
          if (pendingPrompts.get(requestId) !== pending) {
            return;
          }
          withdraw('permission_cancelled', reason);
          resolve(reason === 'timeout'
            ? selectAntigravityPermissionOutcome(permissionOptions, { allow: false })
            : { outcome: { outcome: 'cancelled' } });
        },
      };
      pendingPrompts.set(requestId, pending);
      turnPromptIds.add(requestId);
      if (TOOL_APPROVAL_TIMEOUT_MS > 0) {
        timer = setTimeout(() => pending.settle('timeout'), TOOL_APPROVAL_TIMEOUT_MS);
      }

      send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName,
        input: pending.input,
        context: pending.context,
        sessionId: turn.sessionIdForChat(),
        provider: PROVIDER,
      }));
      notify({
        provider: PROVIDER,
        sessionId: turn.sessionIdForChat(),
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `antigravity:permission:${turn.sessionIdForChat()}:${requestId}`,
      });
    });
  };

  const applyConfig = async (connection: AntigravityAcpConnection, state: AntigravitySessionState) => {
    const providerSessionId = turn.providerSessionId!;
    const { modeId } = resolveAntigravityMode(permissionMode, state.availableModes.map((mode) => mode.id));
    if (modeId && modeId !== state.currentModeId) {
      const modeOption = findOption(state, 'mode');
      if (state.availableModes.some((mode) => mode.id === modeId) || !modeOption) {
        await connection.request('session/set_mode', { sessionId: providerSessionId, modeId });
      } else {
        await connection.request('session/set_config_option', { sessionId: providerSessionId, configId: modeOption.id, value: modeId });
      }
    } else if (!modeId) {
      console.warn(`[Antigravity] agy offers no mode for permission mode "${String(permissionMode)}"; keeping its default.`);
    }

    const resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, model);
    let current = state;
    for (const call of planAntigravityModelSelection(current, resolvedModel, effort)) {
      if (call.params.configId && call.params.configId !== findOption(current, 'model')?.id) {
        // A thought level is only sent when the model now selected offers it.
        const thoughtOption = findOption(current, 'thought_level');
        if (!thoughtOption?.options.some((option) => option.value === call.params.value)) {
          continue;
        }
      }
      const result = readObjectRecord(await connection.request(call.method, { sessionId: providerSessionId, ...call.params }));
      if (Array.isArray(result?.configOptions)) {
        current = { ...current, configOptions: parseAntigravityConfigOptions(result.configOptions) };
      }
    }
  };

  let connection: AntigravityAcpConnection | null = null;
  try {
    const prompt = await buildAntigravityPrompt(command, images, files, workingDir);
    if (prompt.length === 0) {
      throw new Error('Antigravity needs a message to run.');
    }
    if (turn.aborted) {
      throw new Error('aborted');
    }

    const { skipPermissions } = resolveAntigravityMode(permissionMode, []);
    connection = AntigravityAcpConnection.start({
      cwd: workingDir,
      extraArgs: skipPermissions ? ['--dangerously-skip-permissions'] : [],
    });
    turn.connection = connection;
    connection.onNotification((method, params) => {
      if (method === 'session/update') {
        handleSessionUpdate(params);
      }
    });
    connection.setRequestHandler(async (method, params) => {
      if (method === 'session/request_permission') {
        return handlePermissionRequest(params);
      }
      throw new Error(`CloudCLI does not implement ${method}.`);
    });
    connection.onExit((reason) => {
      if (!turn.aborted && !turn.ended) {
        turnError ??= `agy stopped unexpectedly (${reason}).${connection?.stderr ? ` ${connection.stderr.trim().split('\n').slice(-1)[0]}` : ''}`;
        turn.finish();
      }
    });

    await connection.initialize();
    let state: AntigravitySessionState;
    if (resumeSessionId) {
      const params = { sessionId: resumeSessionId, cwd: workingDir, mcpServers: [] };
      try {
        state = parseAntigravitySessionState(await connection.request('session/resume', params, { timeoutMs: SESSION_START_TIMEOUT_MS }));
      } catch (error) {
        if (isAntigravityAuthRequiredError(error)) {
          throw error;
        }
        // agy 1.5.19 suggests session/load when resume cannot read a session.
        replaying = true;
        try {
          state = parseAntigravitySessionState(await connection.request('session/load', params, { timeoutMs: SESSION_START_TIMEOUT_MS }));
        } finally {
          replaying = false;
        }
      }
    } else {
      state = parseAntigravitySessionState(await connection.request('session/new', {
        cwd: workingDir,
        mcpServers: [],
      }, { timeoutMs: SESSION_START_TIMEOUT_MS }));
      if (!state.sessionId) {
        throw new Error('agy did not create a session.');
      }
      registerProviderSession(state.sessionId);
    }
    setAntigravitySessionBusy(turn.providerSessionId!, true);

    await applyConfig(connection, state);
    if (turn.aborted) {
      throw new Error('aborted');
    }

    const activeConnection = connection;
    turn.sendPrompt = (blocks) => {
      turn.outstandingPrompts += 1;
      activeConnection.request('session/prompt', { sessionId: turn.providerSessionId, prompt: blocks }, { timeoutMs: 0 })
        .then((result) => {
          lastStopReason = readStopReason(result);
          const usage = readObjectRecord(readObjectRecord(result)?.usage);
          if (usage) {
            lastUsage = usage;
          }
        })
        .catch((error) => {
          if (!turn.aborted) {
            turnError ??= isAntigravityAuthRequiredError(error) ? NOT_SIGNED_IN_MESSAGE : errorMessage(error);
          }
        })
        .finally(() => {
          turn.outstandingPrompts -= 1;
          if (turn.outstandingPrompts <= 0) {
            turn.finish();
          }
        });
    };
    turn.sendPrompt(prompt);
    await promptsSettled;
    if (turnError) {
      sendError(turnError);
    }
  } catch (error) {
    if (!turn.aborted) {
      let message = isAntigravityAuthRequiredError(error) ? NOT_SIGNED_IN_MESSAGE : errorMessage(error);
      if (!turn.connection?.exitReason && !(await context.isProviderInstalled())) {
        message = NOT_INSTALLED_MESSAGE;
      } else if (turn.connection?.exitReason && /ENOENT/.test(turn.connection.exitReason)) {
        message = NOT_INSTALLED_MESSAGE;
      }
      sendError(message);
      turnError ??= message;
    }
  } finally {
    turn.ended = true;
    turn.sendPrompt = null;
    for (const requestId of Array.from(turnPromptIds)) {
      pendingPrompts.get(requestId)?.settle('cancelled');
    }
    // Assigned inside the notification handler, which the compiler does not follow.
    for (const message of (normalizer as AntigravityUpdateNormalizer | null)?.flush() ?? []) {
      send(message);
    }
    if (turn.aborted) {
      await turn.abortFinished;
    }
    await connection?.close();
    if (activeTurns.get(turn.key) === turn) {
      activeTurns.delete(turn.key);
    }
    if (turn.providerSessionId) {
      setAntigravitySessionBusy(turn.providerSessionId, false);
      invalidateAntigravityHistory(turn.providerSessionId);
    }
  }

  const finalSessionId = turn.sessionIdForChat();
  if (turn.aborted) {
    // The chat gateway sends the terminal `complete` (aborted) for a stop.
    await new Promise<void>((resolve) => setImmediate(resolve));
    reportRunStopped({ userId, provider: PROVIDER, sessionId: finalSessionId, sessionName: sessionSummary, stopReason: 'aborted' });
    return;
  }

  const finalUsage = lastUsage as AnyRecord | null;
  if (finalUsage && turn.providerSessionId) {
    antigravityUsageStore.recordPrompt(
      turn.providerSessionId,
      Number(finalUsage.inputTokens) || 0,
      Number(finalUsage.outputTokens) || 0,
    );
  }
  sendTokenBudget();

  const stopProblem = describeStopReason(lastStopReason);
  if (stopProblem && !turnError) {
    sendError(stopProblem);
    if (lastStopReason === 'refusal') {
      turnError = stopProblem;
    }
  }

  const completedNormally = !turnError;
  send(createCompleteMessage({ provider: PROVIDER, sessionId: finalSessionId, exitCode: completedNormally ? 0 : 1 }));
  if (completedNormally) {
    reportRunStopped({ userId, provider: PROVIDER, sessionId: finalSessionId, sessionName: sessionSummary, stopReason: 'completed' });
    return;
  }
  reportRunFailed({ userId, provider: PROVIDER, sessionId: finalSessionId, sessionName: sessionSummary, error: turnError });
  throw new Error(turnError ?? 'Antigravity run failed');
}

/**
 * Stops the turn running for a session: answers its open permission requests
 * with `cancelled`, sends `session/cancel`, waits (up to 5 s) for agy to end
 * the prompt, then closes agy. The chat gateway sends the terminal `complete`
 * (aborted) once this returns.
 */
async function abortAntigravityTurn(sessionId: string): Promise<boolean> {
  const turn = activeTurns.get(sessionId);
  if (!turn) {
    return false;
  }
  if (turn.aborted) {
    await turn.abortFinished;
    return true;
  }

  turn.aborted = true;
  turn.abortFinished = (async () => {
    for (const prompt of Array.from(pendingPrompts.values())) {
      if (prompt.sessionId === sessionId || (turn.providerSessionId && prompt.sessionId === turn.providerSessionId)) {
        prompt.settle('cancelled');
      }
    }
    const { connection } = turn;
    if (connection && turn.providerSessionId && turn.outstandingPrompts > 0) {
      connection.notify('session/cancel', { sessionId: turn.providerSessionId });
      const deadline = Date.now() + CANCEL_WAIT_MS;
      while (turn.outstandingPrompts > 0 && Date.now() < deadline && !connection.exitReason) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await connection?.close({ graceMs: 1_000 });
  })();
  turn.finish();
  await turn.abortFinished;
  return true;
}

/**
 * Sends a message into the running turn as another `session/prompt` (see the
 * module comment), and echoes it as the user row the composer tracks by
 * `messageId`. False when the session has no turn that can take it.
 */
async function steerAntigravityTurn(sessionId: string, command: string, options: AnyRecord): Promise<boolean> {
  const turn = activeTurns.get(sessionId);
  if (!turn || turn.aborted || turn.ended || !turn.sendPrompt) {
    return false;
  }
  const blocks = await buildAntigravityPrompt(command, options.images, options.files, turn.cwd);
  if (blocks.length === 0 || !turn.sendPrompt) {
    return false;
  }
  turn.sendPrompt(blocks);
  const images = normalizeAttachmentDescriptors(options.images);
  const files = normalizeAttachmentDescriptors(options.files);
  turn.send(createNormalizedMessage({
    id: typeof options.messageId === 'string' && options.messageId ? options.messageId : `agy_steer_${crypto.randomUUID()}`,
    kind: 'text',
    role: 'user',
    content: command,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
    sessionId: turn.sessionIdForChat(),
    provider: PROVIDER,
  }));
  return true;
}

function resolveAntigravityPrompt(requestId: string, decision: ProviderPermissionDecision): void {
  pendingPrompts.get(requestId)?.answer(decision);
}

function listPendingAntigravityPrompts(sessionId: string) {
  return Array.from(pendingPrompts.values())
    .filter((prompt) => prompt.sessionId === sessionId)
    .map((prompt) => ({
      requestId: prompt.requestId,
      toolName: prompt.toolName,
      input: prompt.input,
      context: prompt.context,
      sessionId,
      receivedAt: prompt.receivedAt,
    }));
}

/**
 * The Antigravity runtime facet. Used by the Antigravity provider wrapper,
 * through which providerRuntimeService runs chat turns, queued and scheduled
 * messages and /api/agent runs, steers messages into a running turn, and
 * routes the chat's permission answers. No side questions: ACP has no way to
 * fork a session, and agy's own `/btw` is not exposed over ACP.
 */
export const antigravityRuntime = {
  run: runAntigravityTurn,
  abort: abortAntigravityTurn,
  steer: steerAntigravityTurn,
  permissions: {
    resolve: resolveAntigravityPrompt,
    listPending: listPendingAntigravityPrompts,
  },
};
