import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Antigravity MCP servers, in agy's own `mcp_config.json` format:
 *
 * ```json
 * { "mcpServers": {
 *     "fs":  { "command": "npx", "args": ["-y", "pkg"], "env": { "K": "v" }, "cwd": "/abs", "disabled": false },
 *     "api": { "serverUrl": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" }, "disabled": false } } }
 * ```
 *
 * - user scope: `~/.gemini/config/mcp_config.json` (agy's global config);
 * - project scope: `<workspace>/.agents/mcp_config.json`.
 *
 * The user-scope shape is verified: it is exactly what `agy mcp add` (1.5.19)
 * writes, `serverUrl` for remote servers and `disabled` on every entry. agy
 * reads `url` too (its docs call `serverUrl` the legacy key), so both are
 * read and an entry keeps whichever key it already used. agy has no legacy SSE
 * transport, so only stdio and Streamable HTTP are offered. Keys CloudCLI does
 * not model (`disabled`, `variables`, ...) survive an edit of the entry.
 *
 * The project-scope location follows agy's `.agents/` customization root; its
 * 1.5.19 docs only name the global and plugin `mcp_config.json` files, so a
 * project entry may need a newer agy to take effect.
 */
export class AntigravityMcpProvider extends McpProvider {
  constructor() {
    super('antigravity', ['user', 'project'], ['stdio', 'http']);
  }

  private resolveConfigPath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
      : path.join(workspacePath, '.agents', 'mcp_config.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(this.resolveConfigPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.resolveConfigPath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    const previous = readObjectRecord(config.mcpServers) ?? {};
    // The base class rebuilds an edited entry from the form; agy's own keys
    // that the form does not show stay as they were.
    const merged: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(servers)) {
      const before = readObjectRecord(previous[name]);
      const next = readObjectRecord(entry);
      if (!before || !next || before === next) {
        merged[name] = entry;
        continue;
      }
      const kept = { ...before };
      // A server that changed transport drops the other transport's keys.
      for (const key of ['command', 'args', 'env', 'cwd', 'url', 'serverUrl', 'headers']) {
        delete kept[key];
      }
      const usesUrlKey = typeof before.url === 'string' && typeof next.serverUrl === 'string';
      // `agy mcp disable` is the user's switch; editing a server keeps it.
      const keptDisabled = typeof before.disabled === 'boolean' ? { disabled: before.disabled } : {};
      merged[name] = usesUrlKey
        ? { ...kept, ...next, url: next.serverUrl, serverUrl: undefined, ...keptDisabled }
        : { ...kept, ...next, ...keptDisabled };
    }
    config.mcpServers = JSON.parse(JSON.stringify(merged));
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        command: input.command,
        args: input.args ?? [],
        ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        disabled: false,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      serverUrl: input.url,
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
      disabled: false,
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    const command = readOptionalString(config.command);
    if (command) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(config.args) ?? [],
        env: readStringRecord(config.env) ?? {},
        cwd: readOptionalString(config.cwd),
      };
    }

    const url = readOptionalString(config.serverUrl) ?? readOptionalString(config.url);
    if (url) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers) ?? {},
      };
    }

    return null;
  }
}
