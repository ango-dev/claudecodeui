import { useEffect } from 'react';

// A software keyboard is far taller than this; smaller differences between the
// layout and visual viewport (the iPad keyboard shortcut bar, status-bar
// rounding in home-screen apps) must not lift the whole app off the bottom.
const MIN_KEYBOARD_HEIGHT_PX = 120;
// Largest viewport shortfall treated as the iOS home-screen quirk below.
const MAX_STANDALONE_GAP_PX = 80;

const isStandaloneDisplay = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches === true
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * How far a full-screen iOS home-screen app's layout viewport falls short of
 * the screen. With the translucent status bar, iOS reports a viewport shorter
 * than the screen while drawing from its top edge, so `bottom: 0` stops above
 * the real bottom. Only measured when the window spans the whole screen width,
 * so Split View, Slide Over and Stage Manager windows are never stretched.
 */
const measureStandaloneGap = (): number => {
  if (!isStandaloneDisplay() || !window.screen) {
    return 0;
  }
  const isLandscape = window.innerWidth > window.innerHeight;
  const screenWidth = isLandscape
    ? Math.max(window.screen.width, window.screen.height)
    : Math.min(window.screen.width, window.screen.height);
  const screenHeight = isLandscape
    ? Math.min(window.screen.width, window.screen.height)
    : Math.max(window.screen.width, window.screen.height);
  if (Math.abs(window.innerWidth - screenWidth) > 2) {
    return 0;
  }
  const gap = screenHeight - window.innerHeight;
  return gap > 0 && gap <= MAX_STANDALONE_GAP_PX ? gap : 0;
};

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari,
 * and down to the screen's bottom edge in iOS home-screen apps.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;

    const update = () => {
      const difference = visualViewport ? window.innerHeight - visualViewport.height : 0;
      const keyboardHeight = difference >= MIN_KEYBOARD_HEIGHT_PX ? difference : 0;
      root.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
      // With the keyboard up the bottom edge is the keyboard's, not the screen's.
      root.style.setProperty('--standalone-bottom-gap', `${keyboardHeight > 0 ? 0 : measureStandaloneGap()}px`);
    };

    update();
    visualViewport?.addEventListener('resize', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      visualViewport?.removeEventListener('resize', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
}
