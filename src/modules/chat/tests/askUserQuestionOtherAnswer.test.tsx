import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import type { PendingPermissionRequest } from '@/shared/types';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

/**
 * The question panel's "Other" answer is a textarea that wraps whatever is
 * typed (even one unbroken word), grows with it, takes Shift+Enter as a new
 * line, answers on Enter, and leaves an IME composition's Enter alone.
 */

const LONG_UNBROKEN = 'k'.repeat(200);

const twoQuestions: PendingPermissionRequest = {
  requestId: 'ask-1',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        options: [{ label: 'Helper', description: 'extract it' }, { label: 'Inline', description: 'keep it' }],
        multiSelect: false,
      },
      {
        question: 'Anything else to change?',
        header: 'Follow-up',
        options: [{ label: 'No', description: 'ship it' }],
        multiSelect: false,
      },
    ],
  },
};

// Renders the panel the way ChatComposer does, through the permission banner.
function renderPanel(request: PendingPermissionRequest = twoQuestions) {
  const handlePermissionDecision = vi.fn();
  render(
    <PermissionRequestsBanner
      pendingPermissionRequests={[request]}
      providerLabel="Claude"
      handlePermissionDecision={handlePermissionDecision}
      handleGrantToolPermission={() => ({ success: true })}
    />,
  );
  return { handlePermissionDecision };
}

function pickOther() {
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  return screen.getByPlaceholderText('Type your answer...') as HTMLTextAreaElement;
}

describe('question panel "Other" answer', () => {
  afterEach(() => {
    cleanup();
  });

  it('is a wrapping textarea, even for one long unbroken word', () => {
    renderPanel();
    const answer = pickOther();

    expect(answer.tagName).toBe('TEXTAREA');
    // Outside the options' own scroll area (the radiogroup), so the growing
    // box grows the panel instead of being clipped by that area.
    expect(screen.getByRole('radiogroup').contains(answer)).toBe(false);
    fireEvent.change(answer, { target: { value: LONG_UNBROKEN } });
    expect(answer.value).toBe(LONG_UNBROKEN);
    for (const cls of ['whitespace-pre-wrap', 'break-words', '[overflow-wrap:anywhere]', 'max-h-40', 'overflow-y-auto', 'resize-none']) {
      expect(answer.classList.contains(cls)).toBe(true);
    }
  });

  it('starts a new line on Shift+Enter without answering or moving on', () => {
    const { handlePermissionDecision } = renderPanel();
    const answer = pickOther();
    fireEvent.change(answer, { target: { value: 'first line' } });

    const shiftEnter = fireEvent.keyDown(answer, { key: 'Enter', shiftKey: true });

    // Not prevented, so the browser inserts the newline itself.
    expect(shiftEnter).toBe(true);
    expect(handlePermissionDecision).not.toHaveBeenCalled();
    expect(screen.getByText('Which approach?')).toBeTruthy();
  });

  it('answers with the typed text on Enter at the last question', () => {
    const { handlePermissionDecision } = renderPanel();

    // Enter on the first question's answer moves on to the second.
    const first = pickOther();
    fireEvent.change(first, { target: { value: 'Use the shared withRetry' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
    expect(screen.getByText('Anything else to change?')).toBeTruthy();

    const last = pickOther();
    fireEvent.change(last, { target: { value: `line one\nline two ${LONG_UNBROKEN}` } });
    const enter = fireEvent.keyDown(last, { key: 'Enter' });

    expect(enter).toBe(false);
    expect(handlePermissionDecision).toHaveBeenCalledTimes(1);
    const [ids, decision] = handlePermissionDecision.mock.calls[0];
    expect(ids).toBe('ask-1');
    expect(decision.allow).toBe(true);
    expect(decision.updatedInput.answers).toEqual({
      'Which approach?': 'Use the shared withRetry',
      'Anything else to change?': `line one\nline two ${LONG_UNBROKEN}`,
    });
  });

  it('leaves an IME composition Enter alone', () => {
    const { handlePermissionDecision } = renderPanel();
    // Go to the last question so a stray Enter would submit.
    const first = pickOther();
    fireEvent.change(first, { target: { value: 'a' } });
    fireEvent.keyDown(first, { key: 'Enter' });
    const last = pickOther();
    fireEvent.change(last, { target: { value: 'にほんご' } });

    const composingEnter = fireEvent.keyDown(last, { key: 'Enter', isComposing: true });

    expect(composingEnter).toBe(true);
    expect(handlePermissionDecision).not.toHaveBeenCalled();
  });

  it('grows to fit what is typed', () => {
    renderPanel();
    const answer = pickOther();
    // jsdom has no layout; report the content height the browser would.
    let contentHeight = 32;
    Object.defineProperty(answer, 'scrollHeight', { configurable: true, get: () => contentHeight });

    fireEvent.change(answer, { target: { value: 'short' } });
    expect(answer.style.height).toBe('32px');

    contentHeight = 112;
    fireEvent.change(answer, { target: { value: `${LONG_UNBROKEN}\nmore\nand more` } });
    expect(answer.style.height).toBe('112px');
  });
});
