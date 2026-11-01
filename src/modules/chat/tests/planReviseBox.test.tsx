import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import PermissionContext from '@/modules/chat/context/PermissionContext';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';

/**
 * The plan card's revision box: it wraps whatever is typed, grows with it up
 * to a max height, keeps Cancel and Send on their own row below it, and keeps
 * that row in view so the floating composer never covers Send.
 */
function openRevisionBox() {
  const handlePermissionDecision = vi.fn();
  render(
    <PermissionContext.Provider
      value={{ pendingPermissionRequests: [{ requestId: 'plan-1', toolName: 'ExitPlanMode', input: { plan: '1. Do it' } }], handlePermissionDecision }}
    >
      <PlanDisplay title="Plan" content="1. Do it" toolName="ExitPlanMode" defaultOpen />
    </PermissionContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
  const textarea = screen.getByPlaceholderText('What should change?') as HTMLTextAreaElement;
  return { handlePermissionDecision, textarea, send: screen.getByRole('button', { name: 'Send changes' }) };
}

describe('plan revision box', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    // jsdom has no scrollIntoView; the card calls it to keep its footer in view.
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('wraps long text, even with no spaces, and scrolls past its max height instead of sizing by hand', () => {
    const { textarea } = openRevisionBox();
    for (const name of ['w-full', 'min-w-0', 'whitespace-pre-wrap', 'break-words', '[overflow-wrap:anywhere]', 'resize-none', 'overflow-y-auto', 'max-h-[40vh]', 'sm:max-h-60']) {
      expect(textarea.classList.contains(name)).toBe(true);
    }
    expect(document.activeElement).toBe(textarea);
  });

  it('grows with its content and keeps the footer in view as it does', () => {
    const { textarea } = openRevisionBox();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    scrollIntoView.mockClear();

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 180 });
    fireEvent.change(textarea, { target: { value: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7' } });

    expect(textarea.style.height).toBe('180px');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    // The footer, holding the box and its buttons, is what is kept in view.
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(textarea.parentElement);
  });

  it('puts Cancel and Send on their own right-aligned row below the box, wrapping when narrow', () => {
    const { textarea, send } = openRevisionBox();
    const row = send.parentElement as HTMLElement;
    expect(row).toBe(screen.getByRole('button', { name: 'Cancel' }).parentElement);
    expect(row.contains(textarea)).toBe(false);
    expect(textarea.nextElementSibling).toBe(row);
    for (const name of ['flex', 'flex-wrap', 'justify-end']) {
      expect(row.classList.contains(name)).toBe(true);
    }
  });

  it('keeps Send disabled until there is something to send', () => {
    const { textarea, send, handlePermissionDecision } = openRevisionBox();
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: '   \n ' } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: 'Skip step 3' } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends on Cmd+Enter or Ctrl+Enter, but a plain Enter is a new line', () => {
    const { textarea, handlePermissionDecision } = openRevisionBox();
    fireEvent.change(textarea, { target: { value: 'Skip step 3' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(handlePermissionDecision).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(handlePermissionDecision).toHaveBeenCalledWith('plan-1', { allow: false, message: expect.stringMatching(/: Skip step 3$/) });

    cleanup();
    localStorage.clear();
    const second = openRevisionBox();
    fireEvent.change(second.textarea, { target: { value: 'Drop step 1' } });
    fireEvent.keyDown(second.textarea, { key: 'Enter', ctrlKey: true });
    expect(second.handlePermissionDecision).toHaveBeenCalledWith('plan-1', { allow: false, message: expect.stringMatching(/: Drop step 1$/) });
  });
});
