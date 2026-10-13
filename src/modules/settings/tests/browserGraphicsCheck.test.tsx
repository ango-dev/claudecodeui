import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';

import BrowserGraphicsCheck from '@/modules/settings/tabs/browser-use-settings/BrowserGraphicsCheck';
import type { BrowserGpuStatus } from '@/modules/settings/tabs/browser-use-settings/BrowserGraphicsCheck';

const checkGraphics = vi.fn();
vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api')>();
  return { ...actual, api: { ...actual.api, browserUse: { ...actual.api.browserUse, checkGraphics: () => checkGraphics() } } };
});

const t = ((key: string, values?: Record<string, string>) => (values ? `${key} ${JSON.stringify(values)}` : key)) as unknown as TFunction;
const webgl = (report: object) => new Response(JSON.stringify({ success: true, data: report }), { status: 200, headers: { 'content-type': 'application/json' } });
const SOFTWARE = { status: 'unavailable', renderer: null, vendor: null, webgl2: false };

const gpu = (overrides: Partial<BrowserGpuStatus> = {}): BrowserGpuStatus => ({
  setting: 'auto',
  renderNodes: ['/dev/dri/renderD128'],
  accessible: false,
  user: 'ubuntu',
  vulkanDriver: true,
  inUse: false,
  groupCommand: 'sudo usermod -aG render,video ubuntu',
  vulkanInstallCommand: 'sudo apt-get install -y mesa-vulkan-drivers',
  ...overrides,
});

async function check(status: BrowserGpuStatus, report: object = SOFTWARE) {
  checkGraphics.mockResolvedValueOnce(webgl(report));
  const view = render(<BrowserGraphicsCheck gpu={status} platform="linux" disabled={false} onGpuChange={() => undefined} t={t} />);
  fireEvent.click(view.getByText('browserUseSettings.graphics.check'));
  await waitFor(() => expect(view.container.textContent).toMatch(/graphics\.(unavailableTitle|softwareTitle|onGpu)/));
  return view.container.textContent ?? '';
}

describe('BrowserGraphicsCheck', () => {
  afterEach(cleanup);

  it('a GPU the user may not open: the group command, then a restart', async () => {
    const text = await check(gpu());
    expect(text).toContain('sudo usermod -aG render,video ubuntu');
    expect(text).toContain('graphics.restart');
    expect(text).not.toContain('mesa-vulkan-drivers');
  });

  it('no Vulkan driver: its install command', async () => {
    const text = await check(gpu({ accessible: true, vulkanDriver: false }));
    expect(text).toContain('sudo apt-get install -y mesa-vulkan-drivers');
    expect(text).not.toContain('usermod');
  });

  it('no GPU at all: says so instead of offering commands that cannot help', async () => {
    const text = await check(gpu({ renderNodes: [] }));
    expect(text).toContain('graphics.noGpu');
    expect(text).not.toContain('usermod');
  });

  it('the GPU turned off here: asks to turn it on', async () => {
    const text = await check(gpu({ accessible: true, setting: 'off' }), { status: 'software', renderer: 'SwiftShader', vendor: 'Google', webgl2: true });
    expect(text).toContain('graphics.turnOn');
  });

  it('on the GPU: names the renderer, no steps', async () => {
    const text = await check(gpu({ accessible: true, inUse: true }), { status: 'hardware', renderer: 'AMD Radeon Graphics (RADV RENOIR)', vendor: 'AMD', webgl2: true });
    expect(text).toContain('RADV RENOIR');
    expect(text).not.toContain('usermod');
  });
});
