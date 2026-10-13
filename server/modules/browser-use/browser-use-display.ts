import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Large enough for the browser window (see BROWSER_WINDOW_SIZE in the service) with room to spare. */
const VIRTUAL_SCREEN = '1920x1080x24';
const START_TIMEOUT_MS = 10_000;
/** How long Fluxbox gets to set up its taskbar before a browser opens on the screen. */
const WINDOW_MANAGER_SETTLE_MS = 800;
/**
 * Per CloudCLI process, named by its pid: "<pid>.pid" lists the pids of the
 * helpers it started (Xvfb, PulseAudio, Fluxbox), "<pid>.auth" holds the
 * cookie browsers connect to Xvfb with, "<pid>-home" is the helpers' home.
 * A CloudCLI killed outright (a crash, kill -9) runs no exit handler, so its
 * helpers would outlive it; the next start finds the files of a process that
 * is gone and stops them.
 */
const STATE_DIRECTORY = path.join(os.homedir(), '.cloudcli', 'browser-use', 'xvfb');
const OWN_PID_FILE = path.join(STATE_DIRECTORY, `${process.pid}.pid`);
const OWN_AUTH_FILE = path.join(STATE_DIRECTORY, `${process.pid}.auth`);
/** Where PulseAudio and Fluxbox keep their files, so neither writes into the user's own home. */
const OWN_HOME = path.join(STATE_DIRECTORY, `${process.pid}-home`);
/** Names PulseAudio's socket folder in the temp folder, so it is removed after a crash too. */
const OWN_PULSE_DIRECTORY_FILE = path.join(STATE_DIRECTORY, `${process.pid}.pulse`);
const PULSE_DIRECTORY_PREFIX = 'cloudcli-pulse-';
const HELPER_NAMES = new Set(['Xvfb', 'pulseaudio', 'fluxbox']);

type VirtualDisplay = {
  /** The X display, ":N". */
  display: string;
  /** The Xauthority file holding the cookie; browsers need it in XAUTHORITY to connect. */
  xauthority: string;
};

let displayPromise: Promise<VirtualDisplay> | null = null;
let xvfbProcess: ChildProcess | null = null;
let windowManagerPromise: Promise<void> | null = null;
let windowManagerProcess: ChildProcess | null = null;
let audioPromise: Promise<string> | null = null;
let audioProcess: ChildProcess | null = null;
/**
 * PulseAudio's socket folder: a fresh private one under the temp folder, as a
 * Unix socket path may not exceed about 100 characters and the home folder
 * can be deep. Removed with PulseAudio.
 */
let audioSocketDirectory: string | null = null;

