import type { DiffCalculator, DiffLine, DiffStats } from '@/shared/types';

/**
 * Splits a file's text into the lines a diff should compare.
 *
 * Two conventions matter, and the plain `split('\n')` this replaced got both
 * wrong:
 *
 * - **An empty string is a file with no lines, not one blank line.** `Write`
 *   passes `''` as the "before" for a file that did not exist, so every new
 *   file used to report one deleted line and draw a stray blank red row.
 * - **A trailing newline terminates the last line rather than starting an
 *   empty one**, which is how `diff`, `git` and every editor count lines.
 *   Without this, whether a file ends in a newline changed its line count.
 */
const toDiffLines = (text: string): string[] => {
  if (text === '') {
    return [];
  }

  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
};

/**
 * The most old-by-new line pairs the alignment below compares. Its table grows
 * with their product: one large Write or Edit (thousands of lines each side)
 * built tens of millions of cells on the main thread, which froze the
 * transcript on iPad while it drew the tool card's "+N -N" (tool groups do
 * that even folded). Past this, the changed middle is shown as removed then
 * added, which is what such a rewrite mostly is anyway.
 */
const MAX_DIFF_CELLS = 2_000_000;

export const calculateDiff = (oldStr: string, newStr: string): DiffLine[] => {
  const oldLines = toDiffLines(oldStr);
  const newLines = toDiffLines(newStr);

  // Lines both sides share at the start and end are unchanged; only the middle needs aligning.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const diffLines: DiffLine[] = [];
  const pushRemoved = (index: number) => diffLines.push({ type: 'removed', content: oldLines[index], lineNum: index + 1 });
  const pushAdded = (index: number) => diffLines.push({ type: 'added', content: newLines[index], lineNum: index + 1 });

  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  if (oldCount * newCount > MAX_DIFF_CELLS) {
    for (let index = start; index < oldEnd; index += 1) pushRemoved(index);
    for (let index = start; index < newEnd; index += 1) pushAdded(index);
    return diffLines;
  }

  // Use LCS alignment so insertions/deletions don't cascade into a full-file "changed" diff.
  // One flat typed array: a row array per line cost far more memory than the numbers.
  const width = newCount + 1;
  const lcs = new Uint32Array((oldCount + 1) * width);
  for (let oldOffset = oldCount - 1; oldOffset >= 0; oldOffset -= 1) {
    for (let newOffset = newCount - 1; newOffset >= 0; newOffset -= 1) {
      lcs[oldOffset * width + newOffset] = oldLines[start + oldOffset] === newLines[start + newOffset]
        ? lcs[(oldOffset + 1) * width + newOffset + 1] + 1
        : Math.max(lcs[(oldOffset + 1) * width + newOffset], lcs[oldOffset * width + newOffset + 1]);
    }
  }

  let oldOffset = 0;
  let newOffset = 0;
  while (oldOffset < oldCount && newOffset < newCount) {
    if (oldLines[start + oldOffset] === newLines[start + newOffset]) {
      oldOffset += 1;
      newOffset += 1;
      continue;
    }

    if (lcs[(oldOffset + 1) * width + newOffset] >= lcs[oldOffset * width + newOffset + 1]) {
      pushRemoved(start + oldOffset);
      oldOffset += 1;
      continue;
    }

    pushAdded(start + newOffset);
    newOffset += 1;
  }

  for (; oldOffset < oldCount; oldOffset += 1) pushRemoved(start + oldOffset);
  for (; newOffset < newCount; newOffset += 1) pushAdded(start + newOffset);

  return diffLines;
};

/**
 * Counts a diff's added and removed lines for the `+12 -3` badge.
 *
 * Kept next to `calculateDiff` because the counts are only as correct as its
 * line splitting: it emits changed lines only, never context, so every entry
 * is one side or the other.
 */
export const summarizeDiff = (diffLines: DiffLine[]): DiffStats => {
  let added = 0;
  let removed = 0;

  for (const diffLine of diffLines) {
    if (diffLine.type === 'added') {
      added += 1;
    } else {
      removed += 1;
    }
  }

  return { added, removed };
};

/**
 * Reads a tool call's arguments off a `ChatMessage`.
 *
 * `normalizedToChatMessages` serializes `toolInput` to a JSON string on every
 * row (`useChatMessages.ts`), so anything reading it has to parse first.
 * `ToolRenderer` did that inline and the tool-group header did not, which is
 * why per-card diff stats rendered and the group total silently did not.
 */
export const parseToolPayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') {
    return payload;
  }

  try {
    return JSON.parse(payload);
  } catch {
    // A non-JSON string is the payload — some tools take a bare command.
    return payload;
  }
};

export const createCachedDiffCalculator = (): DiffCalculator => {
  const cache = new Map<string, DiffLine[]>();

  return (oldStr: string, newStr: string) => {
    const key = JSON.stringify([oldStr, newStr]);
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }

    const calculated = calculateDiff(oldStr, newStr);
    cache.set(key, calculated);
    if (cache.size > 100) {
      const firstKey = cache.keys().next().value;
      if (firstKey) {
        cache.delete(firstKey);
      }
    }
    return calculated;
  };
};
