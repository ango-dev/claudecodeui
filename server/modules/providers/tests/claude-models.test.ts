import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClaudeModelsDefinition,
  CLAUDE_PREDEFINED_MODELS,
  ClaudeProviderModels,
  extractClaudeEventModel,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

const CLAUDE_CODE_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-sonnet-5-5',
    displayName: 'Default (recommended)',
    description: 'Sonnet 5.5 · Efficient for routine tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5-5',
    displayName: 'Sonnet',
    description: 'Sonnet 5.5 · Efficient for routine tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5',
    displayName: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
  },
];

test('Claude Code\'s model list becomes the catalog, named after what each alias resolves to', () => {
  const catalog = buildClaudeModelsDefinition(CLAUDE_CODE_MODELS.map((model) => ({
    ...model,
    supportedEffortLevels: model.supportedEffortLevels ? [...model.supportedEffortLevels] : undefined,
  })));
  const primary = catalog.OPTIONS.filter((option) => !option.group);

  assert.equal(catalog.DEFAULT, 'default');
  assert.deepEqual(primary.map((option) => option.label), ['Default (Sonnet 5.5)', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
  assert.equal(primary[1].description, 'Best for everyday, complex tasks');
  assert.equal(primary[1].effort?.default, 'high', 'Claude Code recommends high effort');
  assert.ok(primary[1].effort?.values.some((value) => value.value === 'ultracode'), 'xhigh models offer ultracode');
  assert.equal(primary[3].effort, undefined, 'a model without effort support offers none');

  const more = catalog.OPTIONS.filter((option) => option.group === 'more').map((option) => option.value);
  assert.ok(more.includes('claude-opus-4-8'));
  assert.ok(!more.includes('claude-haiku-4-5'), 'an earlier model an alias already resolves to is not listed twice');
});

test('the Claude catalog falls back to the static list when Claude Code cannot be read', async () => {
  const unavailable = new ClaudeProviderModels(async () => null);
  assert.equal(await unavailable.getSupportedModels(), CLAUDE_PREDEFINED_MODELS);

  const available = new ClaudeProviderModels(async () => ({ models: [CLAUDE_CODE_MODELS[2]] as never, commands: [] }));
  assert.equal((await available.getSupportedModels()).OPTIONS[0].label, 'Opus 5.5');
});

test('a Claude Code that names models in displayName and lists full ids still gives one clean entry per model', () => {
  const catalog = buildClaudeModelsDefinition([
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'For complex work and everyday tasks' },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Best for everyday, complex tasks' },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Best for everyday, complex tasks' },
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', description: 'Fastest for quick answers' },
    { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
    { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'For complex work and everyday tasks' },
    { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  ] as never);

  const primary = catalog.OPTIONS.filter((option) => !option.group).map((option) => option.label);
  const more = catalog.OPTIONS.filter((option) => option.group === 'more').map((option) => option.label);
  assert.deepEqual(primary, ['Default (Opus 5.5)', 'Opus 5.5', 'Haiku 5.5'], 'names, not summaries, and one entry per model');
  assert.deepEqual(more.slice(0, 2), ['Haiku 4.5', 'Sonnet 5'], 'earlier models in Claude Code\'s order');
  assert.ok(more.includes('Opus 4.8'));
  assert.equal(new Set(more).size, more.length, 'no model twice');
  assert.ok(!more.includes('Opus 5.5'), 'what the main list offers is not repeated');
});
