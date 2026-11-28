import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const setVisibility = vi.fn(async (_show: boolean) => new Response('{}', { status: 200 }));
vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      visibility: async () => new Response(JSON.stringify({ success: true, data: { showOtherAgents: false } })),
      setVisibility: (show: boolean) => setVisibility(show),
    },
  },
}));

import { saveShowOtherAgents } from '@/shared/agentVisibility';
import {
  LLM_PROVIDERS,
  MCP_PROVIDER_NAMES,
  MCP_SUPPORTED_SCOPES,
  MCP_SUPPORTED_TRANSPORTS,
  PROVIDER_PERMISSION_PREFERENCE_KEYS,
} from '@/shared/constants';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';
import AntigravityLogo from '@/shared/ui/AntigravityLogo';
import { LLMProviderLogo } from '@/shared/ui/LLMProviderLogo';

// Antigravity (Google's `agy` CLI) is the fifth provider. These pin the shared
// pieces every module reads: the provider list, its logo and the Claude-only
// mode that has to keep hiding it.

describe('Antigravity logo', () => {
  it('draws a theme-coloured tile and glyph, so it follows light and dark mode', () => {
    const { container } = render(<AntigravityLogo />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('aria-label')).toBe('Antigravity');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('class')).toBe('w-5 h-5');
    expect(container.querySelector('rect')?.getAttribute('class')).toBe('fill-foreground');
    expect(container.querySelector('path')?.getAttribute('class')).toBe('stroke-background');
    // No hard-coded colours: every paint comes from the theme classes above.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
  });

  it('takes its size from the caller at small and large sizes', () => {
    const { container: small } = render(<AntigravityLogo className="h-3.5 w-3.5" />);
    const { container: large } = render(<AntigravityLogo className="h-24 w-24" />);

    expect(small.querySelector('svg')?.getAttribute('class')).toBe('h-3.5 w-3.5');
    expect(large.querySelector('svg')?.getAttribute('class')).toBe('h-24 w-24');
  });

  it('is what LLMProviderLogo shows for the antigravity provider', () => {
    const { container } = render(<LLMProviderLogo provider="antigravity" className="h-4 w-4" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('aria-label')).toBe('Antigravity');
    expect(svg?.getAttribute('class')).toBe('h-4 w-4');
  });
});

describe('Antigravity in the shared provider lists', () => {
  it('is listed after the other providers', () => {
    expect(LLM_PROVIDERS).toEqual(['claude', 'cursor', 'codex', 'opencode', 'antigravity']);
  });

  it('has its own MCP name, scopes and transports, and its own permission preference', () => {
    expect(MCP_PROVIDER_NAMES.antigravity).toBe('Antigravity');
    expect(MCP_SUPPORTED_SCOPES.antigravity).toEqual(['user', 'project']);
    expect(MCP_SUPPORTED_TRANSPORTS.antigravity).toEqual(['stdio', 'http']);
    // Falling through to Claude's key would hand Antigravity Claude's skipPermissions.
    expect(PROVIDER_PERMISSION_PREFERENCE_KEYS.antigravity).toBe('antigravityPermissions');
  });
});

describe('Antigravity in Claude-only mode', () => {
  afterEach(() => localStorage.clear());

  it('is never the provider a new chat starts with while the other agents are hidden', () => {
    writeSelectedProvider('antigravity');
    expect(readSelectedProvider()).toBe('claude');
  });

  it('is kept as the selected provider once the other agents are shown', async () => {
    await act(async () => {
      await saveShowOtherAgents(true);
    });
    writeSelectedProvider('antigravity');
    expect(readSelectedProvider()).toBe('antigravity');

    await act(async () => {
      await saveShowOtherAgents(false);
    });
    expect(readSelectedProvider()).toBe('claude');
  });
});
