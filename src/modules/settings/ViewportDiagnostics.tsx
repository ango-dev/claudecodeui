import { useState } from 'react';

/** Measures how tall a fixed element of the given CSS height actually is. */
const probeHeight = (height: string): number => {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;top:0;left:0;width:1px;visibility:hidden;pointer-events:none;height:${height}`;
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return Math.round(measured * 10) / 10;
};

/** Reads the four safe-area insets as resolved pixels. */
const probeSafeArea = (): string => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;'
    + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].join(' ');
  probe.remove();
  return insets;
};

/** Where `position: fixed; bottom: 0` actually lands. */
const probeFixedBottom = (): number => {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const bottom = probe.getBoundingClientRect().bottom;
  probe.remove();
  return Math.round(bottom * 10) / 10;
};

const collect = (): string => {
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const bodyStyle = getComputedStyle(document.body);
  const viewport = window.visualViewport;
  const shell = document.querySelector<HTMLElement>('[data-workspace-shell]')?.getBoundingClientRect();
  const nav = navigator as Navigator & { standalone?: boolean };
  return [
    `display-mode standalone: ${window.matchMedia('(display-mode: standalone)').matches}`,
    `navigator.standalone: ${String(nav.standalone)}`,
    `pwa-mode class: ${document.body.classList.contains('pwa-mode')}`,
    `screen: ${window.screen.width} x ${window.screen.height} (avail ${window.screen.availWidth} x ${window.screen.availHeight})`,
    `inner: ${window.innerWidth} x ${window.innerHeight}, outer: ${window.outerWidth} x ${window.outerHeight}`,
    `documentElement client: ${root.clientWidth} x ${root.clientHeight}`,
    `visualViewport: ${viewport ? `${viewport.width} x ${viewport.height}, offsetTop ${viewport.offsetTop}, scale ${viewport.scale}` : 'none'}`,
    `100vh ${probeHeight('100vh')}, 100lvh ${probeHeight('100lvh')}, 100svh ${probeHeight('100svh')}, 100dvh ${probeHeight('100dvh')}, 100% ${probeHeight('100%')}`,
    `fixed bottom:0 lands at: ${probeFixedBottom()}`,
    `safe-area (t r b l): ${probeSafeArea()}`,
    `--app-height: ${rootStyle.getPropertyValue('--app-height').trim() || 'unset'}, --app-offset-top: ${rootStyle.getPropertyValue('--app-offset-top').trim() || 'unset'}, --shell-top-inset: ${bodyStyle.getPropertyValue('--shell-top-inset').trim() || 'unset'}`,
    `shell: ${shell ? `top ${shell.top}, bottom ${shell.bottom}, height ${shell.height}` : 'not found'}`,
    `scrollY: ${window.scrollY}, devicePixelRatio: ${window.devicePixelRatio}`,
    `userAgent: ${navigator.userAgent}`,
  ].join('\n');
};

/**
 * Rendered by the About tab: the viewport numbers behind the iOS home-screen
 * layout, which only a real device reports. Temporary, while that is fixed.
 */
export default function ViewportDiagnostics() {
  const [report, setReport] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setReport(collect())}
        className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      >
        {report ? 'Measure display again' : 'Show display diagnostics'}
      </button>
      {report && (
        <pre className="whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-4 text-foreground">
          {report}
        </pre>
      )}
    </div>
  );
}
