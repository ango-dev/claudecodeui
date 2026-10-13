import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { findApplicationRoot, getModuleDirectory } from '@/shared/utils.js';

import { findXvfb, getVirtualDisplay, stopVirtualDisplay } from './browser-use-display.js';
import { getBrowserUseRuntime } from './browser-use-runtime.js';

const require = createRequire(import.meta.url);
const __dirname = getModuleDirectory(import.meta.url);
// A folder that always exists, for install commands to run in.
const APP_ROOT = findApplicationRoot(__dirname);
const MAX_SESSIONS_PER_OWNER = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_MAX_SESSIONS_PER_OWNER || '3', 10);
const SESSION_TTL_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const BROWSER_USE_SETTINGS_KEY = 'browser_use_settings';
const BROWSER_USE_MCP_TOKEN_KEY = 'browser_use_mcp_token';

type BrowserUseRuntime = ReturnType<typeof getBrowserUseRuntime>;
type BrowserUseSessionStatus = 'ready' | 'stopped' | 'unavailable';

type BrowserUseSession = {
  id: string;
  ownerId: string;
  createdBy: 'agent';
  runtime: BrowserUseRuntime;
  status: BrowserUseSessionStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  profileName: string | null;
  viewport: {
    width: number;
    height: number;
  } | null;
  cursor: {
    x: number;
    y: number;
    actor: 'agent';
  } | null;
};

type PublicBrowserUseSession = Omit<BrowserUseSession, 'ownerId'>;

type RuntimeHandle = {
  browser?: any;
  context?: any;
  page?: any;
};

/**
 * The automation library the browser runs under. Both drive Chromium through
 * the same Playwright API; Patchright is a fork patched against the usual
 * automation tells (navigator.webdriver, the Runtime.enable CDP leak, the
 * --enable-automation flag), for sites that turn automated browsers away.
 */
type BrowserUseEngine = 'playwright' | 'patchright';

/**
 * The browser the engine drives: the engine's own downloaded Chromium build,
 * or the Google Chrome installed on the machine. Patchright's authors advise
 * real Chrome for the best results against bot detection; installing it
 * system-wide needs administrator rights (see installRuntime).
 */
type BrowserUseBrowser = 'chromium' | 'chrome';

/**
 * How the browser shows: headless (no window; pages can read "HeadlessChrome"
 * in its user agent), or a real window, which looks like a desktop browser.
 * On Linux the window goes on CloudCLI's own Xvfb virtual screen; on macOS
 * and Windows it opens on the server's desktop.
 */
type BrowserUseDisplay = 'headless' | 'window';

type BrowserUseSettings = {
  enabled: boolean;
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  /** Where Chrome is, when it is not in its standard place (e.g. unpacked into a home folder without admin rights). */
  chromePath: string | null;
  display: BrowserUseDisplay;
};

const BROWSER_USE_ENGINES: readonly BrowserUseEngine[] = ['playwright', 'patchright'];

const readEngine = (value: unknown): BrowserUseEngine => (
  BROWSER_USE_ENGINES.includes(value as BrowserUseEngine) ? value as BrowserUseEngine : 'playwright'
);

const readBrowser = (value: unknown): BrowserUseBrowser => (value === 'chrome' ? 'chrome' : 'chromium');

const readDisplay = (value: unknown): BrowserUseDisplay => (value === 'window' ? 'window' : 'headless');

/** A real window needs a virtual screen only on Linux; elsewhere the desktop is there. */
const needsVirtualScreen = (settings: BrowserUseSettings): boolean => (
  settings.display === 'window' && process.platform === 'linux'
);

/** The real window's size: about the old 1440x900 page once Chrome's toolbars are taken off. */
const BROWSER_WINDOW_SIZE = { width: 1440, height: 1000 };

const readChromePath = (value: unknown): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, 1024) : null;
};

/** Expands a leading ~ so a path typed as ~/chrome/... works. */
const expandHome = (value: string): string => (
  value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
);

/**
 * Google Chrome where its installers put it on each platform: the same places
 * Playwright's `channel: 'chrome'` looks. The Windows per-user location is
 * where Chrome's installer goes when it runs without administrator rights.
 */
