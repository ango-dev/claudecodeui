import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { dragSelectRowProps, useSidebarDragSelect } from '@/modules/sidebar/hooks/useSidebarDragSelect';
import type { SidebarSessionSelection } from '@/shared/types';

const IDS = ['a', 'b', 'c', 'd', 'e'];
const ROW_HEIGHT = 40;

function List({ selected, onSet }: { selected: Set<string>; onSet: (selection: SidebarSessionSelection) => void }) {
  useSidebarDragSelect({ scopeId: 'list', selectableIds: IDS, selectedIds: selected, onSetSelection: onSet });
  return <div>{IDS.map((id) => <div key={id} {...dragSelectRowProps('list', id)}>{id}</div>)}</div>;
}

/** jsdom has no layout: row i covers y from i*40 to i*40+39. */
function stubLayout(container: HTMLElement) {
  // jsdom has no elementFromPoint at all.
  document.elementFromPoint = (_x: number, y: number) => (
    container.querySelectorAll('[data-select-id]')[Math.floor(y / ROW_HEIGHT)] ?? null
  );
}

function touch(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { identifier: 1, clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
  document.dispatchEvent(event);
  return event;
}

const rowY = (index: number) => index * ROW_HEIGHT + 20;

describe('drag selection on touch screens', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ticks every row a sideways-then-down drag passes', () => {
    const onSet = vi.fn();
    const view = render(<List selected={new Set()} onSet={onSet} />);
    stubLayout(view.container);
    touch('touchstart', 50, rowY(1));
    touch('touchmove', 70, rowY(1));
    const move = touch('touchmove', 70, rowY(3));
    // The list does not scroll while selecting, and no click follows.
    expect(move.defaultPrevented).toBe(true);
    expect(touch('touchend', 70, rowY(3)).defaultPrevented).toBe(true);
    expect([...(onSet.mock.calls.at(-1)?.[0].sessionIds ?? [])]).toEqual(['b', 'c', 'd']);
  });

  it('unticks when the drag starts on a ticked row', () => {
    const onSet = vi.fn();
    const view = render(<List selected={new Set(['a', 'b', 'c'])} onSet={onSet} />);
    stubLayout(view.container);
    touch('touchstart', 50, rowY(2));
    touch('touchmove', 30, rowY(2));
    touch('touchmove', 30, rowY(1));
    touch('touchend', 30, rowY(1));
    expect([...(onSet.mock.calls.at(-1)?.[0].sessionIds ?? [])]).toEqual(['a']);
  });

  it('leaves a vertical swipe to scroll the list', () => {
    const onSet = vi.fn();
    const view = render(<List selected={new Set()} onSet={onSet} />);
    stubLayout(view.container);
    touch('touchstart', 50, rowY(1));
    const move = touch('touchmove', 50, rowY(3));
    expect(move.defaultPrevented).toBe(false);
    touch('touchend', 50, rowY(3));
    expect(onSet).not.toHaveBeenCalled();
  });

  it('does nothing outside select mode', () => {
    const onSet = vi.fn();
    function Idle() {
      useSidebarDragSelect({ scopeId: 'list', selectableIds: IDS, selectedIds: null, onSetSelection: onSet });
      return <div>{IDS.map((id) => <div key={id} {...dragSelectRowProps('list', id)}>{id}</div>)}</div>;
    }
    const view = render(<Idle />);
    stubLayout(view.container);
    touch('touchstart', 50, rowY(0));
    touch('touchmove', 80, rowY(0));
    touch('touchmove', 80, rowY(2));
    expect(onSet).not.toHaveBeenCalled();
  });
});
