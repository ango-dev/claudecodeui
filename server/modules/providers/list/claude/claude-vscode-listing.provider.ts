import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Lets the VS Code Claude Code panel list a session CloudCLI started.
 *
 * The panel hides every transcript whose `entrypoint` is an SDK one, and the
 * CLI writes `sdk-cli` even when told `cli`, because every SDK run is
 * non-interactive. So instead the transcript is patched after each turn, at
 * the one place the panel looks: the first `"entrypoint":"…"` in the file's
 * first 64 KiB, or, when there is none there, the last one in its final
 * 64 KiB.
 *
 * The patch keeps the file's byte length: `"sdk-ts"` becomes `"cli"` plus
 * trailing spaces, which JSON allows between a value and the next comma. That
 * makes it one positional write that never disturbs the lines the CLI is
 * still appending.
 *
 * Anything that does not look exactly as expected throws instead of guessing,
 * so a change in Claude Code's transcript format shows up as an error in the
 * chat rather than a session that is quietly hidden or a damaged transcript.
 */

/** The values the VS Code panel hides; a transcript carrying any other value is already listed. */
const HIDDEN_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
const LISTED_ENTRYPOINT = 'cli';
const ENTRYPOINT_KEY = Buffer.from('"entrypoint":"');
const QUOTE = 0x22;
const NEWLINE = 0x0a;
// Mirrors the panel's read window: it reads this much from each end of the file.
const PANEL_WINDOW_BYTES = 65536;
// Room past the window for the value of a key that starts just inside it.
const VALUE_SLACK_BYTES = 64;
const LINE_READ_CHUNK_BYTES = 65536;
const TRANSCRIPT_WAIT_ATTEMPTS = 10;
const TRANSCRIPT_WAIT_MS = 200;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EntrypointMatch = {
  /** Byte offset of the first character of the value, just past the opening quote. */
  valueOffset: number;
  value: string;
};

function claudeProjectsDirectory(): string {
  // The CLI honours CLAUDE_CONFIG_DIR, and the server forwards its env to every CLI it spawns.
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const baseDirectory = configDirectory && path.isAbsolute(configDirectory)
    ? configDirectory
    : path.join(os.homedir(), '.claude');
  return path.join(baseDirectory, 'projects');
}

/**
 * What a transcript the CLI has not finished writing looks like. The CLI
 * buffers its writes, so a turn that ends at once can report back before its
 * lines reach the disk; these are retried for a moment before they count.
 */
class TranscriptNotWrittenYetError extends Error {}