function findGoogleChrome(): string | null {
  const candidates: string[] = [];
  if (process.platform === 'linux') {
    candidates.push('/opt/google/chrome/chrome');
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']]) {
      if (root) candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

type RuntimeReadiness = {
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  display: BrowserUseDisplay;
  /** False only while the real-window mode waits on Xvfb (Linux). */
  virtualScreenReady: boolean;
  /** The selected engine's module (Playwright's API either way). */
  playwright: any | null;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  chromiumExecutablePath: string | null;
  installInProgress: boolean;
  installMessage: string | null;
};

type RuntimeProbe = Omit<RuntimeReadiness, 'installInProgress' | 'installMessage'>;

const sessions = new Map<string, BrowserUseSession>();
const handles = new Map<string, RuntimeHandle>();
let installPromise: Promise<{ success: boolean; message: string }> | null = null;
let lastInstallMessage: string | null = null;
let runtimeProbeCache: { value: RuntimeProbe; updatedAt: number } | null = null;

const DEFAULT_SETTINGS: BrowserUseSettings = {
  enabled: false,
  engine: 'playwright',
  browser: 'chromium',
  chromePath: null,
  display: 'headless',
};
// Browsers being launched: their sessions have no handle yet, but may be on the virtual screen.
let launchesInProgress = 0;
// Bumped when sessions are stopped for new settings: a launch that started
// before then finishes under the old ones, so it closes instead of joining.
let sessionGeneration = 0;
const AGENT_OWNER_ID = 'agent';
const PROFILE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use', 'profiles');
/**
 * Where Install Runtime puts the engine packages, with a package.json of its
 * own naming each engine installed, so both can be kept to switch between.
 * In CloudCLI's own folder npm removed them again on its next install (a
 * CloudCLI update, or the other engine), as --no-save packages are pruned.
 */
const ENGINE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use', 'runtime');
const MCP_SERVER_NAME = 'cloudcli-browser';
const LEGACY_MCP_SERVER_NAMES = ['cloudcli-browser-use'];
const RUNTIME_READINESS_CACHE_TTL_MS = 30_000;

function readSettings(): BrowserUseSettings {
  try {
    const raw = appConfigDb.get(BROWSER_USE_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<BrowserUseSettings>;
    return {
      enabled: parsed.enabled === true,
      engine: readEngine(parsed.engine),
      browser: readBrowser(parsed.browser),
      chromePath: readChromePath(parsed.chromePath),
      display: readDisplay(parsed.display),
    };
  } catch (error: any) {
    console.warn('[Browser] Failed to read settings:', error?.message || error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: BrowserUseSettings): BrowserUseSettings {
  const normalized = {
    enabled: settings.enabled === true,
    engine: readEngine(settings.engine),
    browser: readBrowser(settings.browser),
    chromePath: readChromePath(settings.chromePath),
    display: readDisplay(settings.display),
  };

  appConfigDb.set(BROWSER_USE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(BROWSER_USE_MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(BROWSER_USE_MCP_TOKEN_KEY, token);
  return token;
}

function getSetupMessage(settings: BrowserUseSettings, readiness: RuntimeReadiness): string {
  if (!settings.enabled) {
    return 'Browser is disabled in settings.';
  }

  const engineName = readiness.engine === 'patchright' ? 'Patchright' : 'Playwright';
  if (!readiness.playwrightInstalled) {
    return `Install ${engineName} and ${readiness.browser === 'chrome' ? 'Google Chrome' : 'Chromium'} to use browser sessions.`;
  }

  if (!readiness.virtualScreenReady) {
    return `The real-window mode needs Xvfb, a virtual screen for servers. Install it from Settings -> Browser, or run \`${xvfbInstallCommand()}\`. Or choose Headless.`;
  }

  if (!readiness.chromiumInstalled) {
    return readiness.browser === 'chrome'
      ? `${engineName} is installed, but Google Chrome was not found. Install Chrome (this needs administrator rights), or set where it is.`
      : `${engineName} is installed, but Chromium is missing. Install the Chromium runtime to continue.`;
  }

  return readiness.installMessage || 'Browser runtime is not ready.';
}

/** The engine's package folder: Install Runtime's, else one beside CloudCLI from before it had its own. */
function resolveEnginePackage(engine: BrowserUseEngine): string | null {
  // Once Install Runtime has its own folder, a copy left beside CloudCLI is
  // ignored, so an engine removed in Settings stays removed.
  if (fs.existsSync(path.join(ENGINE_ROOT, 'package.json'))) {
    // Looked up directly: resolving from ENGINE_ROOT would also search
    // NODE_PATH and parent folders, and find copies Settings cannot remove.
    const directory = path.join(ENGINE_ROOT, 'node_modules', engine);
    return fs.existsSync(path.join(directory, 'package.json')) ? directory : null;
  }
  try {
    const directory = path.dirname(require.resolve(`${engine}/package.json`));
    // Node caches resolved paths, so a removed package can still resolve.
    return fs.existsSync(path.join(directory, 'package.json')) ? directory : null;
  } catch {
    return null;
  }
}

function loadEngine(engine: BrowserUseEngine): any | null {
  const packageDirectory = resolveEnginePackage(engine);
  if (!packageDirectory) {
    return null;
  }
  try {
    // Patchright is a drop-in fork: the same API under another package name.
    return require(packageDirectory);
  } catch {
    return null;
  }
}

function getMcpCommand(): { command: string; args: string[] } {
  const mcpScriptPath = path.join(__dirname, 'browser-use-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['browser-use-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/browser-use-mcp`;
}

async function removeMcpServerFromAllProviders(name: string) {
  const results = await providerMcpService.removeMcpServerFromAllProviders({
    name,
    scope: 'user',
  });
  return results.map((result) => ({ ...result, name }));
}

function normalizeProfileName(profileName?: string | null): string | null {
  const normalized = String(profileName || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 80);
}

function getProfilePath(profileName: string): string {
  const safeName = profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
  return path.join(PROFILE_ROOT, safeName);
}

/** The engine's own Chromium build, if downloaded (Install Runtime with Chromium chosen). */
function findEngineChromium(playwright: any): string | null {
  try {
    const executablePath = playwright.chromium.executablePath();
    return executablePath && fs.existsSync(executablePath) ? executablePath : null;
  } catch {
    return null;
  }
}

function probeRuntime(settings: BrowserUseSettings): RuntimeProbe {
  const { engine, browser, display } = settings;
  const playwright = loadEngine(engine);
  const readiness: RuntimeProbe = {
    engine,
    browser,
    display,
    virtualScreenReady: !needsVirtualScreen(settings) || Boolean(findXvfb()),
    playwright,
    playwrightInstalled: Boolean(playwright),
    chromiumInstalled: false,
    chromiumExecutablePath: null,
  };

  if (!playwright) {
    return readiness;
  }

  if (browser === 'chrome') {
    const configured = settings.chromePath ? expandHome(settings.chromePath) : null;
    const executablePath = configured ?? findGoogleChrome();
    readiness.chromiumExecutablePath = executablePath;
    readiness.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
    return readiness;
  }

  readiness.chromiumExecutablePath = findEngineChromium(playwright);
  readiness.chromiumInstalled = Boolean(readiness.chromiumExecutablePath);
  return readiness;
}

function getRuntimeReadiness(options: { force?: boolean } = {}): RuntimeReadiness {
  const now = Date.now();
  const settings = readSettings();
  const cachedProbe = runtimeProbeCache;
  const canUseCache = !options.force
    && !installPromise
    && cachedProbe
    && cachedProbe.value.engine === settings.engine
    && cachedProbe.value.browser === settings.browser
    && cachedProbe.value.display === settings.display
    && now - cachedProbe.updatedAt < RUNTIME_READINESS_CACHE_TTL_MS;
  const probe = canUseCache ? cachedProbe.value : probeRuntime(settings);

  if (!canUseCache && !installPromise) {
    runtimeProbeCache = { value: probe, updatedAt: now };
  }

  return {
    ...probe,
    installInProgress: Boolean(installPromise),
    installMessage: lastInstallMessage,
  };
}

const INSTALL_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(
        `${command} ${args.join(' ')} timed out after ${INSTALL_COMMAND_TIMEOUT_MS}ms.`,
      )));
    }, INSTALL_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    // stdio config above guarantees the pipes exist; cross-spawn's types
    // just don't narrow them the way node's spawn overloads do.
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(output.join('').trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    }));
  });
}

/**
 * npm's own CLI, beside the Node running CloudCLI. npm and npx are often not
 * on the PATH: under sudo, which resets it (nvm installs vanish), or when
 * CloudCLI runs as a service. Node itself always is: it is this process.
 */
function findNpmCli(): string | null {
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    // Windows keeps npm beside node.exe; Linux and macOS under ../lib.
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate)) ?? null;
}

function runNpm(args: string[]): Promise<void> {
  const npmCli = findNpmCli();
  if (npmCli) {
    return runCommand(process.execPath, [npmCli, ...args]);
  }
  return runCommand(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

/** The engine's own CLI (what `npx patchright` runs), installed or where it will be. */
function engineCliPath(engine: BrowserUseEngine): string {
  return path.join(resolveEnginePackage(engine) ?? path.join(ENGINE_ROOT, 'node_modules', engine), 'cli.js');
}

const NPM_QUIET_FLAGS = ['--no-package-lock', '--no-audit', '--no-fund', '--prefix', ENGINE_ROOT];

/** Adds the engine to ENGINE_ROOT (npm records it in that folder's package.json), beside any other. */
async function addEnginePackage(engine: BrowserUseEngine): Promise<void> {
  await fs.promises.mkdir(ENGINE_ROOT, { recursive: true });
  const manifestPath = path.join(ENGINE_ROOT, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    await fs.promises.writeFile(manifestPath, `${JSON.stringify({ name: 'cloudcli-browser-runtime', private: true }, null, 2)}\n`);
  }
  await runNpm(['install', ...NPM_QUIET_FLAGS, `${engine}@latest`]);
}

/** Removes the engine's package (and what only it needed) from ENGINE_ROOT. */
async function removeEnginePackage(engine: BrowserUseEngine): Promise<void> {
  await runNpm(['uninstall', ...NPM_QUIET_FLAGS, engine]);
}

function runEngineCli(engine: BrowserUseEngine, args: string[]): Promise<void> {
  return runCommand(process.execPath, [engineCliPath(engine), ...args]);
}

const quoteShellArgument = (value: string): string => {
  if (process.platform === 'win32') {
    return `"${value}"`;
  }
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
};

/**
 * The engine's CLI as a command to paste into a terminal, by full path: it
 * works without npx and under sudo, from any folder. Settings appends the
 * arguments (`install chrome`, `install-deps chromium`).
 */
function engineCommand(engine: BrowserUseEngine): string {
  const command = `${quoteShellArgument(process.execPath)} ${quoteShellArgument(engineCliPath(engine))}`;
  // PowerShell, Windows' default terminal, runs a quoted path only after &.
  return process.platform === 'win32' ? `& ${command}` : command;
}

function formatInstallError(error: unknown, engine: BrowserUseEngine): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('sudo') && message.includes('password')) {
    return `Installing Chromium system dependencies requires administrator privileges. Run \`sudo ${engineCommand(engine)} install-deps chromium\` on the machine where CloudCLI runs, then try again.`;
  }
  return message || 'Failed to install Browser runtime.';
}

/** True when this process can install system packages itself (root on Linux and macOS). */
const isAdministrator = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * The commands that need administrator rights, for the message shown when an
 * install step could not run without them.
 */
function adminInstructions(engine: BrowserUseEngine, browser: BrowserUseBrowser): string {
  if (browser === 'chrome') {
    if (process.platform === 'linux') {
      return `Installing Google Chrome needs administrator rights. Run \`sudo ${engineCommand(engine)} install chrome\`, or install Chrome from google.com/chrome. Without admin rights, unpack Chrome into your home folder and set its location here, or choose Stealth with Chromium.`;
    }
    if (process.platform === 'darwin') {
      return 'Installing Google Chrome needs an administrator password. Install Chrome from google.com/chrome, or drag Google Chrome.app into Applications in your home folder (no admin rights needed), then check again.';
    }
    return 'Install Google Chrome from google.com/chrome. Run without administrator rights, its installer puts Chrome in your user folder, which CloudCLI finds.';
  }
  return `Chromium is installed, but Linux may need its system libraries, which only an administrator can add: \`sudo ${engineCommand(engine)} install-deps chromium\`.`;
}

/**
 * The command that installs Xvfb with the system's package manager, whose
 * package names differ (Debian and Ubuntu: xvfb). Installing system packages
 * needs administrator rights.
 */
function xvfbPackageCommand(): string[] {
  const has = (binary: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some((directory) => fs.existsSync(path.join(directory, binary)));
  if (has('dnf')) return ['dnf', 'install', '-y', 'xorg-x11-server-Xvfb'];
  if (has('yum')) return ['yum', 'install', '-y', 'xorg-x11-server-Xvfb'];
  if (has('pacman')) return ['pacman', '-S', '--noconfirm', 'xorg-server-xvfb'];
  if (has('zypper')) return ['zypper', '--non-interactive', 'install', 'xorg-x11-server-Xvfb'];
  return ['apt-get', 'install', '-y', 'xvfb'];
}

function xvfbInstallCommand(): string {
  return `sudo ${xvfbPackageCommand().join(' ')}`;
}

/**
 * Installs Xvfb for the real-window mode: directly when CloudCLI runs as
 * root, else through sudo only where it needs no password (-n never waits
 * for one). Without either it fails with the command to run by hand.
 */
async function installXvfb(): Promise<{ success: boolean; message: string }> {
  if (process.platform !== 'linux') {
    return { success: true, message: 'A real window needs no virtual screen on this system.' };
  }
  if (findXvfb()) {
    return { success: true, message: 'Xvfb is already installed.' };
  }
  const [manager, ...args] = xvfbPackageCommand();
  const run = (command: string, commandArgs: string[]) => (
    isAdministrator() ? runCommand(command, commandArgs) : runCommand('sudo', ['-n', command, ...commandArgs])
  );
  try {
    try {
      await run(manager, args);
    } catch (error) {
      // A fresh apt system may not know the package until its lists are fetched.
      if (manager !== 'apt-get') throw error;
      await run('apt-get', ['update']);
      await run(manager, args);
    }
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);
    const detail = output.split('\n').filter(Boolean).pop() ?? '';
    // sudo -n says so when it would need a password or the user may not use it.
    const lacksRights = !isAdministrator()
      && /password is required|not in the sudoers|not allowed to|command not found|ENOENT/i.test(output);
    return {
      success: false,
      message: lacksRights
        ? `Installing Xvfb needs administrator rights, which CloudCLI does not have. Run \`${xvfbInstallCommand()}\` on the server, then check again.`
        : `Installing Xvfb failed${detail ? `: ${detail}` : ''}. Run \`${xvfbInstallCommand()}\` on the server to see the full error.`,
    };
  } finally {
    runtimeProbeCache = null;
  }
  return findXvfb()
    ? { success: true, message: 'Xvfb installed.' }
    : { success: false, message: `Xvfb was installed but not found. Run \`${xvfbInstallCommand()}\` on the server.` };
}

/**
 * Removes an engine's Chromium build, or the engine with it. The engine's
 * own uninstall deletes the builds no other installed engine or project
 * uses; the package then goes from ENGINE_ROOT.
 */
async function removeRuntime(
  engine: BrowserUseEngine,
  part: 'engine' | 'chromium',
  settings: BrowserUseSettings,
): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return { success: false, message: 'An install or removal is running; try again when it finishes.' };
  }
  const engineName = engine === 'patchright' ? 'Patchright' : 'Playwright';
  if (engine === settings.engine && (part === 'engine' || settings.browser === 'chromium')) {
    return { success: false, message: `${engineName} is in use by the current choice. Choose another engine or browser first.` };
  }
  // Holds the same lock as Install Runtime: two npm runs in one folder corrupt it.
  installPromise = (async () => {
    try {
      if (resolveEnginePackage(engine)) {
        await runEngineCli(engine, ['uninstall']);
      }
      if (part === 'engine') {
        await removeEnginePackage(engine);
      }
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) };
    }
    return {
      success: true,
      message: part === 'engine' ? `${engineName} and its Chromium removed.` : `${engineName}'s Chromium removed.`,
    };
  })();
  try {
    return await installPromise;
  } finally {
    installPromise = null;
    runtimeProbeCache = null;
  }
}

async function installRuntime(settings: BrowserUseSettings): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return installPromise;
  }

  const { engine, browser } = settings;
  // Each engine has its own package and its own Chromium build, installed
  // through its own CLI (Patchright's is Playwright's under another name).
  const engineName = engine === 'patchright' ? 'Patchright' : 'Playwright';
  runtimeProbeCache = null;
  installPromise = (async () => {
    try {
      lastInstallMessage = `Installing ${engineName} package...`;
      // Added beside any engine already installed, to switch between freely.
      await addEnginePackage(engine);

      if (browser === 'chrome') {
        const configured = settings.chromePath ? expandHome(settings.chromePath) : null;
        if ((configured && fs.existsSync(configured)) || findGoogleChrome()) {
          lastInstallMessage = `${engineName} is ready to use Google Chrome.`;
          return { success: true, message: lastInstallMessage };
        }
        // A system-wide install: apt on Linux, an installer package on macOS,
        // an elevated installer on Windows. Without admin rights it fails,
        // and the message says what to run instead.
        lastInstallMessage = 'Installing Google Chrome...';
        try {
          await runEngineCli(engine, ['install', 'chrome']);
        } catch {
          lastInstallMessage = adminInstructions(engine, browser);
          return { success: false, message: lastInstallMessage };
        }
        lastInstallMessage = `${engineName} and Google Chrome installed.`;
        return { success: true, message: lastInstallMessage };
      }

      // System libraries need root; a normal user skips them, as they are
      // often present already, and is told the command if Chromium fails.
      const needsDeps = process.platform === 'linux';
      if (needsDeps && isAdministrator()) {
        lastInstallMessage = 'Installing Chromium system dependencies...';
        await runEngineCli(engine, ['install-deps', 'chromium']);
      }

      lastInstallMessage = 'Installing Chromium runtime...';
      await runEngineCli(engine, ['install', 'chromium']);

      lastInstallMessage = needsDeps && !isAdministrator()
        ? `Browser runtime installed. ${adminInstructions(engine, browser)}`
        : 'Browser runtime installed.';
      return { success: true, message: lastInstallMessage };
    } catch (error) {
      lastInstallMessage = formatInstallError(error, engine);
      return { success: false, message: lastInstallMessage };
    }
  })();

  try {
    return await installPromise;
  } finally {
    installPromise = null;
    runtimeProbeCache = null;
  }
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  return parsed.toString();
}

function publicSession(session: BrowserUseSession): PublicBrowserUseSession {
  const { ownerId: _ownerId, ...publicFields } = session;
  return publicFields;
}

function ownerSessions(ownerId: string): BrowserUseSession[] {
  return [...sessions.values()].filter((session) => session.ownerId === ownerId);
}

/** Ends the Xvfb once no browser is on it or about to be; the next real-window session starts it again. */
function releaseVirtualScreenIfUnused(): void {
  if (handles.size === 0 && launchesInProgress === 0) {
    stopVirtualDisplay();
  }
}

async function closeHandle(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  handles.delete(sessionId);
  await handle?.context?.close?.().catch(() => undefined);
  await handle?.browser?.close().catch(() => undefined);
  releaseVirtualScreenIfUnused();
}

async function expireStaleSessions(now = Date.now()): Promise<void> {
  await Promise.all([...sessions.values()].map(async (session) => {
    if (session.status !== 'ready') {
      return;
    }

    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt <= SESSION_TTL_MS) {
      return;
    }

    await closeHandle(session.id);
    session.status = 'stopped';
    session.updatedAt = new Date(now).toISOString();
    session.lastAction = 'expire';
    session.message = 'Browser session expired after inactivity.';
  }));
}

