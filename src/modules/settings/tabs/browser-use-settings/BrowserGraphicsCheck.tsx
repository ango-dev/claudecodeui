import { useState } from 'react';
import { CheckCircle2, Cpu, Loader2, TriangleAlert } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { api, readApiJson, ApiRequestError } from '@/shared/api';

export type BrowserGpuStatus = {
  setting: 'auto' | 'off';
  /** /dev/dri/renderD* devices on the server; none on most VPSes. */
  renderNodes: string[];
  /** CloudCLI's process can open a render device. */
  accessible: boolean;
  user: string;
  vulkanDriver: boolean;
  /** The Vulkan GPU flags go to the browser. */
  inUse: boolean;
  groupCommand: string;
  vulkanInstallCommand: string | null;
};

type WebglReport = {
  status: 'hardware' | 'software' | 'unavailable';
  renderer: string | null;
  vendor: string | null;
  webgl2: boolean;
};

type BrowserGraphicsCheckProps = {
  gpu: BrowserGpuStatus;
  platform: string;
  /** Saving disabled while another settings change is in flight. */
  disabled: boolean;
  onGpuChange: (gpu: BrowserGpuStatus['setting']) => void;
  /** Called after a check: it started a browser, so the launch report changed. */
  onChecked?: () => void;
  t: TFunction;
};

type Step = { text: string; command?: string };

/**
 * What to do when WebGL is not on the GPU, from what the server reported:
 * no GPU at all, a GPU CloudCLI's user may not open, no Vulkan driver, or the
 * GPU turned off here. Each step needing admin rights carries its command.
 */
function stepsFor(gpu: BrowserGpuStatus, platform: string, t: TFunction): Step[] {
  const k = (key: string, values?: Record<string, string>) => t(`browserUseSettings.graphics.${key}`, values);
  if (platform !== 'linux') {
    return [{ text: k('otherPlatform') }];
  }
  if (gpu.renderNodes.length === 0) {
    return [{ text: k('noGpu') }];
  }
  const steps: Step[] = [];
  if (!gpu.accessible) {
    steps.push({ text: k('grantAccess', { user: gpu.user }), command: gpu.groupCommand });
  }
  if (!gpu.vulkanDriver && gpu.vulkanInstallCommand) {
    steps.push({ text: k('installVulkan'), command: gpu.vulkanInstallCommand });
  }
  if (steps.length > 0) {
    steps.push({ text: k('restart') });
    return steps;
  }
  if (gpu.setting === 'off') {
    return [{ text: k('turnOn') }];
  }
  return [{ text: k('driverUnsupported') }];
}

/**
 * Used by BrowserUseSettingsTab for the GPU setting and the WebGL check.
 * Without the GPU, Chrome leaves WebGL to software rendering, which it often
 * blocklists outright, and a desktop browser without WebGL looks like a bot to
 * fingerprinting. The check starts a browser exactly as a session would and
 * reports what WebGL shows; when that is not the GPU, it says what to change.
 */
export default function BrowserGraphicsCheck({ gpu, platform, disabled, onGpuChange, onChecked, t }: BrowserGraphicsCheckProps) {
  // The last check's result, until settings change or it is run again.
  const [report, setReport] = useState<WebglReport | null>(null);
  // Guards the button while a browser starts for the check (a second or two).
  const [isChecking, setIsChecking] = useState(false);
  // Why the check could not run, from the server.
  const [failure, setFailure] = useState<string | null>(null);
  const k = (key: string, values?: Record<string, string>) => t(`browserUseSettings.graphics.${key}`, values);

  const runCheck = async () => {
    setIsChecking(true);
    setFailure(null);
    try {
      const data = await readApiJson<{ data: WebglReport }>(await api.browserUse.checkGraphics());
      setReport(data.data);
    } catch (err) {
      setReport(null);
      setFailure(err instanceof ApiRequestError && typeof err.details === 'string' ? err.details : k('checkFailed'));
    } finally {
      setIsChecking(false);
      onChecked?.();
    }
  };

  const onGpu = report?.status === 'hardware';
  const steps = report && !onGpu ? stepsFor(gpu, platform, t) : [];

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="browser-use-gpu" className="text-sm font-medium text-foreground">{k('label')}</label>
        <p className="mt-0.5 text-sm text-muted-foreground">{k('description')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="browser-use-gpu"
          value={gpu.setting}
          disabled={disabled}
          onChange={(event) => {
            setReport(null);
            onGpuChange(event.target.value as BrowserGpuStatus['setting']);
          }}
          className="w-full max-w-md touch-manipulation rounded-lg border border-input bg-card p-2.5 pr-8 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-auto"
        >
          <option value="auto">{k('auto')}</option>
          <option value="off">{k('off')}</option>
        </select>
        <Button type="button" variant="outline" size="sm" onClick={() => void runCheck()} disabled={isChecking}>
          {isChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cpu className="h-4 w-4" />}
          {isChecking ? k('checking') : k('check')}
        </Button>
      </div>

      {failure && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {failure}
        </p>
      )}

      {report && onGpu && (
        <p className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="min-w-0 break-words">{k('onGpu', { renderer: report.renderer ?? '' })}</span>
        </p>
      )}

      {report && !onGpu && (
        <div role="alert" className="space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="min-w-0 space-y-1">
              <div className="font-medium">
                {report.status === 'unavailable' ? k('unavailableTitle') : k('softwareTitle')}
              </div>
              <p className="break-words">
                {report.status === 'unavailable'
                  ? k('unavailableDescription')
                  : k('softwareDescription', { renderer: report.renderer ?? '' })}
              </p>
            </div>
          </div>
          <ol className="list-decimal space-y-2 pl-5">
            {steps.map((step) => (
              <li key={step.text}>
                {step.text}
                {step.command && (
                  <code className="mt-1 block select-all whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
                    {step.command}
                  </code>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
