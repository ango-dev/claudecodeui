import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_PATH = fileURLToPath(new URL('./fake-agy.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx/esm');

const findEnvKey = (name: string) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

/**
 * Puts the fake `agy` (fake-agy.ts, run through tsx) first on PATH with a
 * scratch HOME, the way the real CLI would be found. Used by the Antigravity
 * tests. `restore()` puts the environment back and removes the scratch tree.
 */
export async function installFakeAgy(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  await Promise.all([mkdir(binDir), mkdir(home), mkdir(projectDir)]);

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'agy.cmd'), `@echo off\r\nset TSX_TSCONFIG_PATH=\r\n"${process.execPath}" --import "${TSX_LOADER}" "${FIXTURE_PATH}" %*\r\n`);
  } else {
    const wrapper = path.join(binDir, 'agy');
    // The test runner's relative TSX_TSCONFIG_PATH would not resolve from the
    // project directory agy is started in; the fixture needs no tsconfig.
    await writeFile(wrapper, `#!/bin/sh\nunset TSX_TSCONFIG_PATH\nexec "${process.execPath}" --import "${TSX_LOADER}" "${FIXTURE_PATH}" "$@"\n`);
    await chmod(wrapper, 0o755);
  }

  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined) => {
    if (!(name in saved)) {
      saved[name] = process.env[name];
    }
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  const pathKey = findEnvKey('PATH');
  setEnv(pathKey, `${binDir}${path.delimiter}${process.env[pathKey] || ''}`);
  setEnv('HOME', home);
  setEnv('USERPROFILE', home);
  setEnv('ANTIGRAVITY_CLI_PATH', undefined);
  setEnv('FAKE_AGY_STATE', path.join(root, 'state.json'));

  let logCounter = 0;
  return {
    root,
    binDir,
    home,
    projectDir,
    setEnv,
    /** Sets the scenario and a fresh request log; returns the log's path. */
    useScenario(scenario: Record<string, unknown>): string {
      const logPath = path.join(root, `agy-${++logCounter}.jsonl`);
      setEnv('FAKE_AGY_SCENARIO', JSON.stringify(scenario));
      setEnv('FAKE_AGY_LOG', logPath);
      return logPath;
    },
    async readLog(logPath: string): Promise<Array<Record<string, any>>> {
      try {
        return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    async restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
