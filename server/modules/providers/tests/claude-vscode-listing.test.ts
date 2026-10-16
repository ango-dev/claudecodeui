import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listClaudeSessionInVsCode } from '@/modules/providers/list/claude/claude-vscode-listing.provider.js';

/**
 * The VS Code panel hides a transcript when the first `"entrypoint":"…"` in
 * its opening 64 KiB (or, failing that, the last one in its closing 64 KiB)
 * is an SDK value. These check the patch turns exactly that value into `cli`
 * without changing anything else, and refuses to write when the file is not
 * shaped as expected.
 */

const SESSION_ID = '0f6d3c1e-8a52-4b7e-9c11-2d4e5f6a7b8c';

const queueLine = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: SESSION_ID });
const userLine = (entrypoint: string, text = 'hi') => JSON.stringify({
  parentUuid: null, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
  uuid: 'u1', userType: 'external', entrypoint, cwd: '/repo', sessionId: SESSION_ID,
});
const assistantLine = (entrypoint: string) => JSON.stringify({
  parentUuid: 'u1', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  uuid: 'a1', entrypoint, sessionId: SESSION_ID,
});

async function withTranscript(
  content: string,
  runTest: (transcriptPath: string) => Promise<void>,
): Promise<void> {
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-vscode-listing-'));
  const projectDirectory = path.join(configDirectory, 'projects', '-repo');
  await mkdir(projectDirectory, { recursive: true });
  const transcriptPath = path.join(projectDirectory, `${SESSION_ID}.jsonl`);
  await writeFile(transcriptPath, content);
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  try {
    await runTest(transcriptPath);
  } finally {
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
}

test('an SDK transcript is patched to cli at the same length, and nothing else changes', async () => {
  const original = `${queueLine}\n${userLine('sdk-ts')}\n${assistantLine('sdk-ts')}\n`;
  await withTranscript(original, async (transcriptPath) => {
    assert.equal(await listClaudeSessionInVsCode(SESSION_ID), 'listed');

    const patched = await readFile(transcriptPath, 'utf8');
    assert.equal(Buffer.byteLength(patched), Buffer.byteLength(original));
    const lines = patched.split('\n');
    assert.equal(JSON.parse(lines[1]!).entrypoint, 'cli');
    assert.equal(lines[1], userLine('sdk-ts').replace('"entrypoint":"sdk-ts"', '"entrypoint":"cli"   '));
    // Only the line the panel reads is touched.
    assert.equal(lines[0], queueLine);
    assert.equal(lines[2], assistantLine('sdk-ts'));
  });
});

test('a transcript the panel already lists is left alone', async () => {
  const original = `${userLine('cli')}\n`;
  await withTranscript(original, async (transcriptPath) => {
    assert.equal(await listClaudeSessionInVsCode(SESSION_ID), 'already-listed');
    assert.equal(await readFile(transcriptPath, 'utf8'), original);
  });
});

test('patching twice is the same as patching once', async () => {
  const original = `${userLine('sdk-cli')}\n`;
  await withTranscript(original, async (transcriptPath) => {
    assert.equal(await listClaudeSessionInVsCode(SESSION_ID), 'listed');
    const once = await readFile(transcriptPath, 'utf8');
    assert.equal(await listClaudeSessionInVsCode(SESSION_ID), 'already-listed');
    assert.equal(await readFile(transcriptPath, 'utf8'), once);
  });
});

test('when the opening window has no entrypoint, the last one in the file is patched', async () => {
  // A first prompt longer than the panel's window pushes its entrypoint past it.
  const huge = userLine('sdk-ts', 'x'.repeat(70_000));
  const original = `${huge}\n${assistantLine('sdk-ts')}\n`;
  await withTranscript(original, async (transcriptPath) => {
    assert.equal(await listClaudeSessionInVsCode(SESSION_ID), 'listed');
    const lines = (await readFile(transcriptPath, 'utf8')).split('\n');
    assert.equal(lines[0], huge);
    assert.equal(JSON.parse(lines[1]!).entrypoint, 'cli');
  });
});

test('a first entrypoint that is not the line\'s own field is refused without writing', async () => {
  const nestedOnly = JSON.stringify({ type: 'attachment', attachment: { entrypoint: 'sdk-ts' }, entrypoint: 'cli' });
  const nestedSameValue = JSON.stringify({ type: 'attachment', attachment: { entrypoint: 'sdk-ts' }, entrypoint: 'sdk-ts' });
  for (const [line, message] of [
    [nestedOnly, /not the session's own entrypoint field/],
    [nestedSameValue, /would not change the session's own entrypoint field/],
  ] as const) {
    await withTranscript(`${line}\n`, async (transcriptPath) => {
      await assert.rejects(listClaudeSessionInVsCode(SESSION_ID), message);
      assert.equal(await readFile(transcriptPath, 'utf8'), `${line}\n`);
    });
  }
});

test('a transcript without any entrypoint field fails loudly', async () => {
  const renamed = userLine('sdk-ts').replace('"entrypoint"', '"entry_point"');
  await withTranscript(`${renamed}\n`, async (transcriptPath) => {
    await assert.rejects(listClaudeSessionInVsCode(SESSION_ID), /no "entrypoint" field/);
    assert.equal(await readFile(transcriptPath, 'utf8'), `${renamed}\n`);
  });
});

test('a missing transcript fails loudly', async () => {
  await withTranscript('', async () => {
    await assert.rejects(
      listClaudeSessionInVsCode('11111111-2222-4333-8444-555555555555'),
      /no transcript named 11111111-2222-4333-8444-555555555555\.jsonl/,
    );
  });
});

test('a value that is not a session id is refused before touching the disk', async () => {
  await assert.rejects(listClaudeSessionInVsCode('../../etc/passwd'), /not a Claude session id/);
});
