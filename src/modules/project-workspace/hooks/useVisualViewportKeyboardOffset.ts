import { useEffect } from 'react';

// A software keyboard is far taller than this; smaller differences between the
// layout and visual viewport (the iPad keyboard shortcut bar, status-bar
// rounding in home-screen apps) are not a keyboard.
const MIN_KEYBOARD_HEIGHT_PX = 120;
// Largest viewport shortfall treated as the iOS home-screen quirk below.
const MAX_STANDALONE_GAP_PX = 80;

const isStandaloneDisplay = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches === true
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * The height a full-screen iOS home-screen app should fill: the screen's.
 *
 * With the translucent status bar, iOS reports a viewport shorter than the
 * screen while drawing from its top edge, so a shell sized to the viewport
 * stops short of the real bottom. Only used when the window spans (nearly) the
 * whole screen width, so Split View, Slide Over and Stage Manager windows keep
 * the viewport's height.
 */
const getStandaloneScreenHeight = (): number | null => {
  if (!isStandaloneDisplay() || !window.screen) {
    return null;
  }
  const isLandscape = window.innerWidth > window.innerHeight;
  const screenWidth = isLandscape
    ? Math.max(window.screen.width, window.screen.height)
    : Math.min(window.screen.width, window.screen.height);
  const screenHeight = isLandscape
    ? Math.min(window.screen.width, window.screen.height)
    : Math.max(window.screen.width, window.screen.height);
  if (window.innerWidth < screenWidth * 0.9) {
    return null;
  }
  const gap = screenHeight - window.innerHeight;
  return gap >= 0 && gap <= MAX_STANDALONE_GAP_PX ? screenHeight : null;
};

/**
 * Places the workspace shell over what is actually on screen, through
 * `--app-offset-top` (in page coordinates) and `--app-height` (see
 * ProjectWorkspaceShell, which is absolutely positioned in the page).
 *
 * With the iOS keyboard up the shell follows the visual viewport: iOS also
 * scrolls the page to keep the focused input in view, so lifting the shell by
 * the keyboard height on top of that pushed the whole app off the top of the
 * screen. With the keyboard down it fills the window, or the whole screen in
 * an iOS home-screen app.
 */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;
    let keyboardWasOpen = false;

    const update = () => {
      const viewportHeight = visualViewport?.height ?? window.innerHeight;
      // A pinch zoom also shrinks the visual viewport; only an unzoomed one
      // that has lost this much height has a keyboard over it.
      const isZoomed = (visualViewport?.scale ?? 1) > 1.01;
      const keyboardOpen = !isZoomed && window.innerHeight - viewportHeight >= MIN_KEYBOARD_HEIGHT_PX;

      if (keyboardOpen) {
        root.style.setProperty('--app-offset-top', `${visualViewport?.pageTop ?? window.scrollY}px`);
        root.style.setProperty('--app-height', `${viewportHeight}px`);
      } else {
        // iOS can leave the page scrolled after the keyboard goes; the document
        // never scrolls on purpose (html and body clip), so put it back.
        if (keyboardWasOpen && window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
        // Wherever the page is scrolled (iOS can scroll it even though it
        // clips), the shell sits at the top of what is on screen.
        root.style.setProperty('--app-offset-top', `${window.scrollY}px`);
        root.style.setProperty('--app-height', `${getStandaloneScreenHeight() ?? window.innerHeight}px`);
      }
      keyboardWasOpen = keyboardOpen;
    };

    update();
    // iOS home-screen apps can settle their viewport after the first paint
    // without a resize event.
    const settleTimer = window.setTimeout(update, 500);
    visualViewport?.addEventListener('resize', update);
    visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update);
    window.addEventListener('orientationchange', update);
    window.addEventListener('pageshow', update);
    return () => {
      window.clearTimeout(settleTimer);
      visualViewport?.removeEventListener('resize', update);
      visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update);
      window.removeEventListener('orientationchange', update);
      window.removeEventListener('pageshow', update);
    };
  }, []);
}