async function captureSession(session: BrowserUseSession, page: any): Promise<void> {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
  session.screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
  session.title = await page.title().catch(() => null);
  session.url = page.url() || session.url;
  // A real window has no emulated viewport; its page area is measured instead.
  session.viewport = page.viewportSize?.()
    || await page.evaluate('({ width: innerWidth, height: innerHeight })').catch(() => null)
    || session.viewport;
  session.updatedAt = new Date().toISOString();
}

type ClickTarget = { ref?: string; selector?: string; text?: string; role?: string; name?: string; x?: number; y?: number };

/**
 * An element reference from browser_snapshot ("e12"; "[ref=e12]" and "@e12"
 * are accepted too), checked so nothing else reaches the locator engine.
 */
function readRef(ref: string): string {
  // Elements inside iframes are numbered per frame: f1e5.
  const match = /^(?:\[ref=|@)?((?:f\d+)?e\d+)\]?$/.exec(ref.trim());
  if (!match) {
    throw new Error(`"${ref}" is not an element reference from browser_snapshot (expected e.g. e12).`);
  }
  return match[1];
}

/**
 * The element an action names: a reference from browser_snapshot first (the
 * reliable way: it names one element of the page as last captured), then role
 * and accessible name, a CSS selector, or visible text.
 */