const removeAudioSocketDirectory = () => {
  if (audioSocketDirectory) {
    fs.rmSync(audioSocketDirectory, { recursive: true, force: true });
    audioSocketDirectory = null;
  }
  fs.rmSync(OWN_PULSE_DIRECTORY_FILE, { force: true });
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function findBinary(name: string): string | null {
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), '/usr/bin', '/usr/local/bin'];
  for (const directory of directories) {
    const candidate = directory ? path.join(directory, name) : '';
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Xvfb, a display server that draws to memory: a browser started with a real
 * window on it looks like any desktop browser (no "HeadlessChrome") while no
 * screen is attached to the server. Linux only.
 *
 * Used by the browser-use service to report whether the real-window mode can
 * run, and to say what to install when it cannot.
 */
export function findXvfb(): string | null {
  return findBinary('Xvfb');
}

/**
 * PulseAudio, for the virtual speaker and microphone: a browser with no audio
 * devices at all stands out, as every desktop has some. Used by the
 * browser-use service like findXvfb.
 */
export function findPulseAudio(): string | null {
  return findBinary('pulseaudio');
}

/**
 * Fluxbox, a small window manager with a taskbar: without one, the virtual
 * screen has no taskbar or window frames, so the usable screen area equals
 * the whole screen. Used by the browser-use service like findXvfb.
 */
export function findWindowManager(): string | null {
  return findBinary('fluxbox');
}

/** Rewrites the pid file with the helpers running now; removed when none are. */
function writeOwnPids(): void {
  const pids = [xvfbProcess, audioProcess, windowManagerProcess]
    .map((child) => child?.pid)
    .filter((pid): pid is number => Boolean(pid));
  if (pids.length === 0) {
    fs.rmSync(OWN_PID_FILE, { force: true });
    return;
  }
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.writeFileSync(OWN_PID_FILE, pids.join('\n'));
}

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
 * Stops the helpers of every CloudCLI process that is gone, checking each id
 * is still one of them (ids are reused). Those of running instances are left
 * alone.
 */
function stopLeftoverHelpers(): void {
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
    let helperPids: number[] = [];
    try {
      helperPids = fs.readFileSync(path.join(STATE_DIRECTORY, entry), 'utf8')
        .split('\n')
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => pid > 0);
    } catch {
      // Unreadable: nothing to stop.
    }
    for (const helperPid of helperPids) {
      try {
        const command = fs.readFileSync(`/proc/${helperPid}/cmdline`, 'utf8').split('\0')[0];
        if (HELPER_NAMES.has(path.basename(command))) {
          process.kill(helperPid);
        }
      } catch {
        // That helper has ended too.
      }
    }
    fs.rmSync(path.join(STATE_DIRECTORY, entry), { force: true });
    fs.rmSync(path.join(STATE_DIRECTORY, `${ownerPid}.auth`), { force: true });
    fs.rmSync(path.join(STATE_DIRECTORY, `${ownerPid}-home`), { recursive: true, force: true });
    try {
      const pulseFile = path.join(STATE_DIRECTORY, `${ownerPid}.pulse`);
      const pulseDirectory = fs.readFileSync(pulseFile, 'utf8').trim();
      // Only ever a folder this module made in the temp folder.
      if (path.dirname(pulseDirectory) === os.tmpdir() && path.basename(pulseDirectory).startsWith(PULSE_DIRECTORY_PREFIX)) {
        fs.rmSync(pulseDirectory, { recursive: true, force: true });
      }
      fs.rmSync(pulseFile, { force: true });
    } catch {
      // No PulseAudio was running.
    }
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

function startXvfb(binary: string): Promise<VirtualDisplay> {
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  writeCookieFile(OWN_AUTH_FILE);
  const child = spawn(
    binary,
    ['-displayfd', '3', '-screen', '0', VIRTUAL_SCREEN, '-nolisten', 'tcp', '-auth', OWN_AUTH_FILE],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
  );
  xvfbProcess = child;
  writeOwnPids();
  return new Promise<VirtualDisplay>((resolve, reject) => {
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
    const forget = () => {
      clearTimeout(timer);
      // A late exit of an old Xvfb must not clear its replacement.
      if (xvfbProcess === child) {
        xvfbProcess = null;
        displayPromise = null;
        // The window manager lives on this display; it goes with it.
        stopWindowManager();
        fs.rmSync(OWN_AUTH_FILE, { force: true });
        writeOwnPids();
      }
    };
    child.on('error', (error) => {
      forget();
      reject(error);
    });
    child.on('exit', (code) => {
      forget();
      const lastLine = errorOutput.trim().split('\n').pop();
      reject(new Error(`Xvfb exited with code ${code}${lastLine ? `: ${lastLine}` : ''}.`));
    });
  });
}

function stopWindowManager(): void {
  const child = windowManagerProcess;
  windowManagerProcess = null;
  windowManagerPromise = null;
  child?.kill();
}

/** Fluxbox on the display, with its own home so it writes nothing into the user's. */
function startWindowManager(display: VirtualDisplay): Promise<void> {
  const binary = findWindowManager();
  if (!binary) {
    return Promise.reject(new Error('Fluxbox is not installed.'));
  }
  fs.mkdirSync(OWN_HOME, { recursive: true, mode: 0o700 });
  const child = spawn(binary, [], {
    env: { ...process.env, DISPLAY: display.display, XAUTHORITY: display.xauthority, HOME: OWN_HOME },
    stdio: 'ignore',
  });
  windowManagerProcess = child;
  writeOwnPids();
  child.on('exit', () => {
    if (windowManagerProcess === child) {
      windowManagerProcess = null;
      windowManagerPromise = null;
      writeOwnPids();
    }
  });
  // Fluxbox has no ready signal; its taskbar is up well within this.
  return sleep(WINDOW_MANAGER_SETTLE_MS);
}

/**
 * CloudCLI's own Xvfb, started on first use and shared by every real-window
 * browser session. Xvfb picks a free display number itself (-displayfd), so
 * it never collides with a desktop or another Xvfb, and admits only clients
 * holding its cookie (-auth). With `windowManager`, Fluxbox runs on it, so
 * windows get frames and the screen a taskbar.
 *
 * Used by the browser-use service when it launches a browser with a real window.
 */
export async function getVirtualDisplay(options: { windowManager?: boolean } = {}): Promise<VirtualDisplay> {
  if (!displayPromise) {
    const binary = findXvfb();
    if (!binary) {
      throw new Error('Xvfb is not installed.');
    }
    displayPromise = startXvfb(binary);
  }
  const display = await displayPromise;
  if (options.windowManager && !windowManagerPromise) {
    windowManagerPromise = startWindowManager(display);
  }
  if (options.windowManager) {
    await windowManagerPromise;
  }
  return display;
}

/**
 * CloudCLI's own PulseAudio, with a silent speaker and microphone (null sink
 * and source), reachable only through its private socket. Returns the value
 * for PULSE_SERVER. Used by the browser-use service for the audio setting.
 */
export function getAudioServer(): Promise<string> {
  if (audioPromise) {
    return audioPromise;
  }
  const binary = findPulseAudio();
  if (!binary) {
    return Promise.reject(new Error('PulseAudio is not installed.'));
  }
  fs.mkdirSync(OWN_HOME, { recursive: true, mode: 0o700 });
  removeAudioSocketDirectory();
  // mkdtemp makes a new folder only this user can open, so nothing else can
  // have placed or reach the socket.
  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), PULSE_DIRECTORY_PREFIX));
  audioSocketDirectory = socketDirectory;
  fs.mkdirSync(STATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.writeFileSync(OWN_PULSE_DIRECTORY_FILE, socketDirectory);
  const socket = path.join(socketDirectory, 'pulse.sock');
  const child = spawn(binary, [
    // -n: none of the system's default modules (no real sound cards, no D-Bus).
    '-n', '--daemonize=no', '--exit-idle-time=-1', '--use-pid-file=false', '--log-target=stderr',
    '-L', `module-native-protocol-unix socket=${socket} auth-anonymous=1`,
    '-L', 'module-null-sink sink_name=speakers sink_properties=device.description=Speakers',
    '-L', 'module-null-source source_name=microphone description=Microphone',
  ], {
    env: { ...process.env, HOME: OWN_HOME, XDG_RUNTIME_DIR: socketDirectory, PULSE_RUNTIME_PATH: socketDirectory },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  audioProcess = child;
  writeOwnPids();
  let errorOutput = '';
  child.stderr?.on('data', (chunk) => {
    errorOutput = (errorOutput + String(chunk)).slice(-2000);
  });
  const forget = () => {
    if (audioProcess === child) {
      audioProcess = null;
      audioPromise = null;
      removeAudioSocketDirectory();
      writeOwnPids();
    }
  };
  child.on('exit', forget);
  child.on('error', forget);
  audioPromise = (async () => {
    // Ready once its socket exists; it has no other signal.
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 100) {
      if (fs.existsSync(socket)) {
        return `unix:${socket}`;
      }
      if (audioProcess !== child) {
        break;
      }
      await sleep(100);
    }
    child.kill();
    forget();
    const lastError = errorOutput.split('\n').filter((line) => line.startsWith('E:')).pop();
    throw new Error(`PulseAudio did not start${lastError ? `: ${lastError}` : '.'}`);
  })();
  return audioPromise;
}

/**
 * Ends CloudCLI's Xvfb, its window manager and its PulseAudio, if running.
 * Used by the browser-use service once no browser session can be using them
 * (all stopped, or the settings changed).
 */
export function stopVirtualDisplay(): void {
  stopWindowManager();
  const xvfb = xvfbProcess;
  xvfbProcess = null;
  displayPromise = null;
  xvfb?.kill();
  const audio = audioProcess;
  audioProcess = null;
  audioPromise = null;
  audio?.kill();
  removeAudioSocketDirectory();
  fs.rmSync(OWN_AUTH_FILE, { force: true });
  writeOwnPids();
}

if (process.platform === 'linux') {
  stopLeftoverHelpers();
}

process.once('exit', () => {
  windowManagerProcess?.kill();
  xvfbProcess?.kill();
  audioProcess?.kill();
  removeAudioSocketDirectory();
  fs.rmSync(OWN_PID_FILE, { force: true });
  fs.rmSync(OWN_AUTH_FILE, { force: true });
  fs.rmSync(OWN_HOME, { recursive: true, force: true });
});
