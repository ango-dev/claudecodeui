/**
 * A stand-in for Google's `agy` CLI, used by the Antigravity tests and the
 * end-to-end check in place of the real binary (which needs a Google sign-in).
 *
 * It answers `agy --version`, `agy models`, and speaks the Agent Client
 * Protocol on stdio for `agy acp`, with the message shapes recorded from the
 * real agy 1.5.19: `initialize` capabilities and auth methods, `session/new`
 * with `models` (effort-suffixed ids), `modes` and `configOptions` (model,
 * thought_level, mode), `-32000 "Authentication required"` while signed out,
 * string ids on its own `session/request_permission` requests (options
 * `allow`/allow_once and `deny`/reject_once), `tool_call` carrying agy's
 * non-standard `name`/`args`, `usage_update {used,size}`, prompt results with
 * `usage`, `stopReason: "cancelled"` after `session/cancel`, a second prompt
 * during a turn steering it (the first answers `end_turn` at once), unprompted
 * sessions left out of `session/list`, `session/load` replaying history as
 * `session/update`s before answering, and `-32603` for an unknown session on
 * `session/resume`.
 *
 * Driven by environment variables:
 * - FAKE_AGY_SCENARIO: JSON `Scenario` (below);
 * - FAKE_AGY_LOG: file each received message is appended to, one JSON line,
 *   after a `started` line with argv;
 * - FAKE_AGY_STATE: JSON file sessions persist in across processes (default
 *   `$HOME/.fake-agy-state.json`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type Step =
  | { type: 'text'; chunks: string[] }
  | { type: 'thought'; chunks: string[] }
  | {
    type: 'tool';
    id: string;
    name: string;
    kind: string;
    title: string;
    rawInput: Record<string, unknown>;
    output: string;
    /** Ask the client first, the way agy does in default mode. */
    permission?: boolean;
    content?: unknown[];
    failed?: boolean;
  }
  | { type: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { type: 'usage'; used: number; size: number }
  | { type: 'title'; title: string }
  | { type: 'delay'; ms: number }
  /** Waits until the prompt is cancelled. */
  | { type: 'hang' }
  | { type: 'crash' };

type Scenario = {
  /** `required`: every session method answers -32000, like a signed-out agy. */
  auth?: 'required' | 'ok';
  /** Steps of each prompt, in order; the last list is reused for later prompts. */
  prompts?: Step[][];
  /** stopReason of a prompt that runs to its end (default `end_turn`). */
  stopReason?: string;
  /** Writes each outgoing line in two pieces, split mid-message. */
  fragmentOutput?: boolean;
  /** `agy models` output lines; default the scenario's model list. */
  modelsCommand?: 'ok' | 'signed-out';
};

type StoredSession = { cwd: string; title: string | null; updatedAt: string; prompted: boolean; history: unknown[] };
type State = { sessions: Record<string, StoredSession> };

const scenario: Scenario = JSON.parse(process.env.FAKE_AGY_SCENARIO || '{}');
const logPath = process.env.FAKE_AGY_LOG;
const statePath = process.env.FAKE_AGY_STATE || path.join(os.homedir(), '.fake-agy-state.json');

const log = (entry: unknown) => {
  if (logPath) {
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  }
};

const readState = (): State => {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as State;
  } catch {
    return { sessions: {} };
  }
};
const writeState = (state: State) => fs.writeFileSync(statePath, JSON.stringify(state));

