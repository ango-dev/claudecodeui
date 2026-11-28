import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import type { AgentProvider, ProviderAuthStatus } from '@/shared/types';

// Antigravity sits behind the same "Show other agents" switch as Cursor, Codex
// and OpenCode: the fork's Claude-only mode must keep hiding it, and once shown
// it offers the panels it really has (account, MCP and skills; no permissions page).

const visibility = vi.hoisted(() => ({ showOtherAgents: false }));

vi.mock('@/shared/agentVisibility', () => ({
  useShowOtherAgents: () => visibility.showOtherAgents,
  isAgentVisible: (provider: string) => provider === 'claude' || visibility.showOtherAgents,
  saveShowOtherAgents: async () => {},
}));

// The CLI version row asks the server; that request just never answers here.
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { providers: { cliStatus: () => new Promise<Response>(() => {}) } },
}));

vi.mock('@/modules/mcp', () => ({
  McpServers: ({ selectedProvider }: { selectedProvider: string }) => <div>mcp:{selectedProvider}</div>,
}));

vi.mock('@/modules/skills', () => ({
  ProviderSkills: ({ selectedProvider }: { selectedProvider: string }) => <div>skills:{selectedProvider}</div>,
}));

const { default: AgentsSettingsTab } = await import('@/modules/settings/tabs/agents-settings/AgentsSettingsTab');

const signedOut: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
const signedIn: ProviderAuthStatus = { authenticated: true, email: 'dev@example.com', method: 'oauth', error: null, loading: false };

const renderTab = (antigravityStatus: ProviderAuthStatus = signedOut, onProviderLogin = vi.fn()) => {
  const providerAuthStatus: Record<AgentProvider, ProviderAuthStatus> = {
    claude: signedIn,
    cursor: signedOut,
    codex: signedOut,
    opencode: signedOut,
    antigravity: antigravityStatus,
  };
  render(
    <AgentsSettingsTab
      providerAuthStatus={providerAuthStatus}
      onProviderLogin={onProviderLogin}
      claudePermissions={{ allowedTools: [], disallowedTools: [], skipPermissions: false }}
      onClaudePermissionsChange={() => {}}
      cursorPermissions={{ allowedCommands: [], disallowedCommands: [], skipPermissions: false }}
      onCursorPermissionsChange={() => {}}
      codexPermissionMode="default"
      onCodexPermissionModeChange={() => {}}
      projects={[]}
    />,
  );
  return { onProviderLogin };
};

describe('Antigravity in Settings -> Agents', () => {
  beforeEach(() => {
    visibility.showOtherAgents = false;
  });

  it('stays hidden in Claude-only mode', () => {
    renderTab();

    expect(screen.queryByText('Antigravity')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Antigravity' })).toBeNull();
  });

  it('is listed after the other agents once they are shown', () => {
    visibility.showOtherAgents = true;
    renderTab();

    // The five agent pills come first; the account panel's own logo follows them.
    const pillLogos = screen.getAllByRole('img').slice(0, 5).map((logo) => logo.getAttribute('aria-label'));
    expect(pillLogos).toEqual(['Claude', 'Cursor', 'Codex', 'OpenCode', 'Antigravity']);
    expect(screen.getByText('Antigravity')).toBeTruthy();
  });

  it('shows the signed-out account panel and runs its login when selected', () => {
    visibility.showOtherAgents = true;
    const { onProviderLogin } = renderTab();

    fireEvent.click(screen.getByText('Antigravity'));

    expect(screen.getByText('Google Antigravity CLI assistant')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Login/ }));
    expect(onProviderLogin).toHaveBeenCalledWith('antigravity');
  });

  it('shows who is signed in', () => {
    visibility.showOtherAgents = true;
    renderTab(signedIn);

    fireEvent.click(screen.getByText('Antigravity'));

    expect(screen.getByText('Logged in as dev@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-login/ })).toBeTruthy();
  });

  it('offers account, MCP and skills, but no permissions panel', () => {
    visibility.showOtherAgents = true;
    renderTab();

    fireEvent.click(screen.getByText('Antigravity'));

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['Account', 'MCP Servers', 'Skills']);
    fireEvent.click(screen.getByRole('tab', { name: 'MCP Servers' }));
    expect(screen.getByText('mcp:antigravity')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    expect(screen.getByText('skills:antigravity')).toBeTruthy();
  });
});
