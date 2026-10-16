import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkLaunchedSwitches,
  launchWithSandbox,
  learnEngineDefaultSwitches,
  planLaunchFlags,
  reportLaunch,
  REENABLED_FEATURES,
} from '@/modules/browser-use/browser-use-launch.js';

/**
 * CloudCLI changes a few of the engine's default Chrome switches. Playwright
 * only allows that by naming each default exactly, and a name that no longer
 * matches is silently ignored, so every launch is checked afterwards and a
 * change that did not take is reported rather than passed over.
 */

const DEFAULTS = [
  '--disable-field-trial-config',
  '--disable-features=AcceptCHFrame,HttpsUpgrades,MediaRouter,ThirdPartyStoragePartitioning,Translate',
  '--enable-features=CDPScreenshotNewSurface',
  '--no-first-run',
];

test('the re-enabled features come out of the engine\'s --disable-features, which is replaced whole', () => {
  const plan = planLaunchFlags(DEFAULTS, [], ['CDPScreenshotNewSurface']);

  assert.deepEqual(plan.ignoreDefaultArgs, [DEFAULTS[1]]);
  assert.deepEqual(plan.args, ['--disable-features=AcceptCHFrame,MediaRouter,Translate']);
  assert.deepEqual(plan.expectNotDisabled, REENABLED_FEATURES);
  assert.deepEqual(plan.expectEnabled, ['CDPScreenshotNewSurface'], 'the engine\'s own features must stay on');
  assert.deepEqual(plan.problems, []);
});

test('GPU features join the engine\'s --enable-features in one switch', () => {
  const plan = planLaunchFlags(DEFAULTS, ['Vulkan', 'DefaultANGLEVulkan'], ['CDPScreenshotNewSurface']);

  assert.ok(plan.ignoreDefaultArgs.includes('--enable-features=CDPScreenshotNewSurface'));
  assert.ok(plan.args.includes('--enable-features=CDPScreenshotNewSurface,Vulkan,DefaultANGLEVulkan'));
  assert.deepEqual(plan.expectEnabled, ['CDPScreenshotNewSurface', 'Vulkan', 'DefaultANGLEVulkan']);
});

test('defaults that cannot be read keep the old GPU handling and say so', () => {
  const plan = planLaunchFlags(null, ['Vulkan'], ['CDPScreenshotNewSurface']);

  assert.deepEqual(plan.ignoreDefaultArgs, ['--enable-features=CDPScreenshotNewSurface']);
  assert.deepEqual(plan.args, ['--enable-features=CDPScreenshotNewSurface,Vulkan']);
  assert.deepEqual(plan.expectNotDisabled, [], 'nothing was re-enabled, so nothing is expected');
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0]!, /could not learn the browser engine's default Chrome flags/);
});

test('the check reads the last of each repeated switch, as Chrome does', () => {
  const plan = planLaunchFlags(DEFAULTS, ['Vulkan'], []);
  const asPlanned = ['chrome', DEFAULTS[0]!, '--no-first-run', ...plan.args];
  assert.deepEqual(checkLaunchedSwitches(asPlanned, plan), []);

  // The engine's switch text changed, so leaving it out matched nothing and it
  // came last: Chrome kept it, with the features still off and the GPU lost.
  const engineChanged = ['chrome', ...plan.args, '--disable-features=HttpsUpgrades,ThirdPartyStoragePartitioning,Other', '--enable-features=CDPScreenshotNewSurface'];
  assert.deepEqual(checkLaunchedSwitches(engineChanged, plan), [
    'Chrome started without Vulkan turned on.',
    'Chrome started with HttpsUpgrades still turned off.',
    'Chrome started with ThirdPartyStoragePartitioning still turned off.',
  ]);
});

test('the sandbox is tried first, and a refusal is remembered for the next launch', async () => {
  const runAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const attempts: boolean[] = [];
  const refusingLaunch = async (sandbox: boolean) => {
    attempts.push(sandbox);
    if (sandbox) throw new Error('browserType.launch: Chromium sandboxing failed!');
    return 'browser';
  };

  const first = await launchWithSandbox('test-browser', refusingLaunch);
  assert.equal(first.result, 'browser');
  assert.equal(first.sandbox, false);
  assert.match(first.sandboxReason ?? '', runAsRoot ? /runs as root/ : /could not start its sandbox/);
  assert.deepEqual(attempts, runAsRoot ? [false] : [true, false]);

  attempts.length = 0;
  await launchWithSandbox('test-browser', refusingLaunch);
  assert.deepEqual(attempts, [false], 'the refusal is not retried');

  // Any other launch failure is not about the sandbox and is not hidden.
  if (!runAsRoot) {
    await assert.rejects(
      launchWithSandbox('other-browser', async () => { throw new Error('Executable doesn\'t exist'); }),
      /Executable doesn't exist/,
    );
  }
});

