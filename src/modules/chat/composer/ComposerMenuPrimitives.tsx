import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/shared/utils';
import type { ComposerMenuAnchor } from '@/shared/types';

/**
 * Shared shell for the composer popovers (model/effort, permissions, schedule
 * and preset prompts) so they share one surface, one heading style and one row
 * style.
 *
 * Used by chat's ComposerModelMenu, ComposerPermissionMenu,
 * ScheduleMessagePopover and PromptPresetMenu.
 */
export function ComposerMenuSurface({
  anchor,
  menuRef,
  ariaLabel,
  className,
  onKeyDown,
  children,
}: {
  anchor: ComposerMenuAnchor;
  menuRef: Ref<HTMLDivElement>;
  ariaLabel: string;
  /** Layout for a menu that scrolls only part of itself, as the preset list does. */
  className?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'fixed z-[100] min-w-48 overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl',
        className,
      )}
      style={{
        left: anchor.left,
        right: anchor.right,
        bottom: anchor.bottom,
        maxHeight: anchor.maxHeight,
        maxWidth: anchor.maxWidth,
      }}
    >
      {children}
    </div>
  );
}

/** Used by chat's ComposerModelMenu, ComposerPermissionMenu, ScheduleMessagePopover and PromptPresetMenu to label a section of the popover. */
export function ComposerMenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>
  );
}

/** Used by chat's ComposerModelMenu, ScheduleMessagePopover and PromptPresetMenu to divide a popover's sections. */
export function ComposerMenuSeparator() {
  return <div className="my-1 h-px bg-border" aria-hidden />;
}

/**
 * Used by chat's ComposerModelMenu, ComposerPermissionMenu,
 * ScheduleMessagePopover and PromptPresetMenu to render one selectable row with
 * its checked state.
 */
export function ComposerMenuItem({
  label,
  description,
  icon,
  isSelected,
  onSelect,
  role = 'menuitemradio',
  trailing,
  disabled,
  title,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  isSelected: boolean;
  onSelect: () => void;
  role?: 'menuitemradio' | 'menuitem';
  trailing?: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemradio' ? isSelected : undefined}
      onClick={onSelect}
      disabled={disabled}
      title={title}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
        isSelected ? 'text-foreground' : 'text-foreground/90',
        className,
      )}
    >
      {icon && <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-5">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>
        )}
      </span>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {trailing ?? (isSelected ? <Check className="h-3.5 w-3.5 text-foreground" /> : null)}
      </span>
    </button>
  );
}
