import { isPhoneSizedScreen } from '@/shared/hooks/useDeviceSettings';

/**
 * True while the sidebar is in its touch layout: on phone-sized screens, the
 * same test that makes the sidebar a slide-over there.
 *
 * Every sidebar row has two designs — a tappable card and a dense desktop
 * button — and both used to be rendered with the wrong one hidden by CSS. On a
 * workspace with a few projects expanded that made roughly two in five sidebar
 * DOM nodes invisible markup that React still had to build, diff and hold. The
 * rows read this instead and render only the design that is on screen.
 *
 * It used to follow the window width, so an iPad window that was briefly or
 * genuinely narrow switched the rows to phone cards; the screen size does not
 * change, so no listener is needed.
 */
export function useCompactSidebar(): boolean {
  return isPhoneSizedScreen();
}
