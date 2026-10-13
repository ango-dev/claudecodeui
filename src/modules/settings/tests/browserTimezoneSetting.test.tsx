import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';

import BrowserTimezoneSetting from '@/modules/settings/tabs/browser-use-settings/BrowserTimezoneSetting';
import BrowserMissingHelperNotice from '@/modules/settings/tabs/browser-use-settings/BrowserMissingHelperNotice';

const t = ((key: string, values?: Record<string, string>) => (values ? `${key} ${JSON.stringify(values)}` : key)) as unknown as TFunction;
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

describe('BrowserTimezoneSetting', () => {
  afterEach(cleanup);

  it("offers this device's zone in one tap, and the server's as the default", () => {
    const onChange = vi.fn();
    const view = render(<BrowserTimezoneSetting timezone={null} serverTimezone="UTC" disabled={false} onChange={onChange} t={t} />);
    expect(view.container.textContent).toContain('"zone":"UTC"');
    fireEvent.click(view.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith(deviceZone);
  });

  it('goes back to the server zone, and hides the button once the device zone is chosen', () => {
    const onChange = vi.fn();
    const view = render(<BrowserTimezoneSetting timezone={deviceZone} serverTimezone="UTC" disabled={false} onChange={onChange} t={t} />);
    expect(view.queryByRole('button')).toBeNull();
    fireEvent.change(view.getByRole('combobox'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('BrowserMissingHelperNotice', () => {
  afterEach(cleanup);

  it('names the program, why it is needed and the command to run', () => {
    const view = render(
      <BrowserMissingHelperNotice
        helper={{ id: 'pulseaudio', label: 'PulseAudio', required: true, installed: false, installCommand: 'sudo apt-get install -y pulseaudio' }}
        onInstalled={async () => undefined}
        t={t}
      />,
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('helpers.missingTitle');
    expect(text).toContain('helpers.why.pulseaudio');
    expect(text).toContain('sudo apt-get install -y pulseaudio');
  });
});