/** Finds `<session>.jsonl` under any project folder, so the CLI's folder-name encoding never has to be reproduced. */
async function findTranscript(sessionId: string): Promise<string> {
  const projectsDirectory = claudeProjectsDirectory();
  const fileName = `${sessionId}.jsonl`;
  let projectFolders: string[] = [];
  try {
    projectFolders = await fs.readdir(projectsDirectory);
  } catch {
    // Reported below like any other missing transcript.
  }

  for (const folder of projectFolders) {
    const candidate = path.join(projectsDirectory, folder, fileName);
    try {
      if ((await fs.stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Not in this project folder.
    }
  }
  throw new TranscriptNotWrittenYetError(`no transcript named ${fileName} was found in ${projectsDirectory}.`);
}

async function readBytes(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
  return buffer.subarray(0, bytesRead);
}

/** Reads the value that follows a key found at `keyIndex` in `chunk`, which starts at file offset `chunkOffset`. */
function readMatch(chunk: Buffer, chunkOffset: number, keyIndex: number): EntrypointMatch {
  const valueStart = keyIndex + ENTRYPOINT_KEY.length;
  const valueEnd = chunk.indexOf(QUOTE, valueStart);
  if (valueEnd < 0 || valueEnd - valueStart > VALUE_SLACK_BYTES) {
    throw new Error('an entrypoint value in the transcript is not a short string.');
  }
  return {
    valueOffset: chunkOffset + valueStart,
    value: chunk.toString('utf8', valueStart, valueEnd),
  };
}

/**
 * The entrypoint the panel reads: the first in the opening window, else the
 * last in the closing one. Null when neither window has one at all.
 */
async function findPanelEntrypoint(handle: FileHandle, fileSize: number): Promise<EntrypointMatch | null> {
  const head = await readBytes(handle, 0, PANEL_WINDOW_BYTES + VALUE_SLACK_BYTES);
  const firstKey = head.indexOf(ENTRYPOINT_KEY);
  if (firstKey >= 0 && firstKey + ENTRYPOINT_KEY.length < PANEL_WINDOW_BYTES) {
    return readMatch(head, 0, firstKey);
  }

  const tailOffset = Math.max(0, fileSize - PANEL_WINDOW_BYTES);
  const tail = await readBytes(handle, tailOffset, PANEL_WINDOW_BYTES);
  const lastKey = tail.lastIndexOf(ENTRYPOINT_KEY);
  return lastKey >= 0 ? readMatch(tail, tailOffset, lastKey) : null;
}

/**
 * Reads the whole line holding `offset`, however long it runs. `complete` is
 * false when the file ends before the line's newline, i.e. the CLI is still
 * writing it.
 */
async function readLineAround(handle: FileHandle, offset: number): Promise<{ start: number; bytes: Buffer; complete: boolean }> {
  let start = offset;
  while (start > 0) {
    const chunkStart = Math.max(0, start - LINE_READ_CHUNK_BYTES);
    const chunk = await readBytes(handle, chunkStart, start - chunkStart);
    const newline = chunk.lastIndexOf(NEWLINE);
    if (newline >= 0) {
      start = chunkStart + newline + 1;
      break;
    }
    start = chunkStart;
  }

  const parts: Buffer[] = [];
  let complete = false;
  for (let position = start; ;) {
    const chunk = await readBytes(handle, position, LINE_READ_CHUNK_BYTES);
    const newline = chunk.indexOf(NEWLINE);
    if (newline >= 0) {
      parts.push(chunk.subarray(0, newline));
      complete = true;
      break;
    }
    parts.push(chunk);
    if (chunk.length < LINE_READ_CHUNK_BYTES) {
      break;
    }
    position += chunk.length;
  }
  return { start, bytes: Buffer.concat(parts), complete };
}

function topLevelEntrypoint(lineBytes: Buffer): unknown {
  try {
    const parsed: unknown = JSON.parse(lineBytes.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).entrypoint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Patches the session's transcript so the VS Code panel lists it.
 *
 * Returns `listed` when it changed the file and `already-listed` when the
 * panel would already show it. Throws, with a sentence meant for the chat,
 * whenever the transcript is not shaped as expected; it never writes in that
 * case.
 *
 * Used by the Claude runtime after each turn, while the "Show these sessions
 * in VS Code" setting is on. Safe to call repeatedly and while the CLI is
 * still writing the file.
 */
export async function listClaudeSessionInVsCode(sessionId: string): Promise<'listed' | 'already-listed'> {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`"${sessionId}" is not a Claude session id.`);
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await patchTranscript(sessionId);
    } catch (error) {
      if (!(error instanceof TranscriptNotWrittenYetError) || attempt >= TRANSCRIPT_WAIT_ATTEMPTS) {
        throw error;
      }
    }
    await new Promise((resolve) => { setTimeout(resolve, TRANSCRIPT_WAIT_MS); });
  }
}

async function patchTranscript(sessionId: string): Promise<'listed' | 'already-listed'> {
  const transcriptPath = await findTranscript(sessionId);
  const handle = await fs.open(transcriptPath, 'r+');
  try {
    const { size } = await handle.stat();
    const match = await findPanelEntrypoint(handle, size);
    if (!match) {
      throw new TranscriptNotWrittenYetError('the transcript has no "entrypoint" field where Claude Code used to write one.');
    }
    if (!HIDDEN_ENTRYPOINTS.has(match.value)) {
      return 'already-listed';
    }

    // The key the panel reads must be the line's own field, not one nested inside it.
    const line = await readLineAround(handle, match.valueOffset);
    if (!line.complete) {
      throw new TranscriptNotWrittenYetError('the transcript line holding the entrypoint is still being written.');
    }
    if (topLevelEntrypoint(line.bytes) !== match.value) {
      throw new Error('the first "entrypoint" in the transcript is not the session\'s own entrypoint field.');
    }

    const original = Buffer.from(`${match.value}"`);
    const replacement = Buffer.from(`${LISTED_ENTRYPOINT}"${' '.repeat(original.length - LISTED_ENTRYPOINT.length - 1)}`);
    const lineOffset = match.valueOffset - line.start;
    const patchedLine = Buffer.from(line.bytes);
    replacement.copy(patchedLine, lineOffset);
    if (topLevelEntrypoint(patchedLine) !== LISTED_ENTRYPOINT) {
      // Either the edit breaks the JSON, or the key it hits is a nested one that shares the value.
      throw new Error('patching the first "entrypoint" in the transcript would not change the session\'s own entrypoint field.');
    }

    // The CLI only appends, but check the bytes are still the ones just read.
    const current = await readBytes(handle, match.valueOffset, original.length);
    if (!current.equals(original)) {
      throw new Error('the transcript changed while it was being patched.');
    }
    await handle.write(replacement, 0, replacement.length, match.valueOffset);

    const written = await readLineAround(handle, match.valueOffset);
    if (topLevelEntrypoint(written.bytes) !== LISTED_ENTRYPOINT) {
      throw new Error('the patched transcript line did not read back as expected.');
    }
    return 'listed';
  } finally {
    await handle.close();
  }
}
