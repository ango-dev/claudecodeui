import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Large enough for the browser window (see BROWSER_WINDOW_SIZE in the service) with room to spare. */
const VIRTUAL_SCREEN = '1920x1080x24';
const START_TIMEOUT_MS = 10_000;
/**
 * The running Xvfb's process id. A CloudCLI killed outright (a crash, kill -9)
 * runs no exit handler, and its Xvfb would outlive it; the next start stops it.
 */
const PID_FILE = path.join(os.homedir(), '.cloudcli', 'browser-use', 'xvfb.pid');

let displayPromise: Promise<string> | null = null;
let xvfbProcess: ChildProcess | null = null;

/**
 * Xvfb, a display server that draws to memory: a browser started with a real
 * window on it looks like any desktop browser (no "HeadlessChrome") while no
 * screen is attached to the server. Linux only.
 *
 * Used by the browser-use service to report whether the real-window mode can
 * run, and to say what to install when it cannot.
 */
export function findXvfb(): string | null {
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), '/usr/bin', '/usr/local/bin'];
  for (const directory of directories) {
    const candidate = directory ? path.join(directory, 'Xvfb') : '';
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const forgetDisplay = (child: ChildProcess) => {
  // A late exit of an old Xvfb must not clear its replacement.
  if (xvfbProcess === child) {
    xvfbProcess = null;
    displayPromise = null;
    fs.rmSync(PID_FILE, { force: true });
  }
};

/** Stops an Xvfb left by a CloudCLI that was killed, checking the id is still an Xvfb (ids are reused). */
function stopLeftoverXvfb(): void {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
    // Its parent: still a Node process while another CloudCLI using it runs.
    const parentPid = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[1];
    const parentCommand = fs.existsSync(`/proc/${parentPid}/cmdline`)
      ? fs.readFileSync(`/proc/${parentPid}/cmdline`, 'utf8').split('\0')[0]
      : '';
    if (pid > 0 && path.basename(command) === 'Xvfb' && !/node/.test(path.basename(parentCommand))) {
      process.kill(pid);
    }
  } catch {
    // No leftover: no file, or that process has ended.
  }
  fs.rmSync(PID_FILE, { force: true });
}

/**
 * The X display (":N") of CloudCLI's own Xvfb, started on first use and shared
 * by every real-window browser session. Xvfb picks a free display number
 * itself (-displayfd), so it never collides with a desktop or another Xvfb.
 *
 * Used by the browser-use service when it launches a browser with a real window.
 */
export function getVirtualDisplay(): Promise<string> {
  if (displayPromise) {
    return displayPromise;
  }
  const binary = findXvfb();
  if (!binary) {
    return Promise.reject(new Error('Xvfb is not installed.'));
  }

  const child = spawn(binary, ['-displayfd', '3', '-screen', '0', VIRTUAL_SCREEN, '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  xvfbProcess = child;
  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
  }
  displayPromise = new Promise<string>((resolve, reject) => {
    let displayOutput = '';
    let errorOutput = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Xvfb did not start within 10 seconds.'));
    }, START_TIMEOUT_MS);
    child.stderr?.on('data', (chunk) => {
      errorOutput = (errorOutput + String(chunk)).slice(-2000);
    });
    // Xvfb writes the display number it took to fd 3 once it is ready.
    child.stdio[3]?.on('data', (chunk) => {
      displayOutput += String(chunk);
      const match = /^(\d+)\s/.exec(displayOutput);
      if (match) {
        clearTimeout(timer);
        resolve(`:${match[1]}`);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      forgetDisplay(child);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      forgetDisplay(child);
      const lastLine = errorOutput.trim().split('\n').pop();
      reject(new Error(`Xvfb exited with code ${code}${lastLine ? `: ${lastLine}` : ''}.`));
    });
  });
  return displayPromise;
}

/**
 * Ends CloudCLI's Xvfb, if running. Used by the browser-use service once no
 * browser session can be using it (all stopped, or the window setting changed).
 */
export function stopVirtualDisplay(): void {
  const child = xvfbProcess;
  if (child) {
    forgetDisplay(child);
    child.kill();
  }
}

if (process.platform === 'linux') {
  stopLeftoverXvfb();
}

process.once('exit', () => {
  xvfbProcess?.kill();
});
