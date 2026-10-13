import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';

/**
 * A pending plan in the chat, a stand-in composer box (marked as ChatComposer
 * marks it) and, elsewhere on the page, another empty field such as the
 * Shell's hidden terminal input.
 */
function renderPendingPlan({ chatHidden = false, composerEmpty = true } = {}) {
  const handlePermissionDecision = vi.fn();
  const view = render(
    <PermissionContext.Provider
      value={{ pendingPermissionRequests: [{ requestId: 'plan-1', toolName: 'ExitPlanMode', input: { plan: '1. Do it' } }], handlePermissionDecision }}
    >
      <div className={chatHidden ? 'hidden' : 'block'}>
        <PlanDisplay title="Plan" content="1. Do it" toolName="ExitPlanMode" defaultOpen />
        <div data-slot="prompt-input-box" data-composer-empty={composerEmpty ? 'true' : 'false'}>
          <textarea data-testid="composer" />
        </div>
      </div>
      <textarea data-testid="elsewhere" />
    </PermissionContext.Provider>,
  );
  return {
    handlePermissionDecision,
    composer: view.getByTestId('composer'),
    elsewhere: view.getByTestId('elsewhere'),
  };
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

  it('builds from an empty composer, but sends what is there instead', () => {
    const empty = renderPendingPlan();
    fireEvent.keyDown(empty.composer, { key: 'Enter', metaKey: true });
    expect(empty.handlePermissionDecision).toHaveBeenCalledTimes(1);
    cleanup();

    // Text, or only an attachment: the keys send it (e.g. to revise the plan).
    const withContent = renderPendingPlan({ composerEmpty: false });
    fireEvent.keyDown(withContent.composer, { key: 'Enter', metaKey: true });
    expect(withContent.handlePermissionDecision).not.toHaveBeenCalled();
  });

  it('leaves the keys to other fields, such as the Shell terminal', () => {
    const { handlePermissionDecision, elsewhere } = renderPendingPlan();
    fireEvent.keyDown(elsewhere, { key: 'Enter', ctrlKey: true });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });

  it('does nothing while the chat tab is hidden', () => {
    const { handlePermissionDecision } = renderPendingPlan({ chatHidden: true });
    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });

  it('ignores plain Enter', () => {
    const { handlePermissionDecision } = renderPendingPlan();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });
});
