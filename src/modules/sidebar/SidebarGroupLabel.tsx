import { cn } from '@/shared/utils';

/**
 * A quiet section label inside the sidebar lists ("Pinned", "Recent sessions"),
 * with an optional count on the right. Used by SidebarRecentConversations for
 * its Pinned and Recent groups and by SidebarProjectSessions for the pinned
 * group at the top of a project, so the headings read the same everywhere.
 */
export default function SidebarGroupLabel({ label, count, className }: {
  label: string;
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between px-2 pb-1.5 pt-0.5', className)}>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {count !== undefined && (
        <span className="text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
      )}
    </div>
  );
}
