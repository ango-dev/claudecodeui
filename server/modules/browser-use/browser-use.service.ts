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

import { findPulseAudio, findWindowManager, findXvfb, getAudioServer, getVirtualDisplay, stopVirtualDisplay } from './browser-use-display.js';
import {
  forgetSandboxResults,
  launchWithSandbox,
  planLaunchFlags,
  readEngineDefaultSwitches,
  reportLaunch,
} from './browser-use-launch.js';
import type { LaunchFlagPlan, LaunchReport } from './browser-use-launch.js';
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

/**
 * Whether the browser may draw with the server's GPU. With 'auto', on Linux,
 * Chrome is pointed at the GPU through Vulkan when CloudCLI can open a render
 * device and a Vulkan driver is installed; otherwise WebGL is left to software
 * rendering, which Chrome blocklists, and a browser without WebGL stands out
 * to fingerprinting. 'off' never passes the GPU flags, for a driver that
 * misbehaves. macOS and Windows use the GPU on their own either way.
 */
type BrowserUseGpu = 'auto' | 'off';

/**
 * Audio devices the browser shows pages: none (no sound system on a server),
 * or a silent speaker and microphone from CloudCLI's own PulseAudio. Every
 * desktop has some, so none at all stands out. Linux only.
 */
type BrowserUseAudio = 'none' | 'virtual';

/**
 * The virtual screen as pages see it: plain (no window manager, so the
 * window sits at 0,0 and the usable area is the whole screen), or a desktop
 * with a taskbar and window frames (Fluxbox). Real-window mode on Linux only.
 */
type BrowserUseDesktop = 'plain' | 'taskbar';

type BrowserUseSettings = {
  enabled: boolean;
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  /** Where Chrome is, when it is not in its standard place (e.g. unpacked into a home folder without admin rights). */
  chromePath: string | null;
  display: BrowserUseDisplay;
  gpu: BrowserUseGpu;
  /**
   * The browser's time zone (IANA, e.g. America/Los_Angeles), or null for the
   * server's. Sites compare it with the IP's location; a server's UTC next to
   * a home IP is a classic bot sign.
   */
  timezone: string | null;
  audio: BrowserUseAudio;
  desktop: BrowserUseDesktop;
};

const BROWSER_USE_ENGINES: readonly BrowserUseEngine[] = ['playwright', 'patchright'];

const readEngine = (value: unknown): BrowserUseEngine => (
  BROWSER_USE_ENGINES.includes(value as BrowserUseEngine) ? value as BrowserUseEngine : 'playwright'
);

const readBrowser = (value: unknown): BrowserUseBrowser => (value === 'chrome' ? 'chrome' : 'chromium');

const readDisplay = (value: unknown): BrowserUseDisplay => (value === 'window' ? 'window' : 'headless');

const readGpu = (value: unknown): BrowserUseGpu => (value === 'off' ? 'off' : 'auto');

const readAudio = (value: unknown): BrowserUseAudio => (value === 'virtual' ? 'virtual' : 'none');

const readDesktop = (value: unknown): BrowserUseDesktop => (value === 'taskbar' ? 'taskbar' : 'plain');

/** A time zone Node (and so Chrome's ICU) knows, else null for the server's own. */
const readTimezone = (value: unknown): string | null => {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone || zone.length > 64) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

/** The server's own time zone, which the browser has unless one is set. */
const serverTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const needsAudioServer = (settings: BrowserUseSettings): boolean => (
  settings.audio === 'virtual' && process.platform === 'linux'
);

const needsWindowManager = (settings: BrowserUseSettings): boolean => (
  settings.desktop === 'taskbar' && needsVirtualScreen(settings)
);

/** A program the chosen settings need on the server, installed with the system's package manager. */
type SystemHelper = 'xvfb' | 'pulseaudio' | 'fluxbox';

