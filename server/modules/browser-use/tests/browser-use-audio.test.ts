import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * CloudCLI's private PulseAudio starts on a desktop whose own sound server
 * (PulseAudio, or PipeWire's stand-in) already holds org.PulseAudio1 on the
 * session D-Bus. Before, it inherited the desktop's bus, tried to claim that
 * name and refused to start ("D-Bus name org.PulseAudio1 already taken").
 *
 * Runs real binaries, so it is skipped where PulseAudio or D-Bus is missing.
 */

const hasBinary = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
const available = hasBinary('pulseaudio') && hasBinary('dbus-daemon');

async function waitForFile(file: string, timeoutMs = 10_000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  return false;
}

test('the private PulseAudio starts when the desktop\'s sound server holds the D-Bus name', { skip: !available }, async () => {
  // Unix socket paths are short-limited, so everything lives in a short temp folder.
  const root = await mkdtemp(path.join(os.tmpdir(), 'pa-'));
  const previousEnv = { HOME: process.env.HOME, DBUS: process.env.DBUS_SESSION_BUS_ADDRESS };
  let bus: { pid: number } | null = null;
  let desktopSound: ChildProcess | null = null;
  let stopVirtualDisplay: (() => void) | null = null;

  try {
    // A session bus standing in for the desktop's.
    const busOut = spawnSync('dbus-daemon', [
      '--session', '--fork', '--print-address=1', '--print-pid=1', `--address=unix:path=${path.join(root, 'bus')}`,
    ], { encoding: 'utf8' });
    const [address, pid] = busOut.stdout.trim().split('\n');
    assert.ok(address?.startsWith('unix:'), `dbus-daemon did not start: ${busOut.stderr}`);
    bus = { pid: Number(pid) };

    // The desktop's sound server, which takes org.PulseAudio1 on that bus.
    const desktopDir = path.join(root, 'desktop');
    fs.mkdirSync(desktopDir, { mode: 0o700 });
    desktopSound = spawn('pulseaudio', [
      '-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=false',
      '-L', `module-native-protocol-unix socket=${path.join(desktopDir, 'pulse.sock')} auth-anonymous=1`,
    ], {
      env: { ...process.env, HOME: desktopDir, XDG_RUNTIME_DIR: desktopDir, PULSE_RUNTIME_PATH: desktopDir, DBUS_SESSION_BUS_ADDRESS: address },
      stdio: 'ignore',
    });
    assert.ok(await waitForFile(path.join(desktopDir, 'pulse.sock')), 'the stand-in desktop sound server did not start');

    // CloudCLI runs inside that desktop session.
    process.env.HOME = path.join(root, 'home');
    process.env.DBUS_SESSION_BUS_ADDRESS = address;
    const display = await import('@/modules/browser-use/browser-use-display.js');
    stopVirtualDisplay = display.stopVirtualDisplay;

    const server = await display.getAudioServer();
    assert.match(server, /^unix:.+pulse\.sock$/);
    assert.ok(fs.existsSync(server.slice('unix:'.length)), 'its private socket is up');
  } finally {
    stopVirtualDisplay?.();
    desktopSound?.kill();
    if (bus) {
      try { process.kill(bus.pid); } catch { /* already gone */ }
    }
    if (previousEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = previousEnv.HOME;
    if (previousEnv.DBUS === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previousEnv.DBUS;
    await rm(root, { recursive: true, force: true });
  }
});
