import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  claudeCodeCommands: Array<{ name: string; description: string; argumentHint?: string }> = [],
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    claudeCodeCommands: async () => claudeCodeCommands,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('the command list carries Claude Code\'s own commands, leaving the app\'s built-ins in charge of a shared name', async () => {
  const router = createCommandsRouter({
    fileSystem: {
      access: async () => { throw new Error('missing'); },
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService() as never,
    claudeCodeCommands: async () => [
      { name: '__internal', description: 'Plumbing', argumentHint: '' },
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>' },
      { name: 'cost', description: 'Show the total cost of the session', argumentHint: '' },
      { name: 'clear', description: 'Start a new session with empty context', argumentHint: '[name]', aliases: ['reset', 'new'] },
    ],
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { cli: Array<Record<string, unknown>> };

    assert.deepEqual(body.cli.map((command) => command.name), ['/clear', '/compact'], 'the app keeps /cost; the rest are sorted');
    assert.equal(body.cli[1].description, 'Free up context by summarizing the conversation so far');
    assert.equal(body.cli[1].argumentHint, '<optional custom summarization instructions>');
    assert.deepEqual(body.cli[0].metadata, { type: 'cli', aliases: ['reset', 'new'] });
  } finally {
    server.close();
  }
});

test('help lists Claude Code\'s commands after the app\'s, each with a few-word summary', async () => {
  const result = await executeCommand('/help', {}, {}, [
    { name: 'compact', description: 'Free up context by summarizing the conversation so far' },
    { name: 'batch', description: 'Research and plan a large-scale change, then execute it in parallel' },
    { name: 'docx', description: 'Use this skill whenever the user wants to create, read, or edit Word documents.' },
    { name: 'cost', description: 'Show the total cost of the session' },
  ]);
  const commands = (result.data as { commands: Array<{ name: string; description: string; namespace?: string }> }).commands;
  const claudeCode = commands.filter((command) => command.namespace === 'Claude Code');

  assert.ok(commands.findIndex((command) => command.name === '/help') < commands.findIndex((command) => command.name === '/batch'));
  assert.deepEqual(claudeCode.map((command) => [command.name, command.description]), [
    ['/batch', 'Research and plan a large-scale change'],
    ['/compact', 'Free up context by summarizing the conversation so far'],
    ['/docx', 'Skill'],
  ]);
});
