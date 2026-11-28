import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import type { ProviderAuthStatus, ProviderAuthStatusMap } from '@/shared/types';

// Onboarding lists a login card per agent; Antigravity's appears only once the
// other agents are shown, as Cursor, Codex and OpenCode do.

const visibility = vi.hoisted(() => ({ showOtherAgents: false }));

vi.mock('@/shared/agentVisibility', () => ({
  useShowOtherAgents: () => visibility.showOtherAgents,
}));

const { default: AgentConnectionsStep } = await import('@/modules/onboarding/AgentConnectionsStep');

const status: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
const statuses: ProviderAuthStatusMap = {
  claude: status,
  cursor: status,
  codex: status,
  opencode: status,
  antigravity: status,
};

describe('AgentConnectionsStep with Antigravity', () => {
  beforeEach(() => {
    visibility.showOtherAgents = false;
  });

  it('leaves Antigravity out in Claude-only mode', () => {
    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={() => {}} />);

    expect(screen.queryByText('Google Antigravity')).toBeNull();
  });

  it('offers an Antigravity login card once the other agents are shown', () => {
    visibility.showOtherAgents = true;
    const onOpenProviderLogin = vi.fn();
    render(<AgentConnectionsStep providerStatuses={statuses} onOpenProviderLogin={onOpenProviderLogin} />);

    const card = screen.getByText('Google Antigravity').closest('.rounded-xl') as HTMLElement;
    expect(card.querySelector('svg[aria-label="Antigravity"]')).toBeTruthy();
    fireEvent.click(card.querySelector('button') as HTMLButtonElement);
    expect(onOpenProviderLogin).toHaveBeenCalledWith('antigravity');
  });
});