const SYSTEM_HELPERS: Record<SystemHelper, {
  label: string;
  find: () => string | null;
  needed: (settings: BrowserUseSettings) => boolean;
  packages: { apt: string; dnf: string; pacman: string; zypper: string };
}> = {
  xvfb: {
    label: 'Xvfb',
    find: findXvfb,
    needed: (settings) => needsVirtualScreen(settings),
    packages: { apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb', zypper: 'xorg-x11-server-Xvfb' },
  },
  pulseaudio: {
    label: 'PulseAudio',
    find: findPulseAudio,
    needed: needsAudioServer,
    packages: { apt: 'pulseaudio', dnf: 'pulseaudio', pacman: 'pulseaudio', zypper: 'pulseaudio' },
  },
  fluxbox: {
    label: 'Fluxbox',
    find: findWindowManager,
    needed: needsWindowManager,
    packages: { apt: 'fluxbox', dnf: 'fluxbox', pacman: 'fluxbox', zypper: 'fluxbox' },
  },
};

const SYSTEM_HELPER_IDS = Object.keys(SYSTEM_HELPERS) as SystemHelper[];

/** The helpers these settings need that are not installed. */
const missingHelpers = (settings: BrowserUseSettings): SystemHelper[] => (
  SYSTEM_HELPER_IDS.filter((id) => SYSTEM_HELPERS[id].needed(settings) && !SYSTEM_HELPERS[id].find())
);

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
  /** False while the settings wait on a program the server lacks (Xvfb, PulseAudio, Fluxbox). */
  virtualScreenReady: boolean;
  missingHelpers: SystemHelper[];
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
  gpu: 'auto',
  timezone: null,
  audio: 'none',
  desktop: 'plain',
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
      gpu: readGpu(parsed.gpu),
      timezone: readTimezone(parsed.timezone),
      audio: readAudio(parsed.audio),
      desktop: readDesktop(parsed.desktop),
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
    gpu: readGpu(settings.gpu),
    timezone: readTimezone(settings.timezone),
    audio: readAudio(settings.audio),
    desktop: readDesktop(settings.desktop),
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
    return `Install ${engineName} to use the browser.`;
  }

  if (!readiness.virtualScreenReady) {
    const labels = readiness.missingHelpers.map((id) => SYSTEM_HELPERS[id].label).join(' and ');
    const command = readiness.missingHelpers.map((id) => helperInstallCommand(id)).join(' && ');
    return `Needs ${labels}. Install in Settings -> Browser, or run \`${command}\`.`;
  }

  if (!readiness.chromiumInstalled) {
    return readiness.browser === 'chrome'
      ? 'Google Chrome was not found. Install it, or set its location.'
      : 'Chromium is missing. Press Install Runtime.';
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
    virtualScreenReady: missingHelpers(settings).length === 0,
    missingHelpers: missingHelpers(settings),
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
    && cachedProbe.value.missingHelpers.join() === missingHelpers(settings).join()
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
    return `Needs admin rights. Run \`sudo ${engineCommand(engine)} install-deps chromium\` on the server.`;
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
      return `Installing Chrome needs admin rights. Run \`sudo ${engineCommand(engine)} install chrome\`, or choose Stealth + Chromium.`;
    }
    if (process.platform === 'darwin') {
      return 'Install Chrome from google.com/chrome, or drag Google Chrome.app into ~/Applications.';
    }
    return 'Install Chrome from google.com/chrome.';
  }
  return `If the browser won't start, run \`sudo ${engineCommand(engine)} install-deps chromium\`.`;
}

/**
 * The command that installs Xvfb with the system's package manager, whose
 * package names differ (Debian and Ubuntu: xvfb). Installing system packages
 * needs administrator rights.
 */
/**
 * The install command for a system package under the server's package
 * manager, whose package names differ between distributions.
 */
function packageInstallCommand(names: { apt: string; dnf: string; pacman: string; zypper: string }): string[] {
  const has = (binary: string) => ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some((directory) => fs.existsSync(path.join(directory, binary)));
  if (has('dnf')) return ['dnf', 'install', '-y', ...names.dnf.split(' ')];
  if (has('yum')) return ['yum', 'install', '-y', ...names.dnf.split(' ')];
  if (has('pacman')) return ['pacman', '-S', '--noconfirm', ...names.pacman.split(' ')];
  if (has('zypper')) return ['zypper', '--non-interactive', 'install', ...names.zypper.split(' ')];
  return ['apt-get', 'install', '-y', ...names.apt.split(' ')];
}

