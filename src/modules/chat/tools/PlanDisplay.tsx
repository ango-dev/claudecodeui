import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsUpDown, FileText } from 'lucide-react';

import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Shimmer,
} from '@/shared/ui';
import { formatShortcut } from '@/shared/utils';
import { usePermission } from '@/modules/chat/context/PermissionContext';
import { MarkdownContent } from '@/modules/chat/tools/ContentRenderers/MarkdownContent';
import { TraceStep, markScrollStep } from '@/modules/chat/utils/scrollTrace';

type PlanDisplayProps = {
  title: string;
  content: string;
  defaultOpen?: boolean;
  isStreaming?: boolean;
  showRawParameters?: boolean;
  rawContent?: string;
  toolName: string;
  toolId?: string;
};

/**
 * Rendered by chat's ToolRenderer for plan tools (ExitPlanMode), showing the
 * proposed plan inline together with its build/revise permission decision.
 */
export const PlanDisplay: React.FC<PlanDisplayProps> = ({
  title,
  content,
  defaultOpen = false,
  isStreaming = false,
  showRawParameters = false,
  rawContent,
  toolName: _toolName,
}) => {
  const { t } = useTranslation();
  const permissionCtx = usePermission();
  markScrollStep(`plan card: ${content.length} chars, streaming=${isStreaming}`);

  const pendingRequest = permissionCtx?.pendingPermissionRequests.find(
    (r) => r.toolName === 'ExitPlanMode' || r.toolName === 'exit_plan_mode'
  );

  const handleBuild = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, { allow: true });
    }
  };

  // The card, to tell whether the plan is on screen: the chat stays mounted
  // while another tab (Shell, Git, ...) is shown.
  const cardRef = useRef<HTMLDivElement>(null);

  // ⌘↩ (Ctrl+Enter elsewhere) builds, as the button's hint says, while the
  // plan is on screen and the keys are not meant for anything else: focus on
  // nothing in particular, or in the chat composer with nothing to send.
  // With text or attachments there, the same keys send them, e.g. to revise.
  useEffect(() => {
    if (!pendingRequest) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Every plan card on screen sees the event; the first one acts.
      if (event.defaultPrevented || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return;
      }
      const card = cardRef.current;
      const isOnScreen = card
        ? (typeof card.checkVisibility === 'function' ? card.checkVisibility() : !card.closest('.hidden, [hidden]'))
        : false;
      if (!isOnScreen) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const focusedNowhere = !target || target === document.body || target === document.documentElement;
      const inEmptyComposer = Boolean(target?.closest('[data-slot="prompt-input-box"][data-composer-empty="true"]'));
      if (!focusedNowhere && !inEmptyComposer) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      permissionCtx?.handlePermissionDecision(pendingRequest.requestId, { allow: true });
    };
    // Capture phase: ahead of the composer, which would otherwise take the keys.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [pendingRequest, permissionCtx]);

  const handleRevise = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, {
        allow: false,
        message: t('chat:misc.userAskedRevise'),
      });
    }
  };

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card ref={cardRef} className="my-1 flex flex-col shadow-none">
        {/* Header — always visible */}
        <CardHeader className="flex flex-row items-start justify-between space-y-0 px-4 pb-0 pt-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">
              {isStreaming ? <Shimmer>{title}</Shimmer> : title}
            </CardTitle>
          </div>
          <CollapsibleTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground">
            <ChevronsUpDown className="h-4 w-4" />
            <span className="sr-only">Toggle plan</span>
          </CollapsibleTrigger>
        </CardHeader>

        {/* Collapsible content */}
        <CollapsibleContent>
          <CardContent className="px-4 pb-4 pt-3">
            {content ? (
              <MarkdownContent
                content={content}
                className="prose prose-sm max-w-none font-serif dark:prose-invert"
              />
            ) : isStreaming ? (
              <div className="py-2">
                <Shimmer>Generating plan...</Shimmer>
              </div>
            ) : null}

            {showRawParameters && rawContent && (
              <Collapsible className="mt-3">
                <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground">
                  <svg
                    className="h-2.5 w-2.5 flex-shrink-0 transition-transform duration-150 data-[state=open]:rotate-90"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  raw params
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-1 overflow-hidden whitespace-pre-wrap break-words rounded border border-border/40 bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                    {rawContent}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </CollapsibleContent>

        <TraceStep step="plan card: content done" />

        {/* Footer — always visible when permission is pending */}
        {pendingRequest && (
          <CardFooter className="justify-end gap-2 border-t border-border/40 px-4 pb-3 pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRevise}
              className="text-muted-foreground"
            >
              Revise
            </Button>
            <Button size="sm" onClick={handleBuild}>
              Build{' '}
              <kbd className="ml-1 rounded bg-primary-foreground/20 px-1 py-0.5 font-mono text-[10px] touch:hidden">
                {formatShortcut('Mod', 'Enter')}
              </kbd>
            </Button>
          </CardFooter>
        )}
        <TraceStep step="plan card: done" />
      </Card>
    </Collapsible>
  );
};
