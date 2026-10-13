import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';

import { saveShowOtherAgents, useShowOtherAgents } from '@/shared/agentVisibility';
import SettingsToggle from '@/modules/settings/SettingsToggle';

/**
 * Rendered by AgentsSettingsTab at its very bottom, folded away under
 * "Advanced": this fork is for Claude Code, and the other agents it can still
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
    <details className="group flex-shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground" open={showOtherAgents || undefined}>
      <summary className="cursor-pointer select-none py-1 hover:text-foreground">{k('advanced')}</summary>
      <div className="space-y-2 pb-2 pt-1">
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
