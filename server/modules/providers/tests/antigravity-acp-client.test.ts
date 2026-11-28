import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  AntigravityAcpConnection,
  AntigravityAcpError,
  isAntigravityAuthRequiredError,
  parseAntigravitySessionState,
  withAntigravityAcp,
} from '@/modules/providers/list/antigravity/antigravity-acp.client.js';
import { resolveAntigravityCli } from '@/modules/providers/list/antigravity/antigravity-cli.js';

import { installFakeAgy } from './fixtures/fake-agy-environment.js';

/**
 * The ACP client against the fake `agy` (fixtures/fake-agy.ts): NDJSON framing
 * (including messages split across writes), request/response correlation,
 * notifications, agy's own string-id requests, error mapping and lifetime.
 */

let env: Awaited<ReturnType<typeof installFakeAgy>>;

before(async () => {
  env = await installFakeAgy('agy-acp-client');
});

after(async () => {
  await env.restore();
});

test('agy is found on PATH, then by ANTIGRAVITY_CLI_PATH, and not at all without either', () => {
  assert.equal(resolveAntigravityCli()?.source, 'path');
  assert.equal(resolveAntigravityCli({ PATH: '', HOME: env.home })?.command, undefined);
  assert.deepEqual(
    resolveAntigravityCli({ PATH: '', HOME: env.home, ANTIGRAVITY_CLI_PATH: '"/opt/agy/agy"' }),
    { command: '/opt/agy/agy', source: 'env' },
  );
});

test('requests, notifications and agy requests are correlated over split NDJSON lines', async () => {
  const logPath = env.useScenario({
    fragmentOutput: true,
    prompts: [[
      { type: 'tool', id: 'call_1', name: 'run_command', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' }, output: 'a.txt', permission: true },
    ]],
  });
  const updates: string[] = [];
  const permissionIds: unknown[] = [];

  await withAntigravityAcp({ cwd: env.projectDir }, async (connection, initializeResult) => {
    assert.equal(initializeResult.agentInfo.name, 'Antigravity ACP Server');
    connection.onNotification((method, params) => {
      if (method === 'session/update') {
        updates.push((params as any).update.sessionUpdate);
      }
    });
    connection.setRequestHandler(async (method, params) => {
      assert.equal(method, 'session/request_permission');
      permissionIds.push((params as any).toolCall.toolCallId);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    });

    const state = parseAntigravitySessionState(await connection.request('session/new', { cwd: env.projectDir, mcpServers: [] }));
    assert.ok(state.sessionId);
    assert.equal(state.tierName, 'Google AI Pro');
    assert.deepEqual(state.availableModes.map((mode) => mode.id), ['default', 'accept-edits', 'auto', 'plan']);
    assert.equal(state.configOptions.find((option) => option.id === 'thought_level')?.currentValue, 'high');

    const result = await connection.request<any>('session/prompt', {
      sessionId: state.sessionId,
      prompt: [{ type: 'text', text: 'run ls' }],
    }, { timeoutMs: 0 });
    assert.equal(result.stopReason, 'end_turn');
  });

  assert.deepEqual(permissionIds, ['call_1']);
  assert.ok(updates.includes('tool_call'));
  assert.ok(updates.includes('usage_update'));
  // The client echoed agy's string request id back unchanged.
  const answer = (await env.readLog(logPath)).find((entry) => entry.permissionAnswer);
  assert.deepEqual(answer?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'allow' } });
  const reply = (await env.readLog(logPath)).find((entry) => entry.received?.result?.outcome);
  assert.equal(typeof reply?.received.id, 'string');
});

test('agy errors keep their JSON-RPC code, and -32000 Authentication required is recognised', async () => {
  env.useScenario({ auth: 'required' });
  await withAntigravityAcp({ cwd: env.projectDir }, async (connection) => {
    await assert.rejects(
      connection.request('session/list', {}),
      (error) => error instanceof AntigravityAcpError && error.code === -32000 && isAntigravityAuthRequiredError(error),
    );
    await assert.rejects(
      connection.request('nope/method', {}),
      (error) => error instanceof AntigravityAcpError && error.code === -32601 && !isAntigravityAuthRequiredError(error),
    );
  });
});

test('a request that is never answered times out, and an exit fails what is pending', async () => {
  env.useScenario({ prompts: [[{ type: 'crash' }]] });
  const connection = AntigravityAcpConnection.start({ cwd: env.projectDir });
  try {
    await connection.initialize();
    const state = parseAntigravitySessionState(await connection.request('session/new', { cwd: env.projectDir, mcpServers: [] }));
    // `session/cancel` is a notification, so nothing answers this "request".
    await assert.rejects(connection.request('session/cancel', { sessionId: state.sessionId }, { timeoutMs: 100 }), /within 100 ms/);
    await assert.rejects(
      connection.request('session/prompt', { sessionId: state.sessionId, prompt: [{ type: 'text', text: 'x' }] }, { timeoutMs: 0 }),
      /exited before answering "session\/prompt"/,
    );
    assert.match(connection.exitReason ?? '', /code 3/);
    await assert.rejects(connection.request('session/list', {}), /not running/);
  } finally {
    await connection.close();
  }
});

test('close() ends agy through stdin', async () => {
  const logPath = env.useScenario({});
  const connection = AntigravityAcpConnection.start({ cwd: env.projectDir });
  await connection.initialize();
  await connection.close();
  assert.ok(connection.exitReason);
  assert.ok((await env.readLog(logPath)).some((entry) => entry.stdinClosed));
});

test('starting without an agy installed throws a clear error', () => {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const previous = process.env[pathKey];
  process.env[pathKey] = '';
  try {
    assert.throws(() => AntigravityAcpConnection.start({ cwd: env.projectDir }), /not installed/);
  } finally {
    process.env[pathKey] = previous;
  }
});