test('the engine\'s defaults are learned from a plain launch, once per key; a failure is not kept', async () => {
  let launches = 0;
  const fakeBrowser = (args: string[]) => ({
    newBrowserCDPSession: async () => ({
      send: async () => ({ arguments: args }),
      detach: async () => undefined,
    }),
    close: async () => undefined,
  });
  const launchPlain = async () => {
    launches += 1;
    return fakeBrowser(['/usr/bin/chrome', '--disable-features=HttpsUpgrades', 'about:blank']);
  };

  assert.deepEqual(await learnEngineDefaultSwitches('engine@1|chromium', launchPlain), ['--disable-features=HttpsUpgrades']);
  await learnEngineDefaultSwitches('engine@1|chromium', launchPlain);
  assert.equal(launches, 1, 'learned once for the same engine and browser');
  await learnEngineDefaultSwitches('engine@2|chromium', launchPlain);
  assert.equal(launches, 2, 'learned again after an engine update');

  let attempts = 0;
  const failing = async () => { attempts += 1; throw new Error('no browser'); };
  assert.equal(await learnEngineDefaultSwitches('broken@1|chromium', failing), null);
  assert.equal(await learnEngineDefaultSwitches('broken@1|chromium', failing), null);
  assert.equal(attempts, 2, 'a failure is tried again next time');
});

/**
 * Engine installs to launch a real browser with, where this machine has them:
 * the runtime CloudCLI installs, Playwright from the container's tools, and
 * any extra engine folders listed in BROWSER_USE_TEST_ENGINES (comma-separated,
 * each optionally `folder=chrome-executable`, for an engine whose own Chromium
 * build is not installed).
 */
function findEngines(): Array<{ directory: string; executablePath?: string }> {
  const candidates: Array<{ directory: string; executablePath?: string }> = [
    { directory: path.join(os.homedir(), '.cloudcli', 'browser-use', 'runtime', 'node_modules', 'playwright') },
    { directory: path.join(os.homedir(), '.cloudcli', 'browser-use', 'runtime', 'node_modules', 'patchright') },
    { directory: '/opt/node-tools/node_modules/playwright' },
    ...(process.env.BROWSER_USE_TEST_ENGINES ?? '').split(',').filter(Boolean).map((entry) => {
      const [directory, executablePath] = entry.split('=');
      return { directory: directory!, executablePath };
    }),
  ];
  return candidates.filter((candidate) => fs.existsSync(path.join(candidate.directory, 'package.json')));
}

for (const engine of findEngines()) {
  const name = `${path.basename(engine.directory)} ${JSON.parse(fs.readFileSync(path.join(engine.directory, 'package.json'), 'utf8')).version}`;

  test(`${name}: a real launch gets the planned flags, and one without them is reported`, async () => {
    const playwright = createRequire(import.meta.url)(engine.directory);
    const launchWith = (options: Record<string, unknown>) => launchWithSandbox<any>(`integration-${name}`, (sandbox) =>
      playwright.chromium.launch({
        ...options,
        chromiumSandbox: sandbox,
        ...(engine.executablePath ? { executablePath: engine.executablePath } : {}),
      }));

    const defaults = await learnEngineDefaultSwitches(`integration-${name}`, async () => (await launchWith({})).result);
    assert.ok(defaults?.some((value) => value.startsWith('--disable-features=')), 'the engine\'s defaults are learned');

    const plan = planLaunchFlags(defaults, [], []);
    const planned = await launchWith({ args: plan.args, ignoreDefaultArgs: plan.ignoreDefaultArgs });
    try {
      const report = await reportLaunch(planned.result, plan, planned);
      assert.deepEqual(report.warnings, [], 'HTTPS-Upgrades and storage partitioning are on');
    } finally {
      await planned.result.close();
    }

    // Chrome as the engine starts it: the changes did not take, and the check says so.
    const unchanged = await launchWith({});
    try {
      const report = await reportLaunch(unchanged.result, plan, unchanged);
      assert.deepEqual(report.warnings, [
        'Chrome started with HttpsUpgrades still turned off.',
        'Chrome started with ThirdPartyStoragePartitioning still turned off.',
      ]);
    } finally {
      await unchanged.result.close();
    }
  });
}
