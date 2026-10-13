import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Large enough for the browser window (see BROWSER_WINDOW_SIZE in the service) with room to spare. */
const VIRTUAL_SCREEN = '1920x1080x24';
const START_TIMEOUT_MS = 10_000;
/**
 * Per CloudCLI process, named by its pid: "<pid>.pid" holds its Xvfb's pid,
 * "<pid>.auth" the cookie browsers connect with. A CloudCLI killed outright
 * (a crash, kill -9) runs no exit handler, so its Xvfb would outlive it; the
 * next start finds the files of a process that is gone and stops that Xvfb.
 */
const STATE_DIRECTORY = path.join(os.homedir(), '.cloudcli', 'browser-use', 'xvfb');
const OWN_PID_FILE = path.join(STATE_DIRECTORY, `${process.pid}.pid`);
const OWN_AUTH_FILE = path.join(STATE_DIRECTORY, `${process.pid}.auth`);

type VirtualDisplay = {
  /** The X display, ":N". */
  display: string;
  /** The Xauthority file holding the cookie; browsers need it in XAUTHORITY to connect. */
  xauthority: string;
};

let displayPromise: Promise<VirtualDisplay> | null = null;
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

const removeOwnState = () => {
  fs.rmSync(OWN_PID_FILE, { force: true });
  fs.rmSync(OWN_AUTH_FILE, { force: true });
};

const forgetDisplay = (child: ChildProcess) => {
  // A late exit of an old Xvfb must not clear its replacement.
  if (xvfbProcess === child) {
    xvfbProcess = null;
    displayPromise = null;
    removeOwnState();
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * Stops the Xvfb of every CloudCLI process that is gone, checking each id is
 * still an Xvfb (ids are reused). Those of running instances are left alone.
 */
function stopLeftoverXvfbs(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(STATE_DIRECTORY);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^(\d+)\.pid$/.exec(entry);
    const ownerPid = match ? Number(match[1]) : 0;
    if (!ownerPid || ownerPid === process.pid || isProcessAlive(ownerPid)) {
      continue;
    }
    try {
      const xvfbPid = Number.parseInt(fs.readFileSync(path.join(STATE_DIRECTORY, entry), 'utf8'), 10);
      const command = fs.readFileSync(`/proc/${xvfbPid}/cmdline`, 'utf8').split('\0')[0];
      if (xvfbPid > 0 && path.basename(command) === 'Xvfb') {
        process.kill(xvfbPid);
      }
    } catch {
      // That Xvfb has ended too.
    }
    fs.rmSync(path.join(STATE_DIRECTORY, entry), { force: true });
    fs.rmSync(path.join(STATE_DIRECTORY, `${ownerPid}.auth`), { force: true });
  }
}

/**
 * An Xauthority file with one MIT-MAGIC-COOKIE-1 entry for any host and
 * display (FamilyWild, empty number), in the file's binary format: each field
 * is a 2-byte big-endian length (the family is the value) then its bytes.
 * Without it Xvfb would take connections from any local user, who could watch
 * or drive the browser and its signed-in profile.
 */
function writeCookieFile(file: string): void {
  const field = (value: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(value.length);
    return Buffer.concat([length, value]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(0xffff);
  const entry = Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.alloc(0)),
    field(Buffer.from('MIT-MAGIC-COOKIE-1')),
    field(randomBytes(16)),
  ]);
  fs.writeFileSync(file, entry, { mode: 0o600 });
}

/**
 * CloudCLI's own Xvfb, started on first use and shared by every real-window
 * browser session. Xvfb picks a free display number itself (-displayfd), so
 * it never collides with a desktop or another Xvfb, and admits only clients
 * holding its cookie (-auth).
 *
 * Used by the browser-use service when it launches a browser with a real window.
 */
export function getVirtualDisplay(): Promise<VirtualDisplay> {
  if (displayPromise) {
    return displayPromise;
  }
  const binary = findXvfb();
  if (!binary) {
    return Promise.reject(new Error('Xvfb is not installed.'));
  }

  fs.mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  writeCookieFile(OWN_AUTH_FILE);
  const child = spawn(
    binary,
    ['-displayfd', '3', '-screen', '0', VIRTUAL_SCREEN, '-nolisten', 'tcp', '-auth', OWN_AUTH_FILE],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  );
  xvfbProcess = child;
  if (child.pid) {
    fs.writeFileSync(OWN_PID_FILE, String(child.pid));
  }
  displayPromise = new Promise<VirtualDisplay>((resolve, reject) => {
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
        resolve({ display: `:${match[1]}`, xauthority: OWN_AUTH_FILE });
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
  stopLeftoverXvfbs();
}

process.once('exit', () => {
  xvfbProcess?.kill();
  removeOwnState();
});
