import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkLaunchedSwitches,
  launchWithSandbox,
  planLaunchFlags,
  readEngineDefaultSwitches,
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
  assert.match(plan.problems[0]!, /could not read the browser engine's default Chrome flags/);
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

/** A Playwright install to launch a real Chromium with, if this machine has one. */
function findPlaywright(): string | null {
  const candidates = [
    path.join(os.homedir(), '.cloudcli', 'browser-use', 'runtime', 'node_modules', 'playwright'),
    '/opt/node-tools/node_modules/playwright',
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'package.json'))) ?? null;
}

const playwrightDirectory = findPlaywright();

test('a real launch gets the planned flags, and one without them is reported', { skip: !playwrightDirectory }, async () => {
  const playwright = createRequire(import.meta.url)(playwrightDirectory!);
  const defaults = readEngineDefaultSwitches(playwrightDirectory);
  assert.ok(defaults && defaults.some((value) => value.startsWith('--disable-features=')), 'the engine\'s defaults are readable');

  const plan = planLaunchFlags(defaults, [], []);
  const launchWith = (options: Record<string, unknown>) => launchWithSandbox<any>('integration-chromium', (sandbox) =>
    playwright.chromium.launch({ ...options, chromiumSandbox: sandbox }));

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
