import { useSyncExternalStore } from 'react';

/** Matches screens whose primary input cannot hover: phones and tablets. */
const TOUCH_QUERY = '(hover: none)';

let query: MediaQueryList | null = null;
const readQuery = (): MediaQueryList | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return (query ??= window.matchMedia(TOUCH_QUERY));
};

function subscribe(onChange: () => void): () => void {
  const media = readQuery();
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}

const getSnapshot = (): boolean => readQuery()?.matches ?? false;

/**
 * True on a touch screen, which has neither right-click nor modifier keys, so
 * the sidebar shows a bulk-selection toolbar where a pointer gets a menu.
 *
 * One `MediaQueryList` is shared by every caller, and `useSyncExternalStore`
 * re-renders only when the answer actually changes (a trackpad attached to an
 * iPad, say).
 */
export function useTouchScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
