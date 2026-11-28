import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import '@/modules/i18n';

// The login modal runs the provider's CLI in an embedded shell. Antigravity's
// `agy` signs in with Google on its first interactive run, and is not bundled
// with CloudCLI, so the modal also says how to install it.

const shell = vi.hoisted(() => ({ commands: [] as string[] }));

vi.mock('@/modules/standalone-shell', () => ({
  StandaloneShell: ({ command }: { command: string }) => {
    shell.commands.push(command);
    return <div data-testid="shell">{command}</div>;
  },
}));

const { ProviderLoginModal } = await import('@/modules/provider-auth');

describe('ProviderLoginModal for Antigravity', () => {
  it('runs agy under its own title and shows how to install it', () => {
    render(<ProviderLoginModal isOpen provider="antigravity" onClose={() => {}} />);

    expect(screen.getByRole('heading', { name: 'Antigravity CLI Login' })).toBeTruthy();
    expect(screen.getByTestId('shell').textContent).toBe('agy');

    const hint = screen.getByTestId('provider-login-install-hint');
    expect(hint.textContent).toContain('curl -fsSL https://antigravity.google/cli/install.sh | bash');
    expect(hint.textContent).toContain('irm https://antigravity.google/cli/install.ps1 | iex');
  });

  it('leaves the install hint out for the CLIs that need none', () => {
    render(<ProviderLoginModal isOpen provider="opencode" onClose={() => {}} />);

    expect(screen.getByTestId('shell').textContent).toBe('opencode auth login');
    expect(screen.queryByTestId('provider-login-install-hint')).toBeNull();
  });
});
