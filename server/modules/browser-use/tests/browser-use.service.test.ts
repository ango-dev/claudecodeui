import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'browser-use-settings-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('browser settings default to Playwright with Chromium', async () => {
  await withDatabase(async () => {
    assert.deepEqual(await browserUseService.getSettings(), {
      enabled: false,
      engine: 'playwright',
      browser: 'chromium',
      chromePath: null,
      display: 'headless',
      gpu: 'auto',
    });
  });
});

test('browser settings keep a stealth Chrome choice and drop unknown values', async () => {
  await withDatabase(async () => {
    const saved = await browserUseService.updateSettings({ engine: 'patchright', browser: 'chrome', chromePath: '  ~/chrome/opt/google/chrome/chrome  ' });
    assert.deepEqual(saved, {
      enabled: false,
      engine: 'patchright',
      browser: 'chrome',
      chromePath: '~/chrome/opt/google/chrome/chrome',
      display: 'headless',
      gpu: 'auto',
    });

    // Only the fields given change; anything unrecognised falls back to the default.
    const reset = await browserUseService.updateSettings({ engine: 'puppeteer', browser: 'firefox', chromePath: '', display: 'kiosk', gpu: 'maybe' } as never);
    assert.deepEqual(reset, { enabled: false, engine: 'playwright', browser: 'chromium', chromePath: null, display: 'headless', gpu: 'auto' });
    assert.deepEqual(await browserUseService.getSettings(), reset);
  });
});

test('browser status names the chosen engine and where the server runs', async () => {
  await withDatabase(async () => {
    await browserUseService.updateSettings({ engine: 'patchright', browser: 'chrome', chromePath: '/nonexistent/chrome' });
    const status = await browserUseService.getStatus();
    assert.equal(status.engine, 'patchright');
    assert.equal(status.browser, 'chrome');
    assert.equal(status.platform, process.platform);
    assert.equal(typeof status.isAdministrator, 'boolean');
    // A configured location that does not exist is not "installed".
    assert.equal(status.chromiumInstalled, false);
    // The admin commands run the engine's CLI by full path: npx is often not
    // on the PATH, and sudo resets it.
    assert.ok(status.engineCommand.includes(process.execPath));
    assert.match(status.engineCommand, /patchright[\\/]cli\.js'?"?$/);
    assert.doesNotMatch(status.engineCommand, /npx/);
  });
});

test('the real-window choice applies to any engine and asks for Xvfb only on Linux', async () => {
  await withDatabase(async () => {
    const saved = await browserUseService.updateSettings({ engine: 'patchright', browser: 'chromium', display: 'window' });
    assert.equal(saved.display, 'window');
    // Changing engine or browser keeps the window choice.
    assert.equal((await browserUseService.updateSettings({ engine: 'playwright', browser: 'chrome' })).display, 'window');

    const status = await browserUseService.getStatus();
    assert.equal(status.display, 'window');
    assert.equal(status.virtualScreenRequired, process.platform === 'linux');
    assert.equal(typeof status.xvfbInstalled, 'boolean');
    // Both engines are listed, to switch between and remove.
    assert.deepEqual(status.engines.map((item) => item.engine), ['playwright', 'patchright']);
  });
});

test('removing an engine the current choice uses is refused', async () => {
  await withDatabase(async () => {
    await browserUseService.updateSettings({ engine: 'patchright', browser: 'chromium' });
    const result = await browserUseService.removeRuntime('patchright', 'chromium');
    assert.equal(result.success, false);
    assert.match(result.message, /in use/);
  });
});

test('the GPU can be turned off, and status says why it is or is not used', async () => {
  await withDatabase(async () => {
    assert.equal((await browserUseService.updateSettings({ gpu: 'off' })).gpu, 'off');
    const status = await browserUseService.getStatus();
    assert.equal(status.gpu.setting, 'off');
    assert.equal(status.gpu.inUse, false);
    assert.ok(Array.isArray(status.gpu.renderNodes));
    // The group command names the user CloudCLI runs as.
    assert.match(status.gpu.groupCommand, /^sudo usermod -aG \S+ \S+$/);
  });
});
