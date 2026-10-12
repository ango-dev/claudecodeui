import { describe, expect, it } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';

import { ActionMenu } from '@/shared/ui';

const items = [{ key: 'rename', label: 'Rename', onSelect: () => {} }];

describe('ActionMenu openAt', () => {
  it('opens at a right-click point once, and not again when it is mounted anew with the same point', () => {
    const point = { x: 40, y: 60 };
    const first = render(<ActionMenu label="Session" items={items} portal hideTrigger openAt={point} />);
    expect(screen.getByRole('menu')).toBeTruthy();
    first.unmount();

    // A row that was renamed or selected mounts its menu again, with the
    // parent still holding the last point.
    render(<ActionMenu label="Session" items={items} portal hideTrigger openAt={point} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens for a new right-click', () => {
    const view = render(<ActionMenu label="Session" items={items} portal hideTrigger openAt={{ x: 1, y: 2 }} />);
    view.unmount();
    render(<ActionMenu label="Session" items={items} portal hideTrigger openAt={{ x: 1, y: 2 }} />);
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});
