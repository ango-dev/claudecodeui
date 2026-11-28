import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';

import '@/modules/i18n';
import type { LLMProvider, ProviderModelsDefinition } from '@/shared/types';

// A new chat on Antigravity before `agy` is signed in has no model: the
// provider card and the line under it must say so, not "Ready to use
// Antigravity with ." around an empty model name.

vi.mock('@/shared/agentVisibility', () => ({ useShowOtherAgents: () => true }));
vi.mock('@/modules/task-master', () => ({ NextTaskBanner: () => null }));

const { default: ProviderSelectionEmptyState } = await import('@/modules/chat/transcript/ProviderSelectionEmptyState');

const renderEmptyState = (antigravity: ProviderModelsDefinition, model: string) => {
  const providerModels: Record<LLMProvider, string> = {
    claude: 'default', cursor: 'gpt-5.3-codex', codex: 'gpt-5.6-sol', opencode: 'x', antigravity: model,
  };
  render(
    <ProviderSelectionEmptyState
      selectedSession={null}
      currentSessionId={null}
      provider="antigravity"
      setProvider={() => {}}
      textareaRef={createRef<HTMLTextAreaElement>()}
      providerModels={providerModels}
      setProviderModel={() => {}}
      providerModelCatalog={{ antigravity }}
      providerModelActions={{} as never}
      providerModelsLoading={false}
      tasksEnabled={false}
      isTaskMasterInstalled={false}
      setInput={() => {}}
    />,
  );
};

describe('new-chat card for Antigravity', () => {
  it('says there is no model yet and where to sign in', () => {
    renderEmptyState({ OPTIONS: [], DEFAULT: '' }, '');

    expect(screen.getByText('Antigravity')).toBeTruthy();
    expect(screen.getByText('No model yet')).toBeTruthy();
    expect(screen.getByText('No models yet. Sign in under Settings → Agents.')).toBeTruthy();
    expect(screen.queryByText(/Ready to use Antigravity/)).toBeNull();
  });

  it('names the model once the server lists one', () => {
    renderEmptyState({ OPTIONS: [{ value: 'gemini-4-neon', label: 'Gemini 4 Neon' }], DEFAULT: 'gemini-4-neon' }, 'gemini-4-neon');

    expect(screen.getByText('Gemini 4 Neon')).toBeTruthy();
    expect(screen.getByText('Ready to use Antigravity with gemini-4-neon. Start typing your message below.')).toBeTruthy();
  });
});
