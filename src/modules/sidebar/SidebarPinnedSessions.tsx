import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { useSessionPins } from '@/modules/sidebar/hooks/useSessionPins';

/**
 * Rendered by SidebarContent above the Projects and Conversations lists: says
 * when the pin list could not be loaded or saved, with a retry. The pinned
 * sessions themselves are drawn where they belong — at the top of their
 * project (SidebarProjectSessions) and in the Conversations list's Pinned
 * group (SidebarRecentConversations).
 */
export default function SidebarPinnedSessions({ t }: { t: TFunction }) {
  const pins = useSessionPins();
  if (!pins?.hasError) return null;
  return (
    <div
      role="alert"
      className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground"
      data-testid="pinned-sessions-error"
    >
      <span className="min-w-0">{t('pinned.error', 'Could not load or save session pins. Please try again.')}</span>
      <Button variant="ghost" size="sm" className="h-7 flex-shrink-0 px-2 text-xs" onClick={() => void pins.refresh()}>
        {t('buttons.retry', { ns: 'common', defaultValue: 'Try again' })}
      </Button>
    </div>
  );
}