/** The command that installs a helper, as shown to run by hand (with sudo). */
function helperInstallCommand(helper: SystemHelper): string {
  return `sudo ${packageInstallCommand(SYSTEM_HELPERS[helper].packages).join(' ')}`;
}

//----------------- GPU ------------

/** What the server offers the browser for drawing with its GPU (Linux). */
type GpuAccess = {
  /** /dev/dri/renderD* devices: one per GPU. None on most VPSes. */
  renderNodes: string[];
  /** CloudCLI's process can open a render device (its user is in the device's group). */
  accessible: boolean;
  /** The user CloudCLI runs as, for the group command. */
  user: string;
  /** The groups that give access: the render devices' group (usually render) and video. */
  groups: string[];
  /** A Vulkan driver (ICD) is installed, which Chrome's Vulkan path needs. */
  vulkanDriver: boolean;
};

const VULKAN_ICD_DIRECTORIES = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d', '/usr/local/share/vulkan/icd.d'];

/** Chrome on the GPU through Vulkan: on Xvfb its OpenGL path is software only. */
const GPU_ARGS = ['--use-angle=vulkan'];
const GPU_FEATURES = ['Vulkan', 'DefaultANGLEVulkan', 'VulkanFromANGLE'];

/**
 * What Playwright and Patchright are assumed to enable by default when their
 * own list cannot be read (see browser-use-launch.ts, which reads it and
 * reports a launch whose flags did not take).
 */
const ENGINE_DEFAULT_FEATURES = ['CDPScreenshotNewSurface'];

function groupName(gid: number): string | null {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((entry) => entry.split(':')[2] === String(gid));
    return line ? line.split(':')[0] : null;
  } catch {
    return null;
  }
}

