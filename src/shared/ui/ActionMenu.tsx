import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Button } from '@/shared/ui/Button';

type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
type ButtonSize = 'default' | 'sm' | 'lg' | 'icon';

export type ActionMenuItem = {
  key: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  loading?: boolean;
  isDanger?: boolean;
  showDividerBefore?: boolean;
  closeOnSelect?: boolean;
};

type ActionMenuProps = {
  label: string;
  items: ActionMenuItem[];
  icon?: LucideIcon;
  ariaLabel?: string;
  align?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  iconOnly?: boolean;
  portal?: boolean;
  header?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  /**
   * Opens the menu at a viewport point, e.g. where a row was right-clicked.
   * Pass a new object per request; requires `portal`.
   */
  openAt?: { x: number; y: number } | null;
  /** No visible button: the menu only opens through `openAt` (a pure context menu). */
  hideTrigger?: boolean;
};

/** Context-menu requests (`openAt` objects) already opened; see ActionMenu. */
const servedOpenAtRequests = new WeakSet<object>();

/** Used by the mcp and sidebar modules for the "…" overflow menu on a server or session row. */
export function ActionMenu({
  label,
  items,
  icon: TriggerIcon,
  ariaLabel,
  align = 'right',
  variant = 'outline',
  size = 'sm',
  className,
  triggerClassName,
  menuClassName,
  disabled,
  iconOnly = false,
  portal = false,
  header,
  onOpenChange,
  openAt,
  hideTrigger = false,
}: ActionMenuProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [portalPosition, setPortalPosition] = React.useState<{ top: number; left: number } | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  // Whether closing should move focus back to the trigger. Set for keyboard
  // (Escape) and item selection, but left false for outside pointer clicks so
  // focus is not stolen from wherever the user clicked.
  const restoreFocusRef = React.useRef(false);
  const focusMenuOnOpenRef = React.useRef(false);
  const wasOpenRef = React.useRef(false);
  const menuId = React.useId();

  const setMenuOpen = React.useCallback((open: boolean) => {
    setIsOpen(open);
    if (!open) {
      setPortalPosition(null);
    }
    onOpenChange?.(open);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (!isOpen) {
      return;
    }

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current
        && !rootRef.current.contains(target)
        && !menuRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        restoreFocusRef.current = true;
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen, setMenuOpen]);

  React.useEffect(() => {
    if (!isOpen || !portal) {
      return;
    }

    const closeOnViewportChange = () => setMenuOpen(false);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('scroll', closeOnViewportChange, true);
    return () => {
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('scroll', closeOnViewportChange, true);
    };
  }, [isOpen, portal, setMenuOpen]);

  // Move focus into the menu on open and back to the trigger on a keyboard or
  // selection close, so keyboard and screen-reader navigation match the menu role.
  React.useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      if (focusMenuOnOpenRef.current) {
        const menu = menuRef.current;
        const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
        (firstItem ?? menu)?.focus();
      }
      return;
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      if (restoreFocusRef.current) {
        triggerRef.current?.focus();
      }
      restoreFocusRef.current = false;
    }
  }, [isOpen]);

  const runItem = (item: ActionMenuItem) => {
    if (item.disabled || item.loading) {
      return;
    }

    if (item.closeOnSelect !== false) {
      restoreFocusRef.current = true;
      setMenuOpen(false);
    }
    item.onSelect();
  };

  const menuWidth = 260;
  const estimatedMenuHeight = (header ? 52 : 0)
    + items.reduce((height, item) => height + (item.description ? 50 : 32) + (item.showDividerBefore ? 9 : 0), 12);

  const toggleMenu = () => {
    if (isOpen) {
      setMenuOpen(false);
      return;
    }

    if (portal && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPortalPosition({
        top: rect.bottom + 6 + estimatedMenuHeight <= window.innerHeight - 8
          ? rect.bottom + 6
          : Math.max(8, rect.top - estimatedMenuHeight - 6),
        left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      });
    }
    setMenuOpen(true);
  };

  // A context-menu request opens the menu at the pointer, kept on screen. Each
  // request is served once, so a re-render (new items, a closed menu) never
  // reopens it; only a new `openAt` object does. Remembered outside the
  // component: callers keep the last point in state, and a menu unmounted
  // meanwhile (a row being renamed or selected) reopened at it when it came back.
  React.useEffect(() => {
    if (!openAt || !portal || servedOpenAtRequests.has(openAt)) {
      return;
    }
    servedOpenAtRequests.add(openAt);
    setPortalPosition({
      top: Math.max(8, Math.min(openAt.y, window.innerHeight - estimatedMenuHeight - 8)),
      left: Math.max(8, Math.min(openAt.x, window.innerWidth - menuWidth - 8)),
    });
    setMenuOpen(true);
  }, [openAt, portal, estimatedMenuHeight, setMenuOpen]);

  const menu = isOpen && (!portal || portalPosition) && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      tabIndex={-1}
      data-escape-layer
      className={cn(
        portal ? 'fixed z-[70]' : 'absolute top-full z-50 mt-2',
        'min-w-[220px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        'animate-in fade-in-0 zoom-in-95',
        !portal && (align === 'right' ? 'right-0' : 'left-0'),
        menuClassName,
      )}
      style={portal && portalPosition ? portalPosition : undefined}
    >
      {header}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <React.Fragment key={item.key}>
            {item.showDividerBefore && <div className="mx-2 my-1 h-px bg-border" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled || item.loading}
              onClick={() => runItem(item)}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                'focus:outline-none focus-visible:bg-accent',
                item.disabled || item.loading
                  ? 'cursor-not-allowed opacity-50'
                  : item.isDanger
                    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950'
                    : 'hover:bg-accent',
              )}
            >
              {item.loading ? (
                <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" />
              ) : (
                Icon && <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 opacity-70" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block leading-5">{item.label}</span>
                {item.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );

  return (
    // A pure context menu takes no room: its menu is portalled out anyway.
    <div ref={rootRef} className={cn('relative inline-flex', className, hideTrigger && portal && 'hidden')}>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size={size}
        className={cn(triggerClassName, hideTrigger && 'hidden')}
        disabled={disabled}
        aria-label={ariaLabel || label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={(event) => {
          focusMenuOnOpenRef.current = event.detail === 0;
          toggleMenu();
        }}
      >
        {TriggerIcon && <TriggerIcon className="h-4 w-4" />}
        {!iconOnly && (
          <>
            <span>{label}</span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
          </>
        )}
      </Button>

      {portal && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu}
    </div>
  );
}
