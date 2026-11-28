import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { AntigravityMcpProvider } from '@/modules/providers/list/antigravity/antigravity-mcp.provider.js';

/**
 * Antigravity MCP config: `~/.gemini/config/mcp_config.json` (user) and
 * `<workspace>/.agents/mcp_config.json` (project), in the shape `agy mcp add`
 * 1.5.19 writes.
 */

let root = '';
let workspace = '';
const saved: Record<string, string | undefined> = {};

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-'));
  workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  for (const name of ['HOME', 'USERPROFILE']) {
    saved[name] = process.env[name];
    process.env[name] = root;
  }
});

after(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const userConfigPath = () => path.join(root, '.gemini', 'config', 'mcp_config.json');

test('reads the config agy mcp add writes: stdio and serverUrl entries', async () => {
  await mkdir(path.dirname(userConfigPath()), { recursive: true });
  // Byte-for-byte what `agy mcp add` + `agy mcp disable fs` produced (1.5.19).
  await writeFile(userConfigPath(), JSON.stringify({
    mcpServers: {
      api: { disabled: false, headers: { Authorization: 'Bearer T' }, serverUrl: 'https://example.com/mcp' },
      fs: { args: ['-y', '@x/server', '/work'], command: 'npx', disabled: true, env: { FOO: 'bar' } },
      legacy: { url: 'https://legacy.example.com/mcp' },
    },
  }, null, 2));

  const servers = await new AntigravityMcpProvider().listServersForScope('user');
  assert.deepEqual(servers, [
    { provider: 'antigravity', name: 'api', scope: 'user', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer T' } },
    { provider: 'antigravity', name: 'fs', scope: 'user', transport: 'stdio', command: 'npx', args: ['-y', '@x/server', '/work'], env: { FOO: 'bar' }, cwd: undefined },
    { provider: 'antigravity', name: 'legacy', scope: 'user', transport: 'http', url: 'https://legacy.example.com/mcp', headers: {} },
  ]);
});

test('editing keeps agy-only keys, the disabled switch and the url key an entry used', async () => {
  const provider = new AntigravityMcpProvider();
  await provider.upsertServer({ name: 'fs', scope: 'user', transport: 'stdio', command: 'node', args: ['server.js'] });
  await provider.upsertServer({ name: 'legacy', scope: 'user', transport: 'http', url: 'https://new.example.com/mcp' });
  await provider.upsertServer({ name: 'added', scope: 'user', transport: 'http', url: 'https://added.example.com/mcp' });

  const config = JSON.parse(await readFile(userConfigPath(), 'utf8'));
  assert.deepEqual(config.mcpServers.fs, { command: 'node', args: ['server.js'], disabled: true });
  assert.deepEqual(config.mcpServers.legacy, { url: 'https://new.example.com/mcp', disabled: false });
  assert.deepEqual(config.mcpServers.added, { serverUrl: 'https://added.example.com/mcp', disabled: false });
  assert.deepEqual(config.mcpServers.api.headers, { Authorization: 'Bearer T' });
});

test('project scope lives in <workspace>/.agents/mcp_config.json; no SSE', async () => {
  const provider = new AntigravityMcpProvider();
  await provider.upsertServer({ name: 'local', scope: 'project', workspacePath: workspace, transport: 'stdio', command: 'tool', cwd: '/abs' });
  const config = JSON.parse(await readFile(path.join(workspace, '.agents', 'mcp_config.json'), 'utf8'));
  assert.deepEqual(config, { mcpServers: { local: { command: 'tool', args: [], cwd: '/abs', disabled: false } } });

  const removed = await provider.removeServer({ name: 'local', scope: 'project', workspacePath: workspace });
  assert.equal(removed.removed, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, '.agents', 'mcp_config.json'), 'utf8')), { mcpServers: {} });

  await assert.rejects(
    provider.upsertServer({ name: 'sse', scope: 'user', transport: 'sse', url: 'https://x/sse' }),
    /does not support "sse"/,
  );
  await assert.rejects(
    provider.upsertServer({ name: 'x', scope: 'local', transport: 'stdio', command: 'x' }),
    /does not support "local"/,
  );
});
