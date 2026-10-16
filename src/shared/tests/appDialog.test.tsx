import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { AppDialogHost, alertDialog, confirmDialog } from '@/shared/ui';

/**
 * confirmDialog / alertDialog answer like window.confirm / window.alert, in a
 * themed dialog while the host is mounted and through the browser's otherwise.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppDialog', () => {
  it('asks in a themed dialog and resolves with the answer', async () => {
    const native = vi.spyOn(window, 'confirm');
    render(<AppDialogHost />);

    let answer: Promise<boolean> = Promise.resolve(false);
    act(() => { answer = confirmDialog('Delete this?\nIt cannot be undone.', { confirmLabel: 'Delete', destructive: true }); });

    expect(screen.getByRole('alertdialog').textContent).toContain('It cannot be undone.');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(native).not.toHaveBeenCalled();
  });

  it('treats Cancel and Escape as "no"', async () => {
    render(<AppDialogHost />);

    let first: Promise<boolean> = Promise.resolve(true);
    act(() => { first = confirmDialog('First?'); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(first).resolves.toBe(false);

    let second: Promise<boolean> = Promise.resolve(true);
    act(() => { second = confirmDialog('Second?'); });
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(second).resolves.toBe(false);
  });

  it('shows requests one at a time, in order', async () => {
    render(<AppDialogHost />);

    let confirmAnswer: Promise<boolean> = Promise.resolve(false);
    let alertDone: Promise<void> = Promise.resolve();
    act(() => {
      confirmAnswer = confirmDialog('Question one');
      alertDone = alertDialog('Notice two');
    });

    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog').textContent).toContain('Question one');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(confirmAnswer).resolves.toBe(true);

    expect(screen.getByRole('alertdialog').textContent).toContain('Notice two');
    // An alert has only the one button.
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(alertDone).resolves.toBeUndefined();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('falls back to the browser\'s dialogs when no host is mounted', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const nativeAlert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await expect(confirmDialog('Proceed?')).resolves.toBe(true);
    await alertDialog('Done');

    expect(nativeConfirm).toHaveBeenCalledWith('Proceed?');
    expect(nativeAlert).toHaveBeenCalledWith('Done');
  });
});
