import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Markdown } from '@/modules/chat/transcript/Markdown';

const list = (from: number, count: number) => Array.from({ length: count }, (_, i) => `${from + i}. item`).join('\n');

describe('Markdown numbered lists', () => {
  it('leave room for the widest number, so "10." is not cut to "0."', () => {
    const view = render(<Markdown>{list(1, 12)}</Markdown>);
    expect(view.container.querySelector('ol')?.style.paddingLeft).toBe('calc(2ch + 1em)');
  });

  it('count from where the list starts', () => {
    const view = render(<Markdown>{list(98, 3)}</Markdown>);
    expect(view.container.querySelector('ol')?.style.paddingLeft).toBe('calc(3ch + 1em)');
  });

  it('give short lists the room of one digit', () => {
    const view = render(<Markdown>{list(1, 3)}</Markdown>);
    expect(view.container.querySelector('ol')?.style.paddingLeft).toBe('calc(1ch + 1em)');
  });
});
