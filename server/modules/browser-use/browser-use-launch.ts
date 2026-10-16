import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * How CloudCLI starts Chrome differently from the engine's defaults, and the
 * check that a launch really got those changes.
 *
 * Playwright (and Patchright) start Chrome with a fixed list of switches.
 * CloudCLI changes a few of them, which Playwright only allows by naming the
 * exact default switch to leave out. That text changes between engine
 * versions, and a name that no longer matches is silently ignored. So the
 * defaults are read from the installed engine itself, and every launch reads
 * back the command line Chrome actually got: anything that did not take is
 * reported as a warning in Settings and to the agent, never passed over.
 */

/**
 * Features Playwright turns off that a person's Chrome has on. Turned back on
 * so a page cannot notice them missing.
 */
export const REENABLED_FEATURES = ['HttpsUpgrades', 'ThirdPartyStoragePartitioning'];

/** Switches to change for one launch, and what Chrome's command line must show afterwards. */
export type LaunchFlagPlan = {
  /** The engine's default switches to leave out, by their exact text. */
  ignoreDefaultArgs: string[];
  /** CloudCLI's replacements, added to the launch's own args. */
  args: string[];
  /** Features that must be on in the launched Chrome. */
  expectEnabled: string[];
  /** Features that must not be off in the launched Chrome. */
  expectNotDisabled: string[];
  /** Problems found before launch, reported with the launch's own. */
  problems: string[];
};

/** What the last launch ran with: the sandbox, and any change that did not take. */
export type LaunchReport = {
  sandbox: 'on' | 'off';
  /** Why the sandbox is off; null while it is on. */
  sandboxReason: string | null;
  warnings: string[];
  checkedAt: string;
};

const ENABLE_FEATURES = '--enable-features=';
const DISABLE_FEATURES = '--disable-features=';

/** Feature names in a feature switch, without field-trial or parameter suffixes. */
function featureNames(switchValue: string): string[] {
  return switchValue
    .split(',')
    .map((feature) => feature.trim().split(/[<:]/)[0] ?? '')
    .filter(Boolean);
}

/**
 * The switches the installed engine starts Chrome with, read from its own
 * code, or null when that code is not where it used to be. Patchright is a
 * fork with the same layout under its own names.
 */
export function readEngineDefaultSwitches(enginePackageDirectory: string | null): string[] | null {
  if (!enginePackageDirectory) {
    return null;
  }
  try {
    const engineManifest = JSON.parse(fs.readFileSync(path.join(enginePackageDirectory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const coreName = Object.keys(engineManifest.dependencies ?? {}).find((name) => name.endsWith('-core'));
    if (!coreName) {
      return null;
    }
    const requireFromEngine = createRequire(path.join(enginePackageDirectory, 'package.json'));
    const coreDirectory = path.dirname(requireFromEngine.resolve(`${coreName}/package.json`));
    // Required by file path: the package's export map does not list it.
    const switchesModule = requireFromEngine(path.join(coreDirectory, 'lib', 'server', 'chromium', 'chromiumSwitches.js')) as {
      chromiumSwitches?: (assistantMode?: boolean, channel?: string) => unknown;
    };
    const switches = switchesModule.chromiumSwitches?.(false, undefined);
    return Array.isArray(switches) && switches.every((value) => typeof value === 'string')
      ? (switches as string[]).filter(Boolean)
      : null;
  } catch {
    return null;
  }
}

/**
 * Plans one launch's switch changes from the engine's defaults: the
 * re-enabled features come out of its --disable-features, and GPU features
 * join its --enable-features in a single switch. Chrome keeps only the last
 * of a repeated switch, so each default is left out and replaced whole.
 * `fallbackEnabled` is what the engine is assumed to enable when its defaults
 * cannot be read.
 */
export function planLaunchFlags(
  defaults: string[] | null,
  gpuFeatures: string[],
  fallbackEnabled: string[],
): LaunchFlagPlan {
  const plan: LaunchFlagPlan = { ignoreDefaultArgs: [], args: [], expectEnabled: [], expectNotDisabled: [], problems: [] };

  if (!defaults) {
    plan.problems.push(
      "CloudCLI could not read the browser engine's default Chrome flags, so HTTPS-Upgrades and third-party storage partitioning stay off.",
    );
  }

  const theirDisable = defaults?.find((value) => value.startsWith(DISABLE_FEATURES));
  if (theirDisable) {
    const kept = featureNames(theirDisable.slice(DISABLE_FEATURES.length))
      .filter((feature) => !REENABLED_FEATURES.includes(feature));
    plan.ignoreDefaultArgs.push(theirDisable);
    if (kept.length > 0) {
      plan.args.push(`${DISABLE_FEATURES}${kept.join(',')}`);
    }
  }
  if (defaults) {
    plan.expectNotDisabled.push(...REENABLED_FEATURES);
  }

  const theirEnable = defaults
    ? defaults.find((value) => value.startsWith(ENABLE_FEATURES))
    : `${ENABLE_FEATURES}${fallbackEnabled.join(',')}`;
  const theirEnabled = theirEnable ? featureNames(theirEnable.slice(ENABLE_FEATURES.length)) : [];
  if (gpuFeatures.length > 0) {
    if (theirEnable) {
      plan.ignoreDefaultArgs.push(theirEnable);
    }
    plan.args.push(`${ENABLE_FEATURES}${[...theirEnabled, ...gpuFeatures].join(',')}`);
  }
  plan.expectEnabled.push(...theirEnabled, ...gpuFeatures);

  return plan;
}

/** Compares a launched Chrome's command line with the plan; returns one sentence per change that did not take. */
export function checkLaunchedSwitches(commandLine: string[], plan: LaunchFlagPlan): string[] {
  // Chrome keeps the last of a repeated switch.
  const lastFeatures = (prefix: string) => {
    for (let index = commandLine.length - 1; index >= 0; index -= 1) {
      const value = commandLine[index] ?? '';
      if (value.startsWith(prefix)) {
        return featureNames(value.slice(prefix.length));
      }
    }
    return [];
  };
  const enabled = lastFeatures(ENABLE_FEATURES);
  const disabled = lastFeatures(DISABLE_FEATURES);
  return [
    ...plan.expectEnabled
      .filter((feature) => !enabled.includes(feature))
      .map((feature) => `Chrome started without ${feature} turned on.`),
    ...plan.expectNotDisabled
      .filter((feature) => disabled.includes(feature))
      .map((feature) => `Chrome started with ${feature} still turned off.`),
  ];
}

function readProcessCommandLine(pid: number): Promise<string[] | null> {
  if (process.platform === 'linux') {
    try {
      return Promise.resolve(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean));
    } catch {
      return Promise.resolve(null);
    }
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('ps', ['-ww', '-o', 'args=', '-p', String(pid)], (error, stdout) => {
        // Feature lists contain no spaces, so splitting on them is enough here.
        resolve(error ? null : stdout.trim().split(/\s+/).filter(Boolean));
      });
    });
  }
  return Promise.resolve(null);
}

