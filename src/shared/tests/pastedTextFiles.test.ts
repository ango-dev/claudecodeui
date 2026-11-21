import assert from 'node:assert/strict';

import { test } from 'vitest';

import { createPastedTextFiles, pastedTextFileName, withPastedTexts } from '@/shared/utils';

const readText = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(file, 'utf-8');
});

test('pasted texts are named the way Claude names them, numbered from the second', () => {
  assert.deepEqual([0, 1, 2, 9].map(pastedTextFileName), [
    'Pasted text.txt',
    'Pasted text (2).txt',
    'Pasted text (3).txt',
    'Pasted text (10).txt',
  ]);
});

test('createPastedTextFiles makes one UTF-8 .txt file per card, in order, holding its text exactly', async () => {
  const texts = ['first 🚀', '第二の 텍스트\nline 2'];
  const files = createPastedTextFiles(texts.map((text, index) => ({ id: String(index), text })));

  assert.deepEqual(files.map((file) => file.name), ['Pasted text.txt', 'Pasted text (2).txt']);
  assert.deepEqual(files.map((file) => file.type), ['text/plain;charset=utf-8', 'text/plain;charset=utf-8']);
  assert.deepEqual(files.map((file) => file.size), texts.map((text) => new TextEncoder().encode(text).length));
  assert.deepEqual(await Promise.all(files.map(readText)), texts);
  assert.deepEqual(createPastedTextFiles([]), []);
});

test('withPastedTexts puts a typed slash command first and pastes first otherwise', () => {
  const pasted = [{ id: 'a', text: 'PASTE' }];
  assert.equal(withPastedTexts(pasted, '/review'), '/review\n\nPASTE');
  assert.equal(withPastedTexts(pasted, 'typed'), 'PASTE\n\ntyped');
  assert.equal(withPastedTexts(pasted, '  '), 'PASTE');
});
