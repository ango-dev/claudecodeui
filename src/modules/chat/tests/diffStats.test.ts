import { describe, expect, it } from 'vitest';

import { calculateDiff, summarizeDiff } from '@/modules/chat/utils/messageTransforms';

const count = (oldStr: string, newStr: string) => summarizeDiff(calculateDiff(oldStr, newStr));

describe('diff line counting', () => {
  it('counts a replaced line as one added and one removed', () => {
    expect(count('a\nb\nc', 'a\nB\nc')).toEqual({ added: 1, removed: 1 });
  });

  it('counts a pure insertion with nothing removed', () => {
    expect(count('a\nc', 'a\nb\nc')).toEqual({ added: 1, removed: 0 });
  });

  it('counts a pure deletion with nothing added', () => {
    expect(count('a\nb\nc', 'a\nc')).toEqual({ added: 0, removed: 1 });
  });

  it('reports nothing for an edit that changes nothing', () => {
    expect(count('a\nb\nc', 'a\nb\nc')).toEqual({ added: 0, removed: 0 });
  });

  // Write passes '' as the "before" for a file that did not exist. Splitting
  // that on '\n' yields [''] — one phantom blank line — which used to be
  // reported as a deletion and drawn as a stray empty red row.
  it('treats a new file as pure additions whether or not it ends in a newline', () => {
    expect(count('', 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
    expect(count('', 'a\nb\nc\n')).toEqual({ added: 3, removed: 0 });
  });

  it('treats emptying a file as pure deletions', () => {
    expect(count('a\nb\nc', '')).toEqual({ added: 0, removed: 3 });
  });

  // A trailing newline terminates the last line; it does not start a new blank
  // one. Otherwise the same content counts differently depending on whether
  // the file happens to end in a newline.
  it('does not count a trailing newline as an extra line', () => {
    expect(count('a\nb', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
    expect(count('a\nb\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 });
  });

  it('still counts a genuinely blank trailing line', () => {
    expect(count('a\n', 'a\n\n')).toEqual({ added: 1, removed: 0 });
  });

  it('reports both sides for an empty-to-empty edit', () => {
    expect(count('', '')).toEqual({ added: 0, removed: 0 });
  });

  it('renders no diff rows for a new file beyond its own lines', () => {
    const lines = calculateDiff('', 'a\nb\nc');
    expect(lines.map((line) => line.type)).toEqual(['added', 'added', 'added']);
    expect(lines.map((line) => line.content)).toEqual(['a', 'b', 'c']);
  });

  it('keeps line numbers right around a change in the middle of a long file', () => {
    const before = Array.from({ length: 50 }, (_, index) => `line ${index}`);
    const after = [...before];
    after.splice(20, 1, 'changed');
    expect(calculateDiff(before.join('\n'), after.join('\n'))).toEqual([
      { type: 'removed', content: 'line 20', lineNum: 21 },
      { type: 'added', content: 'changed', lineNum: 21 },
    ]);
  });

  // Building the alignment for this froze the transcript on iPad (tens of millions of cells).
  it('stays quick on a large rewrite', () => {
    const before = Array.from({ length: 6000 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 6000 }, (_, index) => `new ${index}`).join('\n');
    const startedAt = performance.now();
    expect(count(before, after)).toEqual({ added: 6000, removed: 6000 });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('aligns a large file with a small change by its shared start and end', () => {
    const before = Array.from({ length: 20000 }, (_, index) => `line ${index}`);
    const after = [...before];
    after.splice(10000, 0, 'inserted');
    expect(count(before.join('\n'), after.join('\n'))).toEqual({ added: 1, removed: 0 });
  });
});
