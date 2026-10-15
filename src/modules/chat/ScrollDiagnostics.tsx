import { useRef, useState } from 'react';

import {
  SCROLL_EXPERIMENTS,
  clearScrollTrace,
  isScrollExperimentOn,
  isScrollTraceEnabled,
  readScrollTrace,
  setScrollExperiment,
  setScrollTraceEnabled,
} from '@/modules/chat/utils/scrollTrace';
import type { ScrollExperimentId } from '@/modules/chat/utils/scrollTrace';

const buttonClass =
  'rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground';

const buildReport = (): string => {
  const { current, previous } = readScrollTrace();
  const earlier = previous
    .map((run, index) => [`== ${index === 0 ? 'Before the last refresh' : `${index + 1} refreshes ago`} ==`, run || '(nothing recorded)', ''])
    .reverse()
    .flat();
  return [...earlier, '== This page ==', current || '(nothing recorded)'].join('\n');
};

/**
 * Rendered by the settings About tab: switches the transcript's scroll
 * recorder (utils/scrollTrace) on and off and shows what it caught, including
 * the run before the last refresh, so a freeze on a real device can be copied
 * out and sent. Temporary, while the stuck "Loading older messages" is chased.
 */
export function ScrollDiagnostics() {
  const [enabled, setEnabled] = useState(isScrollTraceEnabled);
  const [report, setReport] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [experiments, setExperiments] = useState(
    () => new Set(SCROLL_EXPERIMENTS.filter(({ id }) => isScrollExperimentOn(id)).map(({ id }) => id)),
  );
  const toggleExperiment = (id: ScrollExperimentId) => {
    const on = !experiments.has(id);
    setScrollExperiment(id, on);
    setExperiments((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const textRef = useRef<HTMLTextAreaElement>(null);

  const toggle = () => {
    setScrollTraceEnabled(!enabled);
    setEnabled(!enabled);
  };

  const copy = async () => {
    const text = buildReport();
    setReport(text);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Plain http has no clipboard API: select the text for a manual copy instead.
      requestAnimationFrame(() => textRef.current?.select());
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-foreground">Scroll diagnostics</div>
      <p className="text-xs text-muted-foreground">
        Records scrolling and the loading of older messages on this device. Turn it on, reproduce the problem, refresh
        if the app gets stuck, then come back here and copy the log.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={toggle} className={buttonClass}>
          {enabled ? 'Stop recording' : 'Start recording'}
        </button>
        <button type="button" onClick={() => setReport(buildReport())} className={buttonClass}>
          Show log
        </button>
        <button type="button" onClick={() => void copy()} className={buttonClass}>
          {copied ? 'Copied' : 'Copy log'}
        </button>
        <button
          type="button"
          onClick={() => {
            clearScrollTrace();
            setReport(null);
          }}
          className={buttonClass}
        >
          Clear
        </button>
      </div>
      {enabled && <p className="text-xs text-green-600 dark:text-green-400">Recording, also after a refresh.</p>}
      <div className="space-y-1 pt-1">
        <div className="text-xs font-medium text-foreground">Experiments on this device</div>
        <p className="text-xs text-muted-foreground">Each turns one suspect off. Refresh after changing them.</p>
        {SCROLL_EXPERIMENTS.map(({ id, label }) => (
          <label key={id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={experiments.has(id)} onChange={() => toggleExperiment(id)} />
            {label}
          </label>
        ))}
      </div>
      {report && (
        <textarea
          ref={textRef}
          readOnly
          value={report}
          className="h-64 w-full resize-y rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-4 text-foreground"
        />
      )}
    </div>
  );
}