function resolveTarget(page: any, input: ClickTarget) {
  if (input.ref) {
    return page.locator(`aria-ref=${readRef(input.ref)}`);
  }
  if (input.role) {
    return page.getByRole(input.role, input.name ? { name: input.name, exact: false } : {}).first();
  }
  if (input.selector) {
    return page.locator(input.selector).first();
  }
  if (input.text) {
    return page.getByText(input.text, { exact: false }).first();
  }
  return null;
}

/**
 * resolveTarget for an action, failing at once when a reference names no
 * element: the page changed since the snapshot. Waiting on it would only end
 * in a timeout, with a less useful message.
 */
async function resolveActionTarget(page: any, input: ClickTarget) {
  const target = resolveTarget(page, input);
  if (input.ref && target && (await target.count().catch(() => 0)) === 0) {
    throw new Error(`Element ${readRef(input.ref)} is not on the page any more. Take a new browser_snapshot and use its references.`);
  }
  return target;
}

/**
 * The page's accessibility tree with element references, as Playwright's
 * agent tooling produces it. Playwright before 1.57 has no page.ariaSnapshot
 * but the same tree, references included, under _snapshotForAI (a string, or
 * { full } in some versions); a tree without references is the last resort.
 */
async function readAgentSnapshot(page: any): Promise<string> {
  try {
    if (typeof page.ariaSnapshot === 'function') {
      return await page.ariaSnapshot({ mode: 'ai', timeout: 5_000 });
    }
    if (typeof page._snapshotForAI === 'function') {
      const snapshot = await page._snapshotForAI({ timeout: 5_000 });
      const text = typeof snapshot === 'string' ? snapshot : snapshot?.full;
      if (typeof text === 'string') {
        return text;
      }
    }
  } catch {
    // Falls through to the plain tree.
  }
  return page.locator('body').ariaSnapshot({ timeout: 5_000 }).catch(() => '');
}

