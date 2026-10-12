import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Button } from '@/shared/ui';
import { cn } from '@/shared/utils';

export type SidebarBulkAction = {
  key: string;
  /** The touch toolbar's button, with the count ("Delete 3 sessions"). */
  label: string;
  /** The right-click menu's terser item, as in Claude Code ("Delete 3"). */
  menuLabel: string;
  icon: LucideIcon;
  isDanger?: boolean;
  onSelect: () => void;
};

type SidebarBulkActionsProps = {
  isTouchScreen: boolean;
  /** Disables every action while nothing is ticked. */
  selectedCount: number;
  actions: SidebarBulkAction[];
  /** The touch toolbar's select-all button; it flips to clearing once all are ticked. */
  selectAllLabel: string;
  selectAllDisabled: boolean;
  onToggleSelectAll: () => void;
  onCancel: () => void;
  /** Where a ticked row was right-clicked (pointer screens); see useSidebarBulkSelection. */
  bulkMenuAt: { x: number; y: number } | null;
  t: TFunction;
};

/**
 * Rendered by the sidebar's session lists (a project's sessions, the Sessions
 * tab and the Archive tab) while rows are ticked: with a pointer, a right-click
 * menu of the bulk actions; on a touch screen, which has neither modifier keys
 * nor right-click, a toolbar above the list.
 */
export default function SidebarBulkActions({
  isTouchScreen,
  selectedCount,
  actions,
  selectAllLabel,
  selectAllDisabled,
  onToggleSelectAll,
  onCancel,
  bulkMenuAt,
  t,
}: SidebarBulkActionsProps) {
  if (!isTouchScreen) {
    return (
      <ActionMenu
        label={t('sessions.selectedActions', { defaultValue: 'Selected sessions' })}
        hideTrigger
        portal
        openAt={bulkMenuAt}
        menuClassName="w-[220px] rounded-xl p-1.5 shadow-xl"
        items={[
          ...actions.map((action) => ({
            key: action.key,
            label: action.menuLabel,
            isDanger: action.isDanger,
            disabled: selectedCount === 0,
            onSelect: action.onSelect,
          })),
          {
            key: 'clear',
            label: t('sessions.clearSelectionMenu'),
            showDividerBefore: true,
            onSelect: onCancel,
          },
        ]}
      />
    );
  }

  return (
    <div className="space-y-1 px-1">
      {/* Wraps rather than clips: at the narrowest sidebar width a long
          translated "Select all loaded" leaves no room for Cancel. */}
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onToggleSelectAll}
          disabled={selectAllDisabled}
        >
          {selectAllLabel}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onCancel}
          title="Esc"
        >
          <X className="h-3 w-3" />
          {t('actions.cancel')}
        </Button>
      </div>
      {actions.map(({ key, label, icon: Icon, isDanger, onSelect }) => (
        <Button
          key={key}
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 w-full justify-start gap-2 px-2 text-xs font-medium',
            isDanger
              ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={onSelect}
          disabled={selectedCount === 0}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}
