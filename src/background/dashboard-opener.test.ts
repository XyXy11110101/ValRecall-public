import { describe, expect, it, vi } from 'vitest';

import {
  createDashboardOpener,
  type DashboardBrowserApi,
  type DashboardTab,
} from './dashboard-opener';

const DASHBOARD_URL = 'chrome-extension://valrecall/dashboard.html';

function createApi(tabs: DashboardTab[] = []) {
  const getURL = vi.fn((_path: string) => DASHBOARD_URL);
  const query = vi.fn(async (_queryInfo: { url: string }) => tabs);
  const update = vi.fn(
    async (_tabId: number, _properties: { active: true; url?: string }) => undefined,
  );
  const create = vi.fn(async (properties: { url: string; active: true }) => ({
    id: 91,
    windowId: 12,
    url: properties.url,
  }));
  const focusWindow = vi.fn(async (_windowId: number, _updateInfo: { focused: true }) => undefined);
  const api: DashboardBrowserApi = {
    runtime: { getURL },
    tabs: { query, update, create },
    windows: { update: focusWindow },
  };

  return { api, getURL, query, update, create, focusWindow };
}

describe('dashboard focus-or-create service', () => {
  it('creates a saved-item route without reloading an existing dashboard editor', async () => {
    const browser = createApi([{ id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=add` }]);
    await expect(
      createDashboardOpener(browser.api)({ view: 'library', itemId: '回忆题 & one' }),
    ).resolves.toEqual({ ok: true });
    expect(browser.create).toHaveBeenCalledWith({
      url: `${DASHBOARD_URL}?view=library&item=${encodeURIComponent('回忆题 & one')}`,
      active: true,
    });
    expect(browser.update).not.toHaveBeenCalled();
  });

  it('focuses only the exact saved-item route without any reload', async () => {
    const browser = createApi([
      { id: 3, windowId: 7, url: `${DASHBOARD_URL}?view=library` },
      { id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=library&item=other` },
      { id: 5, windowId: 8, url: `${DASHBOARD_URL}?view=library&item=one` },
    ]);
    await expect(
      createDashboardOpener(browser.api)({ view: 'library', itemId: 'one' }),
    ).resolves.toEqual({ ok: true });
    expect(browser.update).toHaveBeenCalledExactlyOnceWith(5, { active: true });
    expect(browser.focusWindow).toHaveBeenCalledWith(8, { focused: true });
    expect(browser.create).not.toHaveBeenCalled();
  });

  it('deduplicates simultaneous identical targets while preserving distinct saved-item requests', async () => {
    let release!: (tabs: DashboardTab[]) => void;
    const browser = createApi();
    browser.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const open = createDashboardOpener(browser.api);
    const first = open({ view: 'library', itemId: 'one' });
    expect(open({ view: 'library', itemId: 'one' })).toBe(first);
    const second = open({ view: 'library', itemId: 'two' });
    release([]);
    await Promise.all([first, second]);
    expect(browser.create).toHaveBeenCalledTimes(2);
    expect(browser.create).toHaveBeenCalledWith({
      url: `${DASHBOARD_URL}?view=library&item=one`,
      active: true,
    });
    expect(browser.create).toHaveBeenCalledWith({
      url: `${DASHBOARD_URL}?view=library&item=two`,
      active: true,
    });
  });

  it('returns a failed destination read without changing any tab', async () => {
    const browser = createApi();
    browser.query.mockRejectedValue(new Error('Tab lookup failed'));
    await expect(createDashboardOpener(browser.api)({ view: 'library' })).resolves.toEqual({
      ok: false,
      error: 'Tab lookup failed',
    });
    expect(browser.create).not.toHaveBeenCalled();
    expect(browser.update).not.toHaveBeenCalled();
  });
  it('creates the exact extension dashboard URL when none exists', async () => {
    const browser = createApi();

    await expect(createDashboardOpener(browser.api)()).resolves.toEqual({ ok: true });

    expect(browser.getURL).toHaveBeenCalledWith('dashboard.html');
    expect(browser.query).toHaveBeenCalledWith({ url: `${DASHBOARD_URL}*` });
    expect(browser.create).toHaveBeenCalledOnce();
    expect(browser.create).toHaveBeenCalledWith({ url: DASHBOARD_URL, active: true });
    expect(browser.update).not.toHaveBeenCalled();
    expect(browser.focusWindow).not.toHaveBeenCalled();
  });

  it('focuses an existing addressable dashboard route and preserves its current view', async () => {
    const browser = createApi([
      { id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=library` },
      { id: 5, windowId: 8, url: DASHBOARD_URL },
    ]);

    await expect(createDashboardOpener(browser.api)()).resolves.toEqual({ ok: true });

    expect(browser.update).toHaveBeenCalledWith(4, { active: true });
    expect(browser.focusWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(browser.create).not.toHaveBeenCalled();
  });

  it('navigates the reused dashboard tab to Review for notification clicks', async () => {
    const browser = createApi([{ id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=library` }]);

    await expect(createDashboardOpener(browser.api)('review')).resolves.toEqual({ ok: true });

    expect(browser.update).toHaveBeenCalledWith(4, {
      active: true,
      url: `${DASHBOARD_URL}?view=review`,
    });
    expect(browser.focusWindow).toHaveBeenCalledWith(7, { focused: true });
    expect(browser.create).not.toHaveBeenCalled();
  });

  it('creates the requested Review route when no dashboard exists', async () => {
    const browser = createApi();

    await expect(createDashboardOpener(browser.api)('review')).resolves.toEqual({ ok: true });

    expect(browser.create).toHaveBeenCalledWith({
      url: `${DASHBOARD_URL}?view=review`,
      active: true,
    });
  });

  it('navigates an existing dashboard to Home for a Daily Plan notification', async () => {
    const browser = createApi([{ id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=review` }]);

    await expect(createDashboardOpener(browser.api)('home')).resolves.toEqual({ ok: true });

    expect(browser.update).toHaveBeenCalledWith(4, {
      active: true,
      url: `${DASHBOARD_URL}?view=home`,
    });
  });

  it('serializes simultaneous opens so rapid toolbar clicks cannot create duplicates', async () => {
    let resolveQuery!: (tabs: DashboardTab[]) => void;
    const browser = createApi();
    browser.query.mockImplementationOnce(
      () =>
        new Promise<DashboardTab[]>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const openDashboard = createDashboardOpener(browser.api);

    const first = openDashboard();
    const second = openDashboard();

    expect(second).toBe(first);
    expect(browser.query).toHaveBeenCalledOnce();
    resolveQuery([]);
    await Promise.all([first, second]);
    expect(browser.create).toHaveBeenCalledOnce();
  });

  it('applies a concurrent notification Review route before the toolbar open completes', async () => {
    let releaseFirstUpdate!: () => void;
    const browser = createApi([{ id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=library` }]);
    browser.update.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseFirstUpdate = () => resolve(undefined);
        }),
    );
    const openDashboard = createDashboardOpener(browser.api);

    const toolbarOpen = openDashboard();
    await vi.waitFor(() => expect(browser.update).toHaveBeenCalledTimes(1));
    const notificationOpen = openDashboard('review');
    expect(notificationOpen).toBe(toolbarOpen);
    releaseFirstUpdate();
    await Promise.all([toolbarOpen, notificationOpen]);

    expect(browser.query).toHaveBeenCalledOnce();
    expect(browser.create).not.toHaveBeenCalled();
    expect(browser.update).toHaveBeenNthCalledWith(2, 4, {
      active: true,
      url: `${DASHBOARD_URL}?view=review`,
    });
  });

  it('uses the last explicit notification destination while ignoring later toolbar opens', async () => {
    let releaseFirstUpdate!: () => void;
    const browser = createApi([{ id: 4, windowId: 7, url: `${DASHBOARD_URL}?view=library` }]);
    browser.update.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseFirstUpdate = () => resolve(undefined);
        }),
    );
    const openDashboard = createDashboardOpener(browser.api);

    const first = openDashboard('review');
    await vi.waitFor(() => expect(browser.update).toHaveBeenCalledTimes(1));
    expect(openDashboard('home')).toBe(first);
    expect(openDashboard()).toBe(first);
    releaseFirstUpdate();
    await first;

    expect(browser.update).toHaveBeenNthCalledWith(2, 4, {
      active: true,
      url: `${DASHBOARD_URL}?view=home`,
    });
    expect(browser.query).toHaveBeenCalledOnce();
  });
});
