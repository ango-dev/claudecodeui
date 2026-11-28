import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Which Google Antigravity CLI (`agy`) CloudCLI runs.
 *
 * CloudCLI never bundles agy and never talks to Google itself: every
 * Antigravity chat, model lookup, session listing and sign-in check starts the
 * user's own `agy` binary, which uses the sign-in the user made with it. The
 * binary is looked up, in order:
 *
 * 1. `ANTIGRAVITY_CLI_PATH`, the same kind of override `CLAUDE_CLI_PATH` is
 *    for Claude: a path to the binary, or a command name looked up on PATH;
 * 2. the first `agy` on the server's PATH (`agy.exe` / `agy.cmd` on Windows);
 * 3. the installer's default locations: `~/.local/bin/agy`, and on Windows
 *    `%LOCALAPPDATA%\agy\bin\agy.exe`, `%LOCALAPPDATA%\Programs\agy\agy.exe`
 *    and `%USERPROFILE%\.local\bin\agy.exe` (the Windows locations are a
 *    best guess: agy 1.5.19 does not document them).
 *
 * Nothing is cached: `agy update` replaces the binary in place, and the next
 * chat must start the new one without a server restart.
 */

/** Environment variable that points CloudCLI at a specific agy binary. */
const CLI_PATH_ENV = 'ANTIGRAVITY_CLI_PATH';

type AntigravityCli = {
  /** Absolute path (or, for an unresolvable override, the name) of the binary to spawn. */
  command: string;
  /** Where the binary was found, for messages and tests. */
  source: 'env' | 'path' | 'default-location';
};

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function readPathVariable(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') {
    return env.PATH ?? '';
  }
  // Windows has one PATH under any casing.
  return Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
}

function findOnPath(commandName: string, env: NodeJS.ProcessEnv): string | null {
  const names = process.platform === 'win32' && !path.extname(commandName)
    ? [`${commandName}.exe`, `${commandName}.cmd`, commandName]
    : [commandName];
  for (const directory of readPathVariable(env).split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function listDefaultLocations(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform !== 'win32') {
    return [path.join(home, '.local', 'bin', 'agy')];
  }
  const locations: string[] = [];
  if (env.LOCALAPPDATA) {
    locations.push(
      path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
      path.join(env.LOCALAPPDATA, 'Programs', 'agy', 'agy.exe'),
    );
  }
  locations.push(path.join(home, '.local', 'bin', 'agy.exe'));
  return locations;
}

/**
 * Used by every Antigravity facet (auth, models, sessions, synchronizer,
 * runtime) and the CLI update service, so they all start the same binary.
 * null when no agy is installed where CloudCLI looks.
 *
 * An explicit `ANTIGRAVITY_CLI_PATH` that names a missing file is still
 * returned: it is the operator's call, and the spawn error then says what is
 * wrong instead of CloudCLI silently running some other agy.
 */
export function resolveAntigravityCli(env: NodeJS.ProcessEnv = process.env): AntigravityCli | null {
  const configured = stripWrappingQuotes(env[CLI_PATH_ENV] ?? '');
  if (configured) {
    const isPathLike = configured.includes('/') || configured.includes('\\');
    if (isPathLike) {
      return { command: configured, source: 'env' };
    }
    const onPath = findOnPath(configured, env);
    return { command: onPath ?? configured, source: 'env' };
  }

  const onPath = findOnPath('agy', env);
  if (onPath) {
    return { command: onPath, source: 'path' };
  }

  const defaultLocation = listDefaultLocations(env).find(isExecutableFile);
  return defaultLocation ? { command: defaultLocation, source: 'default-location' } : null;
}
