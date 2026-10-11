import assert from 'node:assert/strict';

import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { test } from 'vitest';

import { warmPrismDark, warmPrismLight } from '@/shared/syntaxHighlighter';

/**
 * The warm Prism themes are One Light/One Dark with every colour remapped. They
 * must keep the same selectors and properties (only colours change), leave none
 * of One's cool slate grays behind, and keep token text readable on the chat
 * code block (bg-muted/50 over the background in light, gray-900 in dark).
 */

const LIGHT_CODE_BACKGROUND: [number, number, number] = [246, 246, 245];
const DARK_CODE_BACKGROUND: [number, number, number] = [21, 21, 21];

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [channel(0) * 255, channel(8) * 255, channel(4) * 255];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(first: [number, number, number], second: [number, number, number]): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Opaque `hsl(h, s%, l%)` token colours used as `color`. */
function tokenColors(theme: typeof oneLight): string[] {
  return [...new Set(
    Object.values(theme)
      .map((rule) => rule.color)
      .filter((color): color is string => typeof color === 'string' && color.startsWith('hsl(')),
  )];
}

function parseHsl(color: string): [number, number, number] {
  const [hue, saturation, lightness] = color.match(/[\d.]+/g)!.map(Number);
  return hslToRgb(hue, saturation, lightness);
}

test('the warm themes only change colours, not selectors or properties', () => {
  for (const [warm, source] of [[warmPrismLight, oneLight], [warmPrismDark, oneDark]] as const) {
    assert.deepEqual(Object.keys(warm), Object.keys(source));
    for (const selector of Object.keys(source)) {
      assert.deepEqual(Object.keys(warm[selector]), Object.keys(source[selector]));
    }
  }
});

test("no One theme slate gray (hue 219-230) is left behind", () => {
  for (const theme of [warmPrismLight, warmPrismDark]) {
    const serialized = JSON.stringify(theme);
    assert.doesNotMatch(serialized, /hsla?\((219|220|224|230),/);
  }
});

test('every token colour keeps 4.5:1 on the chat code block', () => {
  for (const [theme, background] of [
    [warmPrismLight, LIGHT_CODE_BACKGROUND],
    [warmPrismDark, DARK_CODE_BACKGROUND],
  ] as const) {
    for (const color of tokenColors(theme)) {
      const ratio = contrastRatio(parseHsl(color), background);
      assert.ok(ratio >= 4.5, `${color} is only ${ratio.toFixed(2)}:1`);
    }
  }
});