/**
 * The switches a launched Chrome is running with, or null when they cannot
 * be read. Asks Chrome first; Patchright drops the switch that answer needs,
 * so it falls back to the browser process's own command line.
 */
export async function readBrowserCommandLine(browser: any): Promise<string[] | null> {
  let session: any;
  try {
    session = await browser?.newBrowserCDPSession?.();
  } catch {
    return null;
  }
  if (!session) {
    return null;
  }
  try {
    try {
      const reply = await session.send('Browser.getBrowserCommandLine');
      if (Array.isArray(reply?.arguments)) {
        return reply.arguments as string[];
      }
    } catch {
      // Only answered while --enable-automation is set.
    }
    try {
      const info = await session.send('SystemInfo.getProcessInfo');
      const browserProcess = (info?.processInfo as Array<{ type?: string; id?: number }> | undefined)
        ?.find((entry) => entry.type === 'browser');
      return browserProcess?.id ? await readProcessCommandLine(browserProcess.id) : null;
    } catch {
      return null;
    }
  } finally {
    await session.detach?.().catch(() => undefined);
  }
}

/** Why the sandbox is off for a browser, by executable, once Chrome has refused it there. */
const sandboxUnavailable = new Map<string, string>();

/** Forgets what was learned about the sandbox; for a reinstalled or removed runtime. */
export function forgetSandboxResults(): void {
  sandboxUnavailable.clear();
}

/**
 * Starts the browser with Chrome's sandbox on, which Playwright otherwise
 * turns off. Where Chrome cannot use it, the browser starts without it
 * rather than not at all, and the reason is kept so later launches skip
 * straight to that:
 *
 * - CloudCLI runs as root: Chrome refuses to sandbox a root browser.
 * - The system will not let it sandbox. Ubuntu 23.10 and later, for one,
 *   block it for Playwright's own Chromium; Google Chrome usually works.
 */
export async function launchWithSandbox<T>(
  browserKey: string,
  launch: (sandbox: boolean) => Promise<T>,
): Promise<{ result: T; sandbox: boolean; sandboxReason: string | null }> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return {
      result: await launch(false),
      sandbox: false,
      sandboxReason: 'CloudCLI runs as root, and Chrome will not sandbox a browser run as root.',
    };
  }
  const knownReason = sandboxUnavailable.get(browserKey);
  if (knownReason) {
    return { result: await launch(false), sandbox: false, sandboxReason: knownReason };
  }
  try {
    return { result: await launch(true), sandbox: true, sandboxReason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/sandbox/i.test(message)) {
      throw error;
    }
    const reason = 'Chrome could not start its sandbox on this system.';
    sandboxUnavailable.set(browserKey, reason);
    return { result: await launch(false), sandbox: false, sandboxReason: reason };
  }
}

/** The report for a launch: its sandbox, plus every planned change the launched Chrome does not show. */
export async function reportLaunch(
  browser: any,
  plan: LaunchFlagPlan,
  sandbox: { sandbox: boolean; sandboxReason: string | null },
): Promise<LaunchReport> {
  const warnings = [...plan.problems];
  const commandLine = await readBrowserCommandLine(browser);
  if (!commandLine) {
    warnings.push('CloudCLI could not read the flags Chrome started with, so it could not check them.');
  } else {
    warnings.push(...checkLaunchedSwitches(commandLine, plan));
  }
  return {
    sandbox: sandbox.sandbox ? 'on' : 'off',
    sandboxReason: sandbox.sandboxReason,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}
