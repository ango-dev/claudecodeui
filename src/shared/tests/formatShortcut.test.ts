import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatShortcut, hasKeyboardShortcutHints, isApplePlatform } from '@/shared/utils';

const onPlatform = (platform: string) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);

describe('shortcut labels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses Apple's symbols on a Mac, iPhone and iPad", () => {
    // iPadOS reports itself as a Mac; its keyboards have ⌘ too.
    for (const platform of ['MacIntel', 'iPhone', 'iPad']) {
      onPlatform(platform);
      expect(isApplePlatform()).toBe(true);
      expect(formatShortcut('Mod', 'Enter')).toBe('⌘↩');
      expect(formatShortcut('Mod', 'K')).toBe('⌘K');
      expect(formatShortcut('Shift', 'Enter')).toBe('⇧↩');
    }
  });

  it('names the keys with + on Windows and Linux', () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      onPlatform(platform);
      expect(isApplePlatform()).toBe(false);
      expect(formatShortcut('Mod', 'Enter')).toBe('Ctrl+Enter');
      expect(formatShortcut('Mod', 'S')).toBe('Ctrl+S');
      expect(formatShortcut('Shift', 'Enter')).toBe('Shift+Enter');
      expect(formatShortcut('Esc')).toBe('Esc');
    }
  });

  it('leaves hints out where nothing hovers (phones, tablets without a trackpad)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(hover: none)' }));
    expect(hasKeyboardShortcutHints()).toBe(false);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(hasKeyboardShortcutHints()).toBe(true);
  });
});
