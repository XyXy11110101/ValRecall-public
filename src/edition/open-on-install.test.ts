import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDashboardOnInstall, type InstallTabApi } from './open-on-install';

function installApi(create: InstallTabApi['tabs']['create']) {
  let listener: ((details: { reason: string }) => void) | undefined;
  const api: InstallTabApi = {
    runtime: {
      onInstalled: {
        addListener: (next) => {
          listener = next;
        },
      },
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    tabs: { create },
  };
  openDashboardOnInstall(api);
  return (reason: string) => listener?.({ reason });
}

describe('openDashboardOnInstall', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the dashboard on a new install', () => {
    const create = vi.fn().mockResolvedValue({});
    installApi(create)('install');
    expect(create).toHaveBeenCalledExactlyOnceWith({
      url: 'chrome-extension://test/dashboard.html',
    });
  });

  it.each(['update', 'chrome_update', 'shared_module_update'])('opens nothing on %s', (reason) => {
    const create = vi.fn().mockResolvedValue({});
    installApi(create)(reason);
    expect(create).not.toHaveBeenCalled();
  });

  it('only warns when the tab cannot be opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installApi(vi.fn().mockRejectedValue(new Error('no tab')))('install');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });
});
