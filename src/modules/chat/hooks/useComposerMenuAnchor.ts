import { useCallback, useEffect, useRef, useState } from 'react';

import type { ComposerMenuAnchor } from '@/shared/types';


const VIEWPORT_MARGIN = 8;
const MENU_GAP = 8;

/**
 * Positions a composer popover above its trigger, aligned to the trigger's
 * side of the window: right-aligned for a trigger on the right (the model
 * menu), left-aligned for one on the left (the permission menu). Right-aligned
 * on a phone, a menu from a trigger near the left edge ran off the screen,
 * since it cannot be narrower than its content.
 *
 * Anchoring with `bottom` rather than `top` lets the menu grow upward without
 * measuring itself first, so it never paints in the wrong spot for a frame.
 */
export function useComposerMenuAnchor(
  isOpen: boolean,
  onClose: () => void,
  preferredWidth = 320,
) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<ComposerMenuAnchor | null>(null);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const bottom = window.innerHeight - rect.top + MENU_GAP;
    const maxHeight = Math.max(160, rect.top - MENU_GAP - VIEWPORT_MARGIN);
    const opensRightward = rect.left + rect.width / 2 < window.innerWidth / 2;
    if (opensRightward) {
      const left = Math.max(VIEWPORT_MARGIN, rect.left);
      setAnchor({
        left,
        bottom,
        maxHeight,
        maxWidth: Math.min(preferredWidth, window.innerWidth - left - VIEWPORT_MARGIN),
      });
      return;
    }
    const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
    setAnchor({
      right,
      bottom,
      maxHeight,
      maxWidth: Math.min(preferredWidth, window.innerWidth - right - VIEWPORT_MARGIN),
    });
  }, [preferredWidth]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        onClose();
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    updateAnchor();

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [isOpen, onClose, updateAnchor]);

  return { triggerRef, menuRef, anchor, updateAnchor };
}
