import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import type { PermissionContextValue } from '@/modules/chat/context/PermissionContext';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';

/**
 * A plan can be answered later: while Claude waits on it the buttons answer
 * that request, and once the request is gone the newest plan still takes
 * Build, Revise or Decline as a follow-up message.
 */
function renderPlan(
  context: Partial<PermissionContextValue>,
  plan: { toolId?: string; toolResult?: { content?: unknown; isError?: boolean } | null; content?: string } = {},
) {
  const value: PermissionContextValue = {
    pendingPermissionRequests: [],
    handlePermissionDecision: vi.fn(),
    latestPlanToolId: 'plan-tool-2',
    isSessionBusy: false,
    sendPlanFollowUp: vi.fn(),
    ...context,
  };
  render(
    <PermissionContext.Provider value={value}>
      <PlanDisplay
        title="Plan"
        content={plan.content ?? '1. Do it'}
        toolName="ExitPlanMode"
        toolId={plan.toolId ?? 'plan-tool-2'}
        toolResult={plan.toolResult}
        isStreaming={!plan.toolResult}
        defaultOpen
      />
    </PermissionContext.Provider>,
  );
  return value;
}

describe('answering a plan later', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('builds the newest unanswered plan with a follow-up that leaves plan mode', () => {
    const context = renderPlan({});
    fireEvent.click(screen.getByRole('button', { name: /Build/ }));
    expect(context.sendPlanFollowUp).toHaveBeenCalledWith('I approve the plan above. Go ahead and implement it.', true);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
  });

  it('sends the requested changes, staying in plan mode', () => {
    const context = renderPlan({});
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
    fireEvent.change(screen.getByPlaceholderText('What should change?'), { target: { value: 'Skip step 3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send changes' }));
    expect(context.sendPlanFollowUp).toHaveBeenCalledWith('Please revise the plan: Skip step 3', false);
    expect(screen.getByText('Sent back with changes')).toBeTruthy();
  });

  it('declines without sending anything, and remembers it after a reload', () => {
    const context = renderPlan({});
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(context.sendPlanFollowUp).not.toHaveBeenCalled();
    cleanup();
    renderPlan({});
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });

  it('keeps the buttons on a plan whose request timed out or was interrupted', () => {
    renderPlan({}, { toolResult: { content: '[Request interrupted by user for tool use]', isError: true } });
    expect(screen.getByRole('button', { name: /Build/ })).toBeTruthy();
  });

  it('has no buttons once approved, on an older plan, or while Claude is working', () => {
    renderPlan({}, { toolResult: { content: 'User has approved your plan.', isError: false } });
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
    cleanup();
    renderPlan({}, { toolId: 'plan-tool-1' });
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
    cleanup();
    renderPlan({ isSessionBusy: true });
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
  });

  it('answers its own live request, not another plan\'s', () => {
    const requests = [{ requestId: 'req-2', toolName: 'ExitPlanMode', input: { plan: '1. Do it' } }];
    const live = renderPlan({ pendingPermissionRequests: requests, isSessionBusy: true });
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(live.handlePermissionDecision).toHaveBeenCalledWith('req-2', expect.objectContaining({ allow: false }));
    cleanup();
    localStorage.clear();

    renderPlan({ pendingPermissionRequests: requests, isSessionBusy: true }, { toolId: 'plan-tool-1', content: 'An older plan' });
    expect(screen.queryByRole('button', { name: /Build/ })).toBeNull();
  });
});
