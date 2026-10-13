import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';

function renderPendingPlan() {
  const handlePermissionDecision = vi.fn();
  const view = render(
    <PermissionContext.Provider
      value={{ pendingPermissionRequests: [{ requestId: 'plan-1', toolName: 'ExitPlanMode' }], handlePermissionDecision }}
    >
      <PlanDisplay title="Plan" content="1. Do it" toolName="ExitPlanMode" defaultOpen />
      <textarea data-testid="composer" />
    </PermissionContext.Provider>,
  );
  return { handlePermissionDecision, composer: view.getByTestId('composer') as HTMLTextAreaElement };
}

describe('PlanDisplay Build shortcut', () => {
  afterEach(cleanup);

  it('builds on ⌘↩ or Ctrl+Enter', () => {
    const { handlePermissionDecision } = renderPendingPlan();
    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).toHaveBeenCalledWith('plan-1', { allow: true });

    handlePermissionDecision.mockClear();
    fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    expect(handlePermissionDecision).toHaveBeenCalledTimes(1);
  });

  it('builds from an empty composer, but sends typed text instead', () => {
    const { handlePermissionDecision, composer } = renderPendingPlan();
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).toHaveBeenCalledTimes(1);

    handlePermissionDecision.mockClear();
    fireEvent.change(composer, { target: { value: 'Use a queue instead' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });

  it('ignores plain Enter', () => {
    const { handlePermissionDecision } = renderPendingPlan();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });
});
