import { describe, expect, it, vi } from 'vitest';

import {
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type OpenDashboardResponse,
} from '../models/messages';
import {
  CAPTURE_COMMAND,
  createChromeBackgroundRoutePort,
  registerBackgroundRoutes,
  type BackgroundRouteDependencies,
  type BackgroundRoutePort,
} from './routing';

interface RouteListeners {
  installed?: () => void;
  toolbar?: (tab: chrome.tabs.Tab) => void;
  command?: (command: string, tab?: chrome.tabs.Tab) => void;
  message?: (message: unknown, sendResponse: (response: unknown) => void) => boolean;
}

function register(dependencies: BackgroundRouteDependencies) {
  const listeners: RouteListeners = {};
  const setPanelOpenOnActionClick = vi.fn(async (_enabled: boolean) => undefined);
  const port: BackgroundRoutePort = {
    onInstalled(listener) {
      listeners.installed = listener;
    },
    onToolbarClicked(listener) {
      listeners.toolbar = listener;
    },
    onCommand(listener) {
      listeners.command = listener;
    },
    onMessage(listener) {
      listeners.message = listener;
    },
    setPanelOpenOnActionClick,
  };
  registerBackgroundRoutes(port, dependencies);
  return { listeners, setPanelOpenOnActionClick };
}

function successfulDependencies(
  overrides: Partial<BackgroundRouteDependencies> = {},
): BackgroundRouteDependencies {
  return {
    openDashboard: vi.fn(async (): Promise<OpenDashboardResponse> => ({ ok: true })),
    startCapture: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('background event routing', () => {
  it('routes validated saved-item requests and rejects malformed targets', async () => {
    const dependencies = successfulDependencies();
    const { listeners } = register(dependencies);
    const respond = vi.fn();
    const target = { view: 'library', itemId: 'saved-question' };
    expect(
      listeners.message?.(
        { type: MESSAGE_TYPES.openDashboard, version: MESSAGE_PROTOCOL_VERSION, payload: target },
        respond,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true }));
    expect(dependencies.openDashboard).toHaveBeenCalledWith(target);
    expect(
      listeners.message?.(
        {
          type: MESSAGE_TYPES.openDashboard,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: { view: 'library', itemId: '' },
        },
        respond,
      ),
    ).toBe(false);
    expect(dependencies.openDashboard).toHaveBeenCalledTimes(1);
  });
  it('routes the toolbar to the dashboard and never starts capture', async () => {
    const dependencies = successfulDependencies();
    const { listeners } = register(dependencies);

    listeners.toolbar?.({ id: 12, windowId: 3 } as chrome.tabs.Tab);

    await vi.waitFor(() => expect(dependencies.openDashboard).toHaveBeenCalledOnce());
    expect(dependencies.startCapture).not.toHaveBeenCalled();
  });

  it('routes Alt+Shift+M command handling through capture, which opens the side panel', async () => {
    const openSidePanel = vi.fn(async (_windowId: number) => undefined);
    const capturePage = vi.fn(async (_tabId: number) => undefined);
    const startCapture = vi.fn(async (tab?: chrome.tabs.Tab) => {
      if (!tab?.id || tab.windowId === undefined) return;
      await openSidePanel(tab.windowId);
      await capturePage(tab.id);
    });
    const dependencies = successfulDependencies({ startCapture });
    const { listeners } = register(dependencies);
    const tab = {
      id: 14,
      windowId: 6,
      url: 'https://www.bilibili.com/video/BV1test',
    } as chrome.tabs.Tab;

    listeners.command?.(CAPTURE_COMMAND, tab);

    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledWith(14));
    expect(startCapture).toHaveBeenCalledWith(tab);
    expect(openSidePanel).toHaveBeenCalledWith(6);
    expect(dependencies.openDashboard).not.toHaveBeenCalled();
  });

  it('disables the legacy automatic side-panel action behavior on install', async () => {
    const dependencies = successfulDependencies();
    const { listeners, setPanelOpenOnActionClick } = register(dependencies);

    listeners.installed?.();

    await vi.waitFor(() => expect(setPanelOpenOnActionClick).toHaveBeenCalledWith(false));
  });

  it('exposes focus-or-create through the versioned runtime message', async () => {
    const dependencies = successfulDependencies();
    const { listeners } = register(dependencies);
    const sendResponse = vi.fn();

    const keepsChannelOpen = listeners.message?.(
      { type: MESSAGE_TYPES.openDashboard, version: MESSAGE_PROTOCOL_VERSION },
      sendResponse,
    );

    expect(keepsChannelOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });
});

describe('Chrome saved-item navigation sender boundary', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const message = {
    type: MESSAGE_TYPES.openDashboard,
    version: MESSAGE_PROTOCOL_VERSION,
    payload: { view: 'library', itemId: 'saved-question' },
  };
  function chromeRoute() {
    let onMessage!: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
    const api = {
      runtime: {
        id: extensionId,
        onMessage: {
          addListener(listener: typeof onMessage) {
            onMessage = listener;
          },
        },
      },
    } as unknown as Parameters<typeof createChromeBackgroundRoutePort>[0];
    const forwarded = vi.fn(() => true);
    createChromeBackgroundRoutePort(api).onMessage(forwarded);
    return {
      forwarded,
      send: (request: unknown, sender: chrome.runtime.MessageSender, reply = vi.fn()) =>
        onMessage(request, sender, reply),
    };
  }
  it.each([
    'sidepanel.html',
    'sidepanel.html?tab=capture#saved',
    'dashboard.html',
    'dashboard.html?view=library#detail',
  ])('accepts targeted navigation from this extension %s', (page) => {
    const route = chromeRoute();
    const reply = vi.fn();
    expect(
      route.send(
        message,
        { id: extensionId, url: `chrome-extension://${extensionId}/${page}` },
        reply,
      ),
    ).toBe(true);
    expect(route.forwarded).toHaveBeenCalledWith(message, reply);
  });
  it.each([
    { id: 'other-extension', url: `chrome-extension://${extensionId}/sidepanel.html` },
    { id: extensionId, url: 'https://www.bilibili.com/video/BV1example' },
    { id: extensionId, url: 'chrome-extension://other-extension/sidepanel.html' },
    { id: extensionId, url: `chrome-extension://${extensionId}/options.html` },
    { id: extensionId, url: `chrome-extension://${extensionId}/embedded/sidepanel.html` },
    { id: extensionId, url: `chrome-extension://user@${extensionId}/sidepanel.html` },
    { id: extensionId, url: 'not a URL' },
    { id: extensionId },
    { url: `chrome-extension://${extensionId}/dashboard.html` },
  ])('rejects targeted navigation from an unauthorized sender %j', (sender) => {
    const route = chromeRoute();
    const reply = vi.fn();
    expect(route.send(message, sender, reply)).toBe(false);
    expect(route.forwarded).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });
  });
  it('keeps legacy no-payload navigation and unrelated runtime routes unchanged', () => {
    const route = chromeRoute();
    const sender = { id: extensionId, url: 'https://www.bilibili.com/video/BV1example' };
    const legacy = { type: MESSAGE_TYPES.openDashboard, version: MESSAGE_PROTOCOL_VERSION };
    const unrelated = { type: 'other-runtime-route', payload: { value: true } };
    expect(route.send(legacy, sender)).toBe(true);
    expect(route.send(unrelated, sender)).toBe(true);
    expect(route.forwarded).toHaveBeenCalledTimes(2);
  });
});
