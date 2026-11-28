import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import ModelGroupList, { type ModelGroup } from '@/modules/chat/composer/ModelGroupList';
import { Command, CommandList } from '@/shared/ui';

// Antigravity's model list comes from the server and can be empty until `agy`
// is signed in. Its branch has to stay in the picker and say why it is empty,
// instead of cmdk dropping the whole branch (and its heading) silently.

const groups: ModelGroup[] = [
  {
    key: 'claude',
    provider: 'claude',
    name: 'Anthropic',
    models: [{ value: 'default', label: 'Default (Opus)' }],
  },
  { key: 'antigravity', provider: 'antigravity', name: 'Antigravity', models: [] },
];

const renderPicker = (loading: boolean, pickerGroups: ModelGroup[] = groups) => render(
  <Command>
    <CommandList>
      <ModelGroupList
        groups={pickerGroups}
        provider="claude"
        currentModel="default"
        loading={loading}
        searching={false}
        onSelect={() => {}}
        loadingLabel="Loading models…"
        emptyLabel="No models yet. Sign in under Settings → Agents."
      />
    </CommandList>
  </Command>,
);

describe('model picker with an Antigravity branch', () => {
  // cmdk measures its list and scrolls the active item into view; jsdom has neither.
  beforeEach(() => {
    Element.prototype.scrollIntoView = () => {};
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  it('keeps the Antigravity heading and logo while its catalog is empty, with the sign-in hint', () => {
    renderPicker(false);

    // cmdk names each group after its heading, which holds the logo and the branch name.
    const branch = screen.getByRole('group', { name: /Antigravity/ });
    expect(document.getElementById(branch.getAttribute('aria-labelledby') ?? '')
      ?.querySelector('svg[aria-label="Antigravity"]')).toBeTruthy();
    expect(screen.getByText('No models yet. Sign in under Settings → Agents.')).toBeTruthy();
    expect(screen.getByText('Default (Opus)')).toBeTruthy();
  });

  it('says models are loading instead while the catalog request is in flight', () => {
    renderPicker(true);

    expect(screen.getByText('Loading models…')).toBeTruthy();
    expect(screen.queryByText('No models yet. Sign in under Settings → Agents.')).toBeNull();
  });

  it('lists Antigravity models once the server returns them', () => {
    renderPicker(false, [
      groups[0],
      { ...groups[1], models: [{ value: 'gemini-4-neon', label: 'Gemini 4 Neon' }] },
    ]);

    expect(screen.getByText('Gemini 4 Neon')).toBeTruthy();
    expect(screen.queryByText('No models yet. Sign in under Settings → Agents.')).toBeNull();
  });
});
