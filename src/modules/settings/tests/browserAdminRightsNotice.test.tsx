import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { TFunction } from 'i18next';

import BrowserAdminRightsNotice from '@/modules/settings/tabs/browser-use-settings/BrowserAdminRightsNotice';

const t = ((key: string) => key) as unknown as TFunction;
const ENGINE_COMMAND = '/home/me/.nvm/versions/node/v22/bin/node /srv/cloudcli/node_modules/patchright/cli.js';

describe('BrowserAdminRightsNotice', () => {
  it('gives Linux admin commands by full path, since sudo drops an nvm Node and npx', () => {
    const view = render(
      <BrowserAdminRightsNotice choice="patchright-chrome" platform="linux" isAdministrator={false} engineCommand={ENGINE_COMMAND} t={t} />,
    );
    const commands = Array.from(view.container.querySelectorAll('code')).map((node) => node.textContent);

    expect(commands).toContain(`sudo ${ENGINE_COMMAND} install chrome`);
    expect(commands).toContain(`sudo ${ENGINE_COMMAND} install-deps chromium`);
    expect(commands.join('\n')).not.toMatch(/npx/);
  });

  it('runs the Windows command from PowerShell as given', () => {
    const command = '& "C:\\Program Files\\nodejs\\node.exe" "C:\\cloudcli\\node_modules\\patchright\\cli.js"';
    const view = render(
      <BrowserAdminRightsNotice choice="patchright-chrome" platform="win32" isAdministrator={false} engineCommand={command} t={t} />,
    );

    expect(view.getByText(`${command} install chrome`)).toBeTruthy();
  });
});
