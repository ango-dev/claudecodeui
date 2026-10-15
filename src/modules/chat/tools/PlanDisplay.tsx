import React, { useEffect, useRef, useState } from 'react';
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

/** How the user answered a plan from its card, remembered so the card says so after a reload. */
type PlanAnswer = 'accepted' | 'revised' | 'declined';

const PLAN_ANSWERS_KEY = 'cloudcli-plan-answers';
const MAX_REMEMBERED_ANSWERS = 50;

const readPlanAnswers = (): Record<string, PlanAnswer> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PLAN_ANSWERS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, PlanAnswer>) : {};
  } catch {
    return {};
  }
};

const savePlanAnswer = (toolId: string, answer: PlanAnswer) => {
  const entries = Object.entries({ ...readPlanAnswers(), [toolId]: answer }).slice(-MAX_REMEMBERED_ANSWERS);
  try {
    localStorage.setItem(PLAN_ANSWERS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Not remembering it only means the buttons can come back after a reload.
  }
};

/** Results that end a plan's request without the user having answered it. */
const UNANSWERED_RESULT = /timed out|cancell?ed|interrupted/i;

const isPlanRequest = (toolName: string) => toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode';

const requestPlanText = (input: unknown): string => {
  const plan = (input as { plan?: unknown } | null)?.plan;
  return typeof plan === 'string' ? plan.replace(/\\n/g, '\n') : '';
};

const APPROVE_MESSAGE = 'I approve the plan above. Go ahead and implement it.';
const DECLINE_MESSAGE = 'The user declined this plan. Do not implement it; wait for their next message.';

type PlanDisplayProps = {
  title: string;
  content: string;
  defaultOpen?: boolean;
  isStreaming?: boolean;
  showRawParameters?: boolean;
  rawContent?: string;
  toolName: string;
  toolId?: string;
  /** The plan tool's result: an approval, a rejection, or an ending that left it unanswered. */
  toolResult?: { content?: unknown; isError?: boolean } | null;
};

/**
 * Rendered by chat's ToolRenderer for plan tools (ExitPlanMode), showing the
 * proposed plan inline with Build, Revise and Decline.
 *
 * While Claude waits on the plan, the buttons answer that request. Once the
 * request is gone unanswered (a server restart, an interrupted or ended run),
 * the newest plan keeps them: Build leaves plan mode and tells Claude to go
 * ahead, Revise sends the requested changes, and Decline just closes it.
 */
export const PlanDisplay: React.FC<PlanDisplayProps> = ({
  title,
  content,
  defaultOpen = false,
  isStreaming = false,
  showRawParameters = false,
  rawContent,
  toolName: _toolName,
  toolId,
  toolResult,
}) => {
  const { t } = useTranslation();
  const permissionCtx = usePermission();

  // This plan's own request: the one carrying its text. The only plan request
  // waiting also counts for the newest unanswered plan, in case the text was
  // reformatted on the way.
  const planRequests = permissionCtx?.pendingPermissionRequests.filter((request) => isPlanRequest(request.toolName)) ?? [];
  const isLatestPlan = Boolean(toolId) && toolId === permissionCtx?.latestPlanToolId;
  const pendingRequest = planRequests.find((request) => requestPlanText(request.input) === content)
    ?? (planRequests.length === 1 && !toolResult && isLatestPlan ? planRequests[0] : undefined);

  const [answer, setAnswer] = useState<PlanAnswer | null>(() => (toolId ? readPlanAnswers()[toolId] ?? null : null));
  const [isRevising, setIsRevising] = useState(false);
  const [revision, setRevision] = useState('');

  const resultText = typeof toolResult?.content === 'string' ? toolResult.content : '';
  const wasAnswered = Boolean(toolResult) && !(toolResult?.isError && UNANSWERED_RESULT.test(resultText));
  const isBusy = permissionCtx?.isSessionBusy ?? false;
  // No request left to answer: the newest unanswered plan takes a follow-up message instead.
  const canFollowUp = !pendingRequest
    && !wasAnswered
    && !answer
    && isLatestPlan
    && !isBusy
    && Boolean(permissionCtx?.sendPlanFollowUp);
  const showActions = Boolean(pendingRequest) || canFollowUp;
  // A plan with no result is still being written only while Claude is working.
  const showStreaming = isStreaming && (isBusy || Boolean(pendingRequest));

  const remember = (next: PlanAnswer) => {
    setAnswer(next);
    setIsRevising(false);
    if (toolId) savePlanAnswer(toolId, next);
  };

  const handleBuild = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, { allow: true });
    } else if (canFollowUp) {
      permissionCtx?.sendPlanFollowUp?.(APPROVE_MESSAGE, true);
    } else {
      return;
    }
    remember('accepted');
  };

  const handleDecline = () => {
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, { allow: false, message: DECLINE_MESSAGE });
    }
    remember('declined');
  };

  const handleSendRevision = () => {
    const changes = revision.trim();
    if (!changes) return;
    if (pendingRequest && permissionCtx) {
      permissionCtx.handlePermissionDecision(pendingRequest.requestId, {
        allow: false,
        message: `${t('chat:misc.userAskedRevise')}: ${changes}`,
      });
    } else if (canFollowUp) {
      permissionCtx?.sendPlanFollowUp?.(`Please revise the plan: ${changes}`, false);
    } else {
      return;
    }
    setRevision('');
    remember('revised');
  };

  // The card, to tell whether the plan is on screen: the chat stays mounted
  // while another tab (Shell, Git, ...) is shown.
  const cardRef = useRef<HTMLDivElement>(null);

  // ⌘↩ (Ctrl+Enter elsewhere) builds, as the button's hint says, while the
  // plan is on screen and the keys are not meant for anything else: focus on
  // nothing in particular, or in the chat composer with nothing to send.
  // With text or attachments there, the same keys send them, e.g. to revise.
  const buildRef = useRef(handleBuild);
  useEffect(() => {
    buildRef.current = handleBuild;
  });
  useEffect(() => {
    if (!showActions || isRevising) return undefined;
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
      buildRef.current();
    };
    // Capture phase: ahead of the composer, which would otherwise take the keys.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showActions, isRevising]);

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <Card ref={cardRef} className="my-1 flex flex-col shadow-none">
        {/* Header — always visible */}
        <CardHeader className="flex flex-row items-start justify-between space-y-0 px-4 pb-0 pt-4">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">
              {showStreaming ? <Shimmer>{title}</Shimmer> : title}
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
            ) : showStreaming ? (
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

        {/* Footer: the plan's answer, or the buttons while it has none. */}
        {showActions && !isRevising && (
          <CardFooter className="justify-end gap-2 border-t border-border/40 px-4 pb-3 pt-3">
            <Button variant="ghost" size="sm" onClick={handleDecline} className="text-muted-foreground">
              Decline
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIsRevising(true)} className="text-muted-foreground">
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
        {showActions && isRevising && (
          <CardFooter className="flex-col items-stretch gap-2 border-t border-border/40 px-4 pb-3 pt-3">
            <textarea
              autoFocus
              value={revision}
              onChange={(event) => setRevision(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  handleSendRevision();
                }
              }}
              rows={3}
              placeholder="What should change?"
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsRevising(false)} className="text-muted-foreground">
                Cancel
              </Button>
              <Button size="sm" onClick={handleSendRevision} disabled={!revision.trim()}>
                Send changes
              </Button>
            </div>
          </CardFooter>
        )}
        {!showActions && answer && (
          <CardFooter className="justify-end border-t border-border/40 px-4 pb-3 pt-3 text-xs text-muted-foreground">
            {answer === 'accepted' ? 'Approved' : answer === 'revised' ? 'Sent back with changes' : 'Declined'}
          </CardFooter>
        )}
      </Card>
    </Collapsible>
  );
};
