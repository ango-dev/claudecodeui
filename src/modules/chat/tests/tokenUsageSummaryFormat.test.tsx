import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { describe, it, vi } from 'vitest';

import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';

// This fork shows the count in the context ring's tooltip, as "(used / total)".
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { used?: string }) => values?.used ?? key }),
}));

const shownCount = (used: number) => {
  const { getByRole, unmount } = render(<TokenUsageSummary usage={{ used, total: 20_000_000 }} />);
  const text = getByRole('button').getAttribute('title');
  unmount();
  return text;
};

describe('TokenUsageSummary count', () => {
  it('carries a count that rounds up into the next unit', () => {
    assert.equal(shownCount(9_949), '9.9K');
    assert.equal(shownCount(9_960), '10K');
    assert.equal(shownCount(376_000), '376K');
    assert.equal(shownCount(999_499), '999K');
    // "1M", not "1.0M": this fork drops a trailing ".0" from millions.
    assert.equal(shownCount(999_600), '1M');
    assert.equal(shownCount(9_960_000), '10M');
  });
});
