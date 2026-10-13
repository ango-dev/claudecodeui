import { act, renderHook } from '@testing-library/react';
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

import { isAgentVisible, saveShowOtherAgents, useShowOtherAgents } from '@/shared/agentVisibility';
import { readSelectedProvider, writeSelectedProvider } from '@/shared/selectedProvider';

describe('agent visibility', () => {
  afterEach(() => localStorage.clear());

  it('shows only Claude Code by default', () => {
    expect(isAgentVisible('claude')).toBe(true);
    expect(isAgentVisible('codex')).toBe(false);
  });

  it('starts new chats with Claude Code while the others are hidden', () => {
    writeSelectedProvider('codex');
    expect(readSelectedProvider()).toBe('claude');
  });

  it('turning the others on saves it on the server and updates what is shown', async () => {
    const { result } = renderHook(() => useShowOtherAgents());
    expect(result.current).toBe(false);
    await act(async () => {
      await saveShowOtherAgents(true);
    });
    expect(setVisibility).toHaveBeenCalledWith(true);
    expect(result.current).toBe(true);
    expect(isAgentVisible('cursor')).toBe(true);
    writeSelectedProvider('codex');
    expect(readSelectedProvider()).toBe('codex');
  });
});