const MODELS = [
  ...['high', 'xhigh', 'medium', 'low'].map((level) => ({ modelId: `gemini-4-neon-${level}`, name: `Gemini 4 Neon (${level === 'xhigh' ? 'XHigh' : level[0].toUpperCase() + level.slice(1)})` })),
  ...['high', 'medium', 'low'].map((level) => ({ modelId: `gemini-3.8-flash-${level}`, name: `Gemini 3.8 Flash (${level[0].toUpperCase() + level.slice(1)})` })),
  { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];
const FAMILY_LEVELS: Record<string, string[]> = {
  'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-pro-orchestrator': [],
  'gpt-oss-120b-medium': [],
};
const MODES = [
  { id: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
  { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
  { id: 'auto', name: 'Auto', description: 'Approve edits and safe commands; ask before irreversible actions.' },
  { id: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
];

const args = process.argv.slice(2);
log({ started: true, argv: args, cwd: process.cwd() });

if (args[0] === '--version') {
  process.stdout.write('1.5.19\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('Fetching available models...\n');
  if (scenario.auth === 'required' || scenario.modelsCommand === 'signed-out') {
    process.stdout.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
  } else {
    for (const model of MODELS) {
      process.stdout.write(`${model.modelId}\t${model.name}\n`);
    }
  }
  process.exit(0);
}
if (args[0] !== 'acp') {
  process.stderr.write(`fake agy: unsupported arguments ${args.join(' ')}\n`);
  process.exit(2);
}

// Writes stay in order even when each is split in two, the second half later.
let writeChain: Promise<void> = Promise.resolve();
const write = (message: unknown) => {
  const line = `${JSON.stringify(message)}\n`;
  if (!scenario.fragmentOutput || line.length <= 4) {
    writeChain = writeChain.then(() => {
      process.stdout.write(line);
    });
    return;
  }
  const middle = Math.floor(line.length / 2);
  writeChain = writeChain.then(async () => {
    process.stdout.write(line.slice(0, middle));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(line.slice(middle));
  });
};
const respond = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', result, id });
const fail = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', error: { code, message }, id });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Live = {
  model: string;
  level: string;
  mode: string;
  /** Prompts waiting for their answer, oldest first. */
  prompts: Array<{ id: unknown; cancelled: boolean; steps: Step[] }>;
  running: boolean;
  promptCount: number;
};
const live = new Map<string, Live>();
const pendingClientRequests = new Map<string, (result: any) => void>();
let nextClientRequestId = 1;

const configOptions = (session: Live) => [
  {
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model,
    options: Object.keys(FAMILY_LEVELS).map((value) => ({ value, name: value })),
  },
  ...(FAMILY_LEVELS[session.model]?.length
    ? [{
      id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: session.level,
      options: FAMILY_LEVELS[session.model].map((value) => ({ value, name: value })),
    }]
    : []),
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode, options: MODES.map((mode) => ({ value: mode.id, name: mode.name })) },
];

const sessionResult = (sessionId: string, session: Live) => ({
  sessionId,
  models: { availableModels: MODELS, currentModelId: `${session.model}-${session.level}` },
  modes: { currentModeId: session.mode, availableModes: MODES },
  configOptions: configOptions(session),
  _meta: { antigravity: { tier: { name: 'Google AI Pro', id: 'g1-pro-tier' } } },
});

const update = (sessionId: string, payload: Record<string, unknown>, record = true) => {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
  if (record) {
    const state = readState();
    const stored = state.sessions[sessionId];
    if (stored) {
      stored.history.push(payload);
      stored.updatedAt = new Date().toISOString();
      writeState(state);
    }
  }
};

const askClient = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
  // Real agy uses string ids for its own requests.
  const id = String(nextClientRequestId++);
  pendingClientRequests.set(id, resolve);
  write({ jsonrpc: '2.0', method, params, id });
});

const newLive = (): Live => ({ model: 'gemini-4-neon', level: 'high', mode: 'default', prompts: [], running: false, promptCount: 0 });

async function runPrompts(sessionId: string, session: Live) {
  if (session.running) {
    return;
  }
  session.running = true;
  while (session.prompts.length > 0) {
    const prompt = session.prompts[0];
    let usageSent = false;
    for (const step of prompt.steps) {
      if (prompt.cancelled) {
        break;
      }
      // A prompt that arrived meanwhile steers this turn: the current prompt
      // answers at once and its remaining steps run as the new prompt's.
      if (session.prompts.length > 1 && session.prompts[0] === prompt) {
        session.prompts.shift();
        respond(prompt.id, { stopReason: 'end_turn' });
        session.prompts[0].steps = [...prompt.steps.slice(prompt.steps.indexOf(step)), ...session.prompts[0].steps];
        break;
      }
      if (step.type === 'text' || step.type === 'thought') {
        for (const chunk of step.chunks) {
          update(sessionId, { sessionUpdate: step.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk', content: { type: 'text', text: chunk } });
          await sleep(5);
        }
      } else if (step.type === 'tool') {
        const base = { toolCallId: step.id, name: step.name, args: step.rawInput, kind: step.kind, title: step.title, rawInput: step.rawInput };
        update(sessionId, { sessionUpdate: 'tool_call', ...base, status: 'in_progress' }, false);
        let allowed = true;
        if (step.permission && !args.includes('--dangerously-skip-permissions')) {
          update(sessionId, { sessionUpdate: 'tool_call_update', ...base, status: 'pending' }, false);
          const answer = await askClient('session/request_permission', {
            sessionId,
            toolCall: { sessionUpdate: 'tool_call', ...base, status: 'pending' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          });
          log({ permissionAnswer: answer });
          allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';
          if (prompt.cancelled) {
            break;
          }
        }
        const finished = allowed && !step.failed;
        update(sessionId, {
          sessionUpdate: allowed ? 'tool_call' : 'tool_call_update',
          ...base,
          status: finished ? 'completed' : 'failed',
          rawOutput: finished ? { output: step.output, exit_code: 0 } : { output: allowed ? step.output : 'The user denied this action.' },
          content: step.content ?? [{ type: 'content', content: { type: 'text', text: finished ? step.output : 'denied' } }],
        });
      } else if (step.type === 'plan') {
        update(sessionId, { sessionUpdate: 'plan', entries: step.entries });
      } else if (step.type === 'usage') {
        usageSent = true;
        update(sessionId, { sessionUpdate: 'usage_update', used: step.used, size: step.size }, false);
      } else if (step.type === 'title') {
        const state = readState();
        if (state.sessions[sessionId]) {
          state.sessions[sessionId].title = step.title;
          writeState(state);
        }
        update(sessionId, { sessionUpdate: 'session_info_update', title: step.title }, false);
      } else if (step.type === 'delay') {
        await sleep(step.ms);
      } else if (step.type === 'hang') {
        while (!prompt.cancelled && session.prompts.length === 1) {
          await sleep(10);
        }
      } else if (step.type === 'crash') {
        await writeChain;
        process.exit(3);
      }
    }
    if (session.prompts[0] !== prompt) {
      continue;
    }
    session.prompts.shift();
    if (prompt.cancelled) {
      respond(prompt.id, { stopReason: 'cancelled', usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } });
      continue;
    }
    if (!usageSent) {
      update(sessionId, { sessionUpdate: 'usage_update', used: 9987, size: 1048576 }, false);
    }
    respond(prompt.id, {
      stopReason: scenario.stopReason ?? 'end_turn',
      usage: { inputTokens: 9986, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 9987 },
    });
  }
  session.running = false;
}

const authRequired = scenario.auth === 'required';

async function handle(message: any) {
  const { id, method, params } = message;
  if (method === undefined) {
    // A reply to one of our own requests.
    const resolve = pendingClientRequests.get(String(id));
    pendingClientRequests.delete(String(id));
    resolve?.(message.result ?? { error: message.error });
    return;
  }

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
        auth: { logout: {} },
      },
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.19' },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google', description: 'Log in with your Google account' }],
    });
    return;
  }

  if (method === 'session/close') {
    respond(id, {});
    return;
  }

  if (method === 'session/cancel') {
    const session = live.get(params?.sessionId);
    for (const prompt of session?.prompts ?? []) {
      prompt.cancelled = true;
    }
    // Real agy answers its open permission requests itself once cancelled; the
    // client is expected to answer them `cancelled` too.
    return;
  }

  if (typeof method === 'string' && method.startsWith('session/') && authRequired) {
    fail(id, -32000, 'Authentication required');
    return;
  }

  switch (method) {
    case 'session/new': {
      const sessionId = `fake-${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`;
      const state = readState();
      state.sessions[sessionId] = { cwd: params.cwd, title: null, updatedAt: new Date().toISOString(), prompted: false, history: [] };
      writeState(state);
      const session = newLive();
      live.set(sessionId, session);
      respond(id, sessionResult(sessionId, session));
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the conversation now.' }] }, false);
      update(sessionId, { sessionUpdate: 'usage_update', used: 0, size: 1048576 }, false);
      return;
    }
    case 'session/resume':
    case 'session/load': {
      const stored = readState().sessions[params.sessionId];
      if (!stored) {
        fail(id, -32603, `Failed to read session ${params.sessionId}; retry, or load it with session/load`);
        return;
      }
      if (method === 'session/load') {
        for (const entry of stored.history) {
          update(params.sessionId, entry as Record<string, unknown>, false);
        }
      }
      const session = newLive();
      live.set(params.sessionId, session);
      respond(id, sessionResult(params.sessionId, session));
      update(params.sessionId, { sessionUpdate: 'usage_update', used: 10267, size: 1048576 }, false);
      return;
    }
    case 'session/list': {
      const sessions = Object.entries(readState().sessions)
        .filter(([, session]) => session.prompted && (!params?.cwd || session.cwd === params.cwd))
        .map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt }));
      respond(id, { sessions });
      return;
    }
    case 'session/set_mode': {
      const session = live.get(params.sessionId);
      if (!session) {
        fail(id, -32602, 'Missing sessionId');
        return;
      }
      session.mode = params.modeId;
      respond(id, {});
      update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId }, false);
      return;
    }
    case 'session/set_model': {
      const session = live.get(params.sessionId);
      const match = /^(.+)-(low|medium|high|xhigh)$/.exec(params.modelId);
      if (session) {
        session.model = match && FAMILY_LEVELS[match[1]] ? match[1] : params.modelId;
        session.level = match ? match[2] : session.level;
      }
      respond(id, {});
      return;
    }
    case 'session/set_config_option': {
      const session = live.get(params.sessionId);
      if (!session) {
        fail(id, -32602, 'Missing sessionId');
        return;
      }
      if (params.configId === 'model') {
        session.model = params.value;
      } else if (params.configId === 'thought_level') {
        session.level = params.value;
      } else if (params.configId === 'mode') {
        session.mode = params.value;
      }
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case 'session/prompt': {
      const session = live.get(params.sessionId);
      if (!session) {
        fail(id, -32602, 'Missing sessionId');
        return;
      }
      const state = readState();
      const stored = state.sessions[params.sessionId];
      if (stored) {
        stored.prompted = true;
        for (const block of params.prompt ?? []) {
          stored.history.push({ sessionUpdate: 'user_message_chunk', content: block });
        }
        writeState(state);
      }
      const prompts = scenario.prompts ?? [[{ type: 'text', chunks: ['ok'] }]];
      const steps = prompts[Math.min(session.promptCount, prompts.length - 1)];
      session.promptCount += 1;
      session.prompts.push({ id, cancelled: false, steps: [...steps] });
      void runPrompts(params.sessionId, session);
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

const reader = readline.createInterface({ input: process.stdin });
reader.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  log({ received: message });
  void handle(message);
});
reader.on('close', () => {
  log({ stdinClosed: true });
  void writeChain.then(() => process.exit(0));
});