function readGpuAccess(): GpuAccess {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return process.env.USER || 'your-user';
    }
  })();
  if (process.platform !== 'linux') {
    return { renderNodes: [], accessible: false, user, groups: [], vulkanDriver: false };
  }
  let renderNodes: string[] = [];
  try {
    renderNodes = fs.readdirSync('/dev/dri').filter((name) => /^renderD\d+$/.test(name)).map((name) => `/dev/dri/${name}`);
  } catch {
    // No /dev/dri: no GPU, as on most VPSes.
  }
  const accessible = renderNodes.some((node) => {
    try {
      fs.accessSync(node, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
  const groups = [...new Set([
    ...renderNodes.map((node) => {
      try {
        return groupName(fs.statSync(node).gid);
      } catch {
        return null;
      }
    }).filter((name): name is string => Boolean(name)),
    'video',
  ])];
  const vulkanDriver = VULKAN_ICD_DIRECTORIES.some((directory) => {
    try {
      return fs.readdirSync(directory).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  });
  return { renderNodes, accessible, user, groups, vulkanDriver };
}

/** Whether the GPU flags go to the browser: allowed, and everything they need is there. */
const shouldUseGpu = (settings: BrowserUseSettings, gpu: GpuAccess): boolean => (
  settings.gpu === 'auto' && process.platform === 'linux' && gpu.accessible && gpu.vulkanDriver
);

/** What WebGL reports in the browser as configured: the GPU, a software renderer, or nothing. */
type WebglReport = {
  status: 'hardware' | 'software' | 'unavailable';
  renderer: string | null;
  vendor: string | null;
  webgl2: boolean;
  /** How the check's browser started: its sandbox, and any flag that did not take. */
  launch?: LaunchReport;
};

/** Run in the page: WebGL's renderer as the page sees it (a string, as the server has no DOM types). */
const WEBGL_PROBE_SCRIPT = `(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    renderer: String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
  };
})()`;

const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|softpipe|lavapipe|Software|Basic Render/i;

function classifyWebgl(result: { renderer?: string; vendor?: string; webgl2?: boolean } | null): WebglReport {
  if (!result) {
    return { status: 'unavailable', renderer: null, vendor: null, webgl2: false };
  }
  const renderer = result.renderer ?? null;
  return {
    status: renderer && !SOFTWARE_RENDERER.test(renderer) ? 'hardware' : 'software',
    renderer,
    vendor: result.vendor ?? null,
    webgl2: Boolean(result.webgl2),
  };
}

// ---------------------------


/**
 * Installs Xvfb for the real-window mode: directly when CloudCLI runs as
 * root, else through sudo only where it needs no password (-n never waits
 * for one). Without either it fails with the command to run by hand.
 */
async function installSystemHelper(helper: SystemHelper): Promise<{ success: boolean; message: string }> {
  const { label, find, packages } = SYSTEM_HELPERS[helper];
  if (process.platform !== 'linux') {
    return { success: true, message: `${label} is only needed on Linux.` };
  }
  if (find()) {
    return { success: true, message: `${label} is already installed.` };
  }
  const [manager, ...args] = packageInstallCommand(packages);
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
        ? `Needs admin rights. Run \`${helperInstallCommand(helper)}\` on the server.`
        : `Install failed${detail ? `: ${detail}` : ''}. Run \`${helperInstallCommand(helper)}\` on the server to see why.`,
    };
  } finally {
    runtimeProbeCache = null;
  }
  return find()
    ? { success: true, message: `${label} installed.` }
    : { success: false, message: `${label} was installed but not found. Run \`${helperInstallCommand(helper)}\` on the server.` };
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
    return { success: false, message: 'Another install is running. Try again in a moment.' };
  }
  const engineName = engine === 'patchright' ? 'Patchright' : 'Playwright';
  if (engine === settings.engine && (part === 'engine' || settings.browser === 'chromium')) {
    return { success: false, message: `${engineName} is in use. Switch to another engine or browser first.` };
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

/**
 * How a browser is started for these settings: headless or with a real
 * window (on Linux on CloudCLI's Xvfb), real Chrome where chosen, and on the
 * GPU where it can be reached. Shared by agent sessions and the WebGL check,
 * so the check sees exactly what a session would.
 */
async function buildLaunchOptions(settings: BrowserUseSettings, readiness: RuntimeReadiness) {
  const withWindow = settings.display === 'window';
  const withTaskbar = needsWindowManager(settings);
  const useGpu = shouldUseGpu(settings, readGpuAccess());
  const env: Record<string, string> = {};
  // On Linux the window goes on CloudCLI's Xvfb, never on a desktop.
  if (needsVirtualScreen(settings)) {
    const { display, xauthority } = await getVirtualDisplay({ windowManager: withTaskbar });
    env.DISPLAY = display;
    env.XAUTHORITY = xauthority;
  }
  if (needsAudioServer(settings)) {
    env.PULSE_SERVER = await getAudioServer();
  }
  // The process's own time zone: Date and Intl read it natively. Chrome on
  // macOS and Windows ignores TZ, so there the page is told instead.
  if (settings.timezone) {
    env.TZ = settings.timezone;
  }
  // The engine's own default switches, changed where CloudCLI needs to: its
  // feature lists are replaced whole, and each launch is checked afterwards.
  const flagPlan = planLaunchFlags(
    readEngineDefaultSwitches(resolveEnginePackage(settings.engine)),
    useGpu ? GPU_FEATURES : [],
    ENGINE_DEFAULT_FEATURES,
  );
  const launchOptions = {
    headless: !withWindow,
    args: [
      '--disable-dev-shm-usage',
      // With a taskbar the window opens maximized, as most desktop windows
      // are; without a window manager there is nothing to maximize into.
      ...(withWindow && withTaskbar ? ['--start-maximized'] : []),
      ...(withWindow && !withTaskbar
        ? [`--window-size=${BROWSER_WINDOW_SIZE.width},${BROWSER_WINDOW_SIZE.height}`, '--window-position=0,0']
        : []),
      ...(useGpu ? GPU_ARGS : []),
      ...flagPlan.args,
    ],
    ...(flagPlan.ignoreDefaultArgs.length > 0 ? { ignoreDefaultArgs: flagPlan.ignoreDefaultArgs } : {}),
    // Real Chrome, where chosen: readiness found it in its standard place or
    // at the location set in Settings.
    ...(settings.browser === 'chrome' && readiness.chromiumExecutablePath
      ? { executablePath: readiness.chromiumExecutablePath }
      : {}),
    ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
  };
  const contextOptions = {
    // A real window keeps its own size: an emulated viewport inside it
    // would differ from the window, which pages can notice.
    viewport: withWindow ? null : { width: 1440, height: 900 },
    serviceWorkers: 'block',
    ...(settings.timezone && process.platform !== 'linux' ? { timezoneId: settings.timezone } : {}),
  };
  // Which browser binary this is, for remembering where the sandbox fails.
  const browserKey = launchOptions.executablePath ?? `${settings.engine}-chromium`;
  return { launchOptions, contextOptions, flagPlan, browserKey };
}

/** The last browser launch's report, for Settings; null until one has started. */
let lastLaunchReport: LaunchReport | null = null;

/**
 * Starts a browser for a session or the WebGL check: sandboxed where Chrome
 * allows it, then checked against the launch's flag plan. The report is kept
 * for Settings and returned so the caller can pass any warning on.
 */
async function launchChecked<T>(
  launchOptions: Record<string, unknown>,
  flagPlan: LaunchFlagPlan,
  browserKey: string,
  launch: (options: Record<string, unknown>) => Promise<T>,
  browserOf: (launched: T) => any,
): Promise<{ launched: T; report: LaunchReport }> {
  const { result, ...sandbox } = await launchWithSandbox(browserKey, (useSandbox) => launch({
    ...launchOptions,
    chromiumSandbox: useSandbox,
  }));
  const report = await reportLaunch(browserOf(result), flagPlan, sandbox);
  lastLaunchReport = report;
  if (report.warnings.length > 0) {
    console.warn('[Browser] Chrome did not start as planned:', report.warnings.join(' '));
  }
  return { launched: result, report };
}

/** One line for the agent and the user when a launch's flags did not all take. */
function launchWarningText(report: LaunchReport): string | null {
  return report.warnings.length > 0
    ? `Warning: ${report.warnings.join(' ')} The browser engine may have changed how it starts Chrome; ask to have CloudCLI updated.`
    : null;
}

/**
 * Starts a throwaway browser as a session would and reads what WebGL reports
 * there, for Settings' WebGL check. Counted as a launch, so the virtual
 * screen stays up for it.
 */
async function probeWebgl(settings: BrowserUseSettings, readiness: RuntimeReadiness): Promise<WebglReport> {
  let browser: any;
  launchesInProgress += 1;
  try {
    const { launchOptions, contextOptions, flagPlan, browserKey } = await buildLaunchOptions(settings, readiness);
    const { launched, report } = await launchChecked(
      launchOptions,
      flagPlan,
      browserKey,
      (options) => readiness.playwright.chromium.launch(options),
      (launchedBrowser) => launchedBrowser,
    );
    browser = launched;
    const page = await (await browser.newContext(contextOptions)).newPage();
    await page.setContent('<!doctype html><title>WebGL check</title>');
    return { ...classifyWebgl(await page.evaluate(WEBGL_PROBE_SCRIPT)), launch: report };
  } finally {
    await browser?.close().catch(() => undefined);
    launchesInProgress -= 1;
    releaseVirtualScreenIfUnused();
  }
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
      gpu: settings.gpu === undefined ? current.gpu : readGpu(settings.gpu),
      timezone: settings.timezone === undefined ? current.timezone : readTimezone(settings.timezone),
      audio: settings.audio === undefined ? current.audio : readAudio(settings.audio),
      desktop: settings.desktop === undefined ? current.desktop : readDesktop(settings.desktop),
    };

    const next = writeSettings(nextSettings);
    if (
      next.engine !== current.engine
      || next.browser !== current.browser
      || next.chromePath !== current.chromePath
      || next.display !== current.display
      || next.gpu !== current.gpu
      || next.timezone !== current.timezone
      || next.audio !== current.audio
      || next.desktop !== current.desktop
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
      // How the last browser started: its sandbox, and any flag that did not take.
      launch: lastLaunchReport,
      isAdministrator: isAdministrator(),
      platform: process.platform,
      engineCommand: engineCommand(settings.engine),
      display: settings.display,
      timezone: settings.timezone,
      serverTimezone: serverTimezone(),
      audio: settings.audio,
      desktop: settings.desktop,
      // The programs the settings can need, for Settings' install notices and chips.
      helpers: SYSTEM_HELPER_IDS.map((id) => ({
        id,
        label: SYSTEM_HELPERS[id].label,
        required: SYSTEM_HELPERS[id].needed(settings),
        installed: Boolean(SYSTEM_HELPERS[id].find()),
        installCommand: process.platform === 'linux' ? helperInstallCommand(id) : null,
      })),
      gpu: (() => {
        const access = readGpuAccess();
        return {
          setting: settings.gpu,
          ...access,
          inUse: shouldUseGpu(settings, access),
          groupCommand: `sudo usermod -aG ${access.groups.join(',') || 'render,video'} ${access.user}`,
          vulkanInstallCommand: process.platform === 'linux'
            ? `sudo ${packageInstallCommand({
              apt: 'mesa-vulkan-drivers',
              dnf: 'mesa-vulkan-drivers',
              pacman: 'vulkan-radeon vulkan-intel',
              zypper: 'libvulkan_radeon libvulkan_intel',
            }).join(' ')}`
            : null,
        };
      })(),
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
    // Old names everywhere; the current one too, so agents hidden since the
    // last registration keep no entry (it is added back only where shown).
    await Promise.all([...LEGACY_MCP_SERVER_NAMES, MCP_SERVER_NAME].map((name) => removeMcpServerFromAllProviders(name)));
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

  /** Settings' WebGL check: starts a browser as configured and reports what WebGL shows. */
  async checkGraphics(): Promise<WebglReport> {
    const settings = readSettings();
    const readiness = getRuntimeReadiness();
    if (!readiness.playwright || !readiness.chromiumInstalled || !readiness.virtualScreenReady) {
      throw new Error(getSetupMessage({ ...settings, enabled: true }, readiness));
    }
    return probeWebgl(settings, readiness);
  },

  async installSystemHelper(helper: string) {
    const result = SYSTEM_HELPER_IDS.includes(helper as SystemHelper)
      ? await installSystemHelper(helper as SystemHelper)
      : { success: false, message: 'Unknown program.' };
    return { ...result, status: await this.getStatus() };
  },

  async removeRuntime(engine: BrowserUseEngine, part: 'engine' | 'chromium') {
    const result = await removeRuntime(readEngine(engine), part, readSettings());
    // A different browser build may refuse or accept the sandbox differently.
    forgetSandboxResults();
    lastLaunchReport = null;
    return { ...result, status: await this.getStatus() };
  },

  async installRuntime() {
    const result = await installRuntime(readSettings());
    forgetSandboxResults();
    lastLaunchReport = null;
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
    let launchReport: LaunchReport | null = null;
    launchesInProgress += 1;

    try {
      const { launchOptions, contextOptions, flagPlan, browserKey } = await buildLaunchOptions(settings, readiness);
      if (profileName) {
        fs.mkdirSync(PROFILE_ROOT, { recursive: true });
        const started = await launchChecked(
          launchOptions,
          flagPlan,
          browserKey,
          (options) => readiness.playwright.chromium.launchPersistentContext(getProfilePath(profileName), {
            ...options,
            ...contextOptions,
          }),
          (persistentContext: any) => persistentContext.browser(),
        );
        context = started.launched;
        launchReport = started.report;
        page = context.pages()[0] || await context.newPage();
      } else {
        const started = await launchChecked(
          launchOptions,
          flagPlan,
          browserKey,
          (options) => readiness.playwright.chromium.launch(options),
          (launchedBrowser) => launchedBrowser,
        );
        browser = started.launched;
        launchReport = started.report;
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
      throw new Error('Settings changed while the browser was starting. Try again.');
    }
    session.status = 'ready';
    // A flag that did not take is said here, where the agent will pass it on.
    const launchWarning = launchReport ? launchWarningText(launchReport) : null;
    session.message = launchWarning ? `Browser session is ready. ${launchWarning}` : 'Browser session is ready.';
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
