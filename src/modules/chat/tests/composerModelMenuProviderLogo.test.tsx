import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import ComposerModelMenu from '@/modules/chat/composer/ComposerModelMenu';

// The model button leads with the active agent's logo, so it is clear at a
// glance whether the next message goes to Claude or to another agent.

const renderMenu = (provider?: 'claude' | 'antigravity', providerLabel?: string) => render(
  <ComposerModelMenu
    provider={provider}
    providerLabel={providerLabel}
    effort="high"
    effortOptions={[]}
    onSelectEffort={() => {}}
    model="opus"
    modelOptions={[{ value: 'opus', label: 'Opus 5.5' }]}
    onSelectModel={() => {}}
    modelsLoading={false}
  />,
);

describe('composer model button', () => {
  it('shows the Claude logo and names Claude', () => {
    renderMenu('claude', 'Claude');
    const button = screen.getByRole('button', { name: 'Select model (Claude)' });
    expect(button.querySelector('svg[aria-label="Claude"]')).not.toBeNull();
    expect(button.textContent).toContain('Opus 5.5');
  });

  it('shows the Antigravity logo for Antigravity', () => {
    renderMenu('antigravity', 'Antigravity');
    const button = screen.getByRole('button', { name: 'Select model (Antigravity)' });
    expect(button.querySelector('svg[aria-label="Antigravity"]')).not.toBeNull();
    expect(button.querySelector('svg[aria-label="Claude"]')).toBeNull();
  });

  it('shows no logo when no agent is given', () => {
    renderMenu();
    const button = screen.getByRole('button', { name: 'Select model' });
    expect(button.querySelector('svg')).toBeNull();
  });
});
