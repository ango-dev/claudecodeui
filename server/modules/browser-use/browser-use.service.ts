import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { getModuleDirectory } from '@/shared/utils.js';

import { getBrowserUseRuntime } from './browser-use-runtime.js';

const require = createRequire(import.meta.url);
const __dirname = getModuleDirectory(import.meta.url);
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

type BrowserUseSettings = {
  enabled: boolean;
  engine: BrowserUseEngine;
  browser: BrowserUseBrowser;
  /** Where Chrome is, when it is not in its standard place (e.g. unpacked into a home folder without admin rights). */
  chromePath: string | null;
};

const BROWSER_USE_ENGINES: readonly BrowserUseEngine[] = ['playwright', 'patchright'];

const readEngine = (value: unknown): BrowserUseEngine => (
  BROWSER_USE_ENGINES.includes(value as BrowserUseEngine) ? value as BrowserUseEngine : 'playwright'
);

const readBrowser = (value: unknown): BrowserUseBrowser => (value === 'chrome' ? 'chrome' : 'chromium');

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
};
const AGENT_OWNER_ID = 'agent';
const PROFILE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use', 'profiles');
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

  if (!readiness.chromiumInstalled) {
    return readiness.browser === 'chrome'
      ? `${engineName} is installed, but Google Chrome was not found. Install Chrome (this needs administrator rights), or set where it is.`
      : `${engineName} is installed, but Chromium is missing. Install the Chromium runtime to continue.`;
  }

  return readiness.installMessage || 'Browser runtime is not ready.';
}

function loadEngine(engine: BrowserUseEngine): any | null {
  try {
    // Patchright is a drop-in fork: the same API under another package name.
    return require(engine);
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

function probeRuntime(settings: BrowserUseSettings): RuntimeProbe {
  const { engine, browser } = settings;
  const playwright = loadEngine(engine);
  const readiness: RuntimeProbe = {
    engine,
    browser,
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

  try {
    const executablePath = playwright.chromium.executablePath();
    readiness.chromiumExecutablePath = executablePath;
    readiness.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
  } catch {
    readiness.chromiumInstalled = false;
  }

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
      cwd: process.cwd(),
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

function formatInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('sudo') && message.includes('password')) {
    return 'Installing Chromium system dependencies requires administrator privileges. Run `npx playwright install-deps chromium` (or `npx patchright install-deps chromium`) on the machine where CloudCLI runs, then try again.';
  }
  return message || 'Failed to install Browser runtime.';
}

/** True when this process can install system packages itself (root on Linux and macOS). */
const isAdministrator = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * The commands that need administrator rights, for the message shown when an
 * install step could not run without them. Run in CloudCLI's folder.
 */
function adminInstructions(engine: BrowserUseEngine, browser: BrowserUseBrowser): string {
  if (browser === 'chrome') {
    if (process.platform === 'linux') {
      return `Installing Google Chrome needs administrator rights. Run \`sudo npx ${engine} install chrome\` in CloudCLI's folder, or install Chrome from google.com/chrome. Without admin rights, unpack Chrome into your home folder and set its location here, or choose Stealth with Chromium.`;
    }
    if (process.platform === 'darwin') {
      return 'Installing Google Chrome needs an administrator password. Install Chrome from google.com/chrome, or drag Google Chrome.app into Applications in your home folder (no admin rights needed), then check again.';
    }
    return 'Install Google Chrome from google.com/chrome. Run without administrator rights, its installer puts Chrome in your user folder, which CloudCLI finds.';
  }
  return `Chromium is installed, but Linux may need its system libraries, which only an administrator can add: \`sudo npx ${engine} install-deps chromium\` in CloudCLI's folder.`;
}

async function installRuntime(settings: BrowserUseSettings): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return installPromise;
  }

  const { engine, browser } = settings;
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // Each engine has its own package and its own Chromium build, installed
  // through its own CLI (Patchright's is Playwright's under another name).
  const engineName = engine === 'patchright' ? 'Patchright' : 'Playwright';
  runtimeProbeCache = null;
  installPromise = (async () => {
    try {
      lastInstallMessage = `Installing ${engineName} package...`;
      await runCommand(npmCommand, ['install', '--no-save', '--no-package-lock', engine]);

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
          await runCommand(npmCommand, ['exec', '--', engine, 'install', 'chrome']);
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
        await runCommand(npmCommand, ['exec', '--', engine, 'install-deps', 'chromium']);
      }

      lastInstallMessage = 'Installing Chromium runtime...';
      await runCommand(npmCommand, ['exec', '--', engine, 'install', 'chromium']);

      lastInstallMessage = needsDeps && !isAdministrator()
        ? `Browser runtime installed. ${adminInstructions(engine, browser)}`
        : 'Browser runtime installed.';
      return { success: true, message: lastInstallMessage };
    } catch (error) {
      lastInstallMessage = formatInstallError(error);
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

async function closeHandle(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  handles.delete(sessionId);
  await handle?.context?.close?.().catch(() => undefined);
  await handle?.browser?.close().catch(() => undefined);
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
  session.viewport = page.viewportSize?.() || session.viewport;
  session.updatedAt = new Date().toISOString();
}

type ClickTarget = { ref?: string; selector?: string; text?: string; role?: string; name?: string; x?: number; y?: number };

/**
 * An element reference from browser_snapshot ("e12"; "[ref=e12]" and "@e12"
 * are accepted too), checked so nothing else reaches the locator engine.
 */
function readRef(ref: string): string {
  const match = /^(?:\[ref=|@)?(e\d+)\]?$/.exec(ref.trim());
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
 * The page's accessibility tree with element references, as Playwright's
 * agent tooling produces it; a tree without references where the installed
 * Playwright predates that mode.
 */
async function readAgentSnapshot(page: any): Promise<string> {
  try {
    if (typeof page.ariaSnapshot === 'function') {
      return await page.ariaSnapshot({ mode: 'ai', timeout: 5_000 });
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

  const box = await locator.boundingBox().catch(() => null);
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
    };

    const next = writeSettings(nextSettings);
    if (next.engine !== current.engine || next.browser !== current.browser || next.chromePath !== current.chromePath) {
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
    const available = settings.enabled && readiness.playwrightInstalled && readiness.chromiumInstalled;

    return {
      enabled: settings.enabled,
      engine: settings.engine,
      browser: settings.browser,
      browserExecutablePath: readiness.chromiumExecutablePath,
      isAdministrator: isAdministrator(),
      platform: process.platform,
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
    if (activeOwnerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active agent sessions.`);
    }

    const readiness = getRuntimeReadiness();
    if (!settings.enabled || !readiness.playwrightInstalled || !readiness.chromiumInstalled || !readiness.playwright) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    let browser: any | undefined;
    let context: any | undefined;
    let page: any;
    const launchOptions = {
      headless: true,
      args: ['--disable-dev-shm-usage'],
      // Real Chrome, where chosen: readiness found it in its standard place or
      // at the location set in Settings.
      ...(settings.browser === 'chrome' && readiness.chromiumExecutablePath
        ? { executablePath: readiness.chromiumExecutablePath }
        : {}),
    };
    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    };

    try {
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
    const point = await getActionPoint(handle.page, input);

    const target = resolveTarget(handle.page, input);
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
      await resolveTarget(handle.page, { ref: input.ref, selector: input.selector }).fill(input.text, { timeout: 10_000 });
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
      const target = resolveTarget(handle.page, { ref: field.ref, selector: field.selector });
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
    const locator = resolveTarget(handle.page, target);
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
