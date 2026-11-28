import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Settings and onboarding refresh every provider's sign-in at once; that has
// to include Antigravity, or its account panel would sit on "Checking..." forever.

const authStatus = vi.hoisted(() => vi.fn(async (provider: string) => new Response(
  JSON.stringify({
    success: true,
    data: provider === 'antigravity'
      ? { authenticated: true, email: 'dev@example.com', method: 'oauth' }
      : { authenticated: false },
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
)));

vi.mock('@/shared/api', () => ({ api: { providers: { authStatus } } }));

const { useProviderAuthStatus } = await import('@/modules/provider-auth');

describe('useProviderAuthStatus with Antigravity', () => {
  it('starts Antigravity in the loading state and refreshes it with the others', async () => {
    const { result } = renderHook(() => useProviderAuthStatus());
    expect(result.current.providerAuthStatus.antigravity.loading).toBe(true);

    await act(async () => {
      await result.current.refreshProviderAuthStatuses();
    });

    expect(authStatus.mock.calls.map(([provider]) => provider)).toEqual(
      ['claude', 'cursor', 'codex', 'opencode', 'antigravity'],
    );
    expect(result.current.providerAuthStatus.antigravity).toMatchObject({
      authenticated: true,
      email: 'dev@example.com',
      loading: false,
    });
  });
});