async function getActionPoint(page: any, input: ClickTarget) {
  if (typeof input.x === 'number' && typeof input.y === 'number') {
    return { x: input.x, y: input.y };
  }

  const locator = resolveTarget(page, input);

  if (!locator) {
    return null;
  }

  // Only for the cursor drawn in the monitor: never worth the action's whole wait.
  const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
  if (!box) {
    return null;
  }

  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

export const browserUseService = {
  async getSettings() {
    return readSettings();
  },

  async updateSettings(settings: Partial<BrowserUseSettings>) {
    const current = readSettings();
    const nextSettings = {
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : current.enabled,
      engine: settings.engine === undefined ? current.engine : readEngine(settings.engine),
      browser: settings.browser === undefined ? current.browser : readBrowser(settings.browser),
      chromePath: settings.chromePath === undefined ? current.chromePath : readChromePath(settings.chromePath),
      display: settings.display === undefined ? current.display : readDisplay(settings.display),
    };

    const next = writeSettings(nextSettings);
    if (
      next.engine !== current.engine
      || next.browser !== current.browser
      || next.chromePath !== current.chromePath
      || next.display !== current.display
    ) {
      // Open sessions run under the old engine; they end rather than mix.
      runtimeProbeCache = null;
      await this.stopAllSessions();
    }
    if (next.enabled) {
      await this.registerAgentMcp();
    } else if (current.enabled) {
      await this.unregisterAgentMcp();
      await this.stopAllSessions();
    }
    return next;
  },

  async getStatus() {
    const settings = readSettings();
    const readiness = getRuntimeReadiness();
    const available = settings.enabled
      && readiness.playwrightInstalled
      && readiness.chromiumInstalled
      && readiness.virtualScreenReady;

    return {
      enabled: settings.enabled,
      engine: settings.engine,
      browser: settings.browser,
      browserExecutablePath: readiness.chromiumExecutablePath,
      isAdministrator: isAdministrator(),
      platform: process.platform,
      engineCommand: engineCommand(settings.engine),
      display: settings.display,
      virtualScreenRequired: needsVirtualScreen(settings),
      xvfbInstalled: Boolean(findXvfb()),
      xvfbInstallCommand: process.platform === 'linux' ? xvfbInstallCommand() : null,
      // Both engines, to switch between and remove from Settings.
      engines: BROWSER_USE_ENGINES.map((engine) => {
        const module = engine === settings.engine ? readiness.playwright : loadEngine(engine);
        return { engine, installed: Boolean(module), chromiumInstalled: Boolean(module && findEngineChromium(module)) };
      }),
      runtime: getBrowserUseRuntime(),
      available,
      playwrightInstalled: readiness.playwrightInstalled,
      chromiumInstalled: readiness.chromiumInstalled,
      installInProgress: readiness.installInProgress,
      sessionCount: sessions.size,
      message: available
        ? 'Browser runtime is available.'
        : getSetupMessage(settings, readiness),
    };
  },

  async registerAgentMcp() {
    const { command, args } = getMcpCommand();
    await Promise.all(LEGACY_MCP_SERVER_NAMES.map((name) => removeMcpServerFromAllProviders(name)));
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_BROWSER_USE_MCP_TOKEN: getOrCreateMcpToken(),
        CLOUDCLI_BROWSER_USE_API_URL: getMcpApiUrl(),
      },
    });
    return { name: MCP_SERVER_NAME, command, args, results };
  },

  getMcpToken() {
    return getOrCreateMcpToken();
  },

  async unregisterAgentMcp() {
    const results = (await Promise.all(
      [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].map((name) => removeMcpServerFromAllProviders(name)),
    )).flat();
    return { name: MCP_SERVER_NAME, results };
  },

  async installVirtualScreen() {
    const result = await installXvfb();
    return { ...result, status: await this.getStatus() };
  },

  async removeRuntime(engine: BrowserUseEngine, part: 'engine' | 'chromium') {
    const result = await removeRuntime(readEngine(engine), part, readSettings());
    return { ...result, status: await this.getStatus() };
  },

  async installRuntime() {
    const result = await installRuntime(readSettings());
    return {
      ...result,
      status: await this.getStatus(),
    };
  },

  async listSessions() {
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async createAgentSession(options?: { profileName?: string | null }) {
    const settings = readSettings();
    // Taken with the settings: a change after this point stops sessions under them.
    const generation = sessionGeneration;
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }

    await expireStaleSessions();
    const profileName = normalizeProfileName(options?.profileName);

    const now = new Date().toISOString();
    const session: BrowserUseSession = {
      id: randomUUID(),
      ownerId: AGENT_OWNER_ID,
      createdBy: 'agent',
      runtime: getBrowserUseRuntime(),
      status: 'unavailable',
      url: null,
      title: null,
      screenshotDataUrl: null,
      createdAt: now,
      updatedAt: now,
      lastAction: 'create',
      message: null,
      profileName,
      viewport: { width: 1440, height: 900 },
      cursor: null,
    };

    const activeOwnerSessions = ownerSessions(AGENT_OWNER_ID).filter((item) => item.status === 'ready');
    // Browsers still starting count too: they become ready after this check,
    // so parallel requests would otherwise all pass it.
    if (activeOwnerSessions.length + launchesInProgress >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active agent sessions.`);
    }

    const readiness = getRuntimeReadiness();
    if (
      !settings.enabled
      || !readiness.playwrightInstalled
      || !readiness.chromiumInstalled
      || !readiness.virtualScreenReady
      || !readiness.playwright
    ) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    let browser: any | undefined;
    let context: any | undefined;
    let page: any;
    const withWindow = settings.display === 'window';
    launchesInProgress += 1;

    try {
      const launchOptions = {
        headless: !withWindow,
        args: [
          '--disable-dev-shm-usage',
          ...(withWindow
            ? [`--window-size=${BROWSER_WINDOW_SIZE.width},${BROWSER_WINDOW_SIZE.height}`, '--window-position=0,0']
            : []),
        ],
        // Real Chrome, where chosen: readiness found it in its standard place or
        // at the location set in Settings.
        ...(settings.browser === 'chrome' && readiness.chromiumExecutablePath
          ? { executablePath: readiness.chromiumExecutablePath }
          : {}),
        // On Linux the window goes on CloudCLI's Xvfb, never on a desktop.
        ...(needsVirtualScreen(settings)
          ? await getVirtualDisplay().then(({ display, xauthority }) => ({
            env: { ...process.env, DISPLAY: display, XAUTHORITY: xauthority },
          }))
          : {}),
      };
      const contextOptions = {
        // A real window keeps its own size: an emulated viewport inside it
        // would differ from the window, which pages can notice.
        viewport: withWindow ? null : { width: 1440, height: 900 },
        serviceWorkers: 'block',
      };

      if (profileName) {
        fs.mkdirSync(PROFILE_ROOT, { recursive: true });
        context = await readiness.playwright.chromium.launchPersistentContext(getProfilePath(profileName), {
          ...launchOptions,
          ...contextOptions,
        });
        page = context.pages()[0] || await context.newPage();
      } else {
        browser = await readiness.playwright.chromium.launch(launchOptions);
        context = await browser.newContext(contextOptions);
        page = await context.newPage();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Chromium without its Linux system libraries: only an admin can add them.
      if (/shared librar|missing dependencies|install-deps/i.test(message)) {
        throw new Error(`The browser could not start: ${adminInstructions(settings.engine, 'chromium')}`);
      }
      throw error;
    } finally {
      launchesInProgress -= 1;
      // A browser that started is registered below, before anything awaits;
      // only a failed launch may leave the virtual screen unused.
      if (!page) {
        releaseVirtualScreenIfUnused();
      }
    }
    if (generation !== sessionGeneration) {
      // Settings changed (or the server is stopping) while this browser started.
      await context?.close?.().catch(() => undefined);
      await browser?.close?.().catch(() => undefined);
      releaseVirtualScreenIfUnused();
      throw new Error('Browser settings changed while the session was starting. Create the session again.');
    }
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(session.id, session);
    handles.set(session.id, { browser, context, page });
    await captureSession(session, page);
    return publicSession(session);
  },

  async listAgentSessions() {
    const settings = readSettings();
    if (!settings.enabled) {
      return [];
    }
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async getAgentSession(sessionId: string) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return session;
  },

  async agentNavigate(sessionId: string, rawUrl: string) {
    await this.getAgentSession(sessionId);
    await expireStaleSessions();

    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }

    if (session.status !== 'ready') {
      throw new Error(session.message || 'Browser session is not available.');
    }

    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    const url = normalizeUrl(rawUrl);
    await handle.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSnapshot(sessionId: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await captureSession(session, handle.page);
    // The page as an accessibility tree, each element the agent can act on
    // tagged [ref=eN]; actions take those refs. Far fewer tokens than a page
    // dump, and unambiguous where text is not (two "Add to cart" buttons).
    const snapshot = await readAgentSnapshot(handle.page);
    return {
      session: publicSession(session),
      snapshot: snapshot.slice(0, 40_000),
      // Plain text only where the tree could not be read.
      ...(snapshot ? {} : {
        text: (await handle.page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 30_000),
      }),
    };
  },

  async agentClick(sessionId: string, input: ClickTarget) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const target = await resolveActionTarget(handle.page, input);
    const point = await getActionPoint(handle.page, input);

    if (target) {
      await target.click({ timeout: 10_000 });
    } else if (typeof input.x === 'number' && typeof input.y === 'number') {
      await handle.page.mouse.click(input.x, input.y);
    } else {
      throw new Error('Provide role (and name), selector, text, or x/y coordinates.');
    }

    session.lastAction = 'click';
    session.cursor = point ? { ...point, actor: 'agent' } : null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentType(sessionId: string, input: { ref?: string; selector?: string; text: string; submit?: boolean }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    if (input.ref || input.selector) {
      await (await resolveActionTarget(handle.page, { ref: input.ref, selector: input.selector })).fill(input.text, { timeout: 10_000 });
      session.cursor = await getActionPoint(handle.page, { ref: input.ref, selector: input.selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    } else {
      await handle.page.keyboard.type(input.text);
    }
    if (input.submit) {
      await handle.page.keyboard.press('Enter');
    }

    session.lastAction = 'type';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentFillForm(sessionId: string, fields: Array<{ ref?: string; selector?: string; value: string }>) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    for (const field of fields) {
      const target = await resolveActionTarget(handle.page, { ref: field.ref, selector: field.selector });
      if (!target) {
        throw new Error('Each field needs a ref or a selector.');
      }
      await target.fill(field.value, { timeout: 10_000 });
    }
    session.lastAction = 'fill_form';
    if (fields[0]) {
      session.cursor = await getActionPoint(handle.page, { ref: fields[0].ref, selector: fields[0].selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    }
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentPressKey(sessionId: string, key: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.keyboard.press(key);
    session.lastAction = `press_key:${key}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSelectOption(sessionId: string, target: { ref?: string; selector?: string }, values: string[]) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const locator = await resolveActionTarget(handle.page, target);
    if (!locator) {
      throw new Error('Provide the ref or selector of the select element.');
    }
    await locator.selectOption(values, { timeout: 10_000 });
    session.lastAction = 'select_option';
    session.cursor = await getActionPoint(handle.page, target).then((point) => (
      point ? { ...point, actor: 'agent' as const } : null
    ));
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentWaitFor(sessionId: string, input: { text?: string; url?: string; timeoutMs?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const timeout = Math.max(250, Math.min(input.timeoutMs || 5_000, 30_000));
    if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().waitFor({ timeout });
    } else if (input.url) {
      await handle.page.waitForURL(input.url, { timeout });
    } else {
      await handle.page.waitForTimeout(timeout);
    }
    session.lastAction = 'wait_for';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentTabs(sessionId: string, input: { action?: 'list' | 'new' | 'select' | 'close'; index?: number; url?: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.context || !handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const action = input.action || 'list';
    if (action === 'new') {
      const page = await handle.context.newPage();
      handles.set(sessionId, { ...handle, page });
      if (input.url) {
        await this.agentNavigate(sessionId, input.url);
      }
    } else if (action === 'select') {
      const page = handle.context.pages()[input.index || 0];
      if (!page) {
        throw new Error('Tab not found.');
      }
      handles.set(sessionId, { ...handle, page });
    } else if (action === 'close') {
      const pages = handle.context.pages();
      const page = pages[input.index ?? pages.indexOf(handle.page)];
      if (!page) {
        throw new Error('Tab not found.');
      }
      await page.close();
      handles.set(sessionId, { ...handle, page: handle.context.pages()[0] || await handle.context.newPage() });
    }
    const updatedHandle = handles.get(sessionId);
    await captureSession(session, updatedHandle?.page || handle.page);
    return {
      session: publicSession(session),
      tabs: handle.context.pages().map((page: any, index: number) => ({
        index,
        url: page.url(),
        active: page === (updatedHandle?.page || handle.page),
      })),
    };
  },

  async stopSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { stopped: false };
    }

    await closeHandle(sessionId);

    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.lastAction = 'stop';
    session.message = 'Browser session stopped. Create a new session to continue browsing.';
    return { stopped: true, session: publicSession(session) };
  },

  async deleteSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      return { deleted: false };
    }

    await closeHandle(sessionId);
    sessions.delete(sessionId);
    return { deleted: true, sessionId };
  },

  async agentStopSession(sessionId: string) {
    await this.getAgentSession(sessionId);
    return this.stopSession(sessionId);
  },

  async stopAllSessions() {
    sessionGeneration += 1;
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      await closeHandle(sessionId);
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'stopped';
        session.updatedAt = new Date().toISOString();
        session.lastAction = 'shutdown';
        session.message = 'Browser session stopped during server shutdown.';
      }
    }));
  },
};

process.once('beforeExit', () => {
  void browserUseService.stopAllSessions();
});
