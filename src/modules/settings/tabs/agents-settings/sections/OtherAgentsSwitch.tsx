import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, TriangleAlert } from 'lucide-react';

import { saveShowOtherAgents, useShowOtherAgents } from '@/shared/agentVisibility';
import SettingsToggle from '@/modules/settings/SettingsToggle';

/**
 * Rendered by AgentCategoryContentSection under an agent's Account panel,
 * folded away under a quiet "Advanced" line: this fork is for Claude Code, and the other agents it can still
 * run (Cursor, Codex, OpenCode) were not tested with its interface, which the
 * switch says before anyone turns them on.
 */
export default function OtherAgentsSwitch() {
  const { t } = useTranslation('settings');
  const showOtherAgents = useShowOtherAgents();
  // Guards the toggle while the server saves (turning on also scans the agents' sessions).
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = (key: string) => t(`agents.otherAgents.${key}`);

  const toggle = async (show: boolean) => {
    setIsSaving(true);
    setError(null);
    try {
      await saveShowOtherAgents(show);
    } catch {
      setError(k('saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <details className="group mt-6 text-xs text-muted-foreground" open={showOtherAgents || undefined}>
      <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
        {k('advanced')}
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-border/60 p-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{k('label')}</div>
            <div className="mt-0.5">{k('description')}</div>
          </div>
          <SettingsToggle
            checked={showOtherAgents}
            onChange={(value) => void toggle(value)}
            ariaLabel={k('label')}
            disabled={isSaving}
          />
        </div>
        <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{k('warning')}</span>
        </p>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </details>
  );
}
