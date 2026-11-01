import {
  isDashboardLibraryTarget,
  type DashboardLibraryTarget,
  type OpenDashboardResponse,
} from '../models/messages';

export interface DashboardTab {
  id?: number | undefined;
  windowId?: number | undefined;
  url?: string | undefined;
}

export interface DashboardBrowserApi {
  runtime: {
    getURL(path: string): string;
  };
  tabs: {
    query(queryInfo: { url: string }): Promise<DashboardTab[]>;
    update(tabId: number, updateProperties: { active: true; url?: string }): Promise<unknown>;
    create(createProperties: { url: string; active: true }): Promise<DashboardTab>;
  };
  windows: {
    update(windowId: number, updateInfo: { focused: true }): Promise<unknown>;
  };
}

export type DashboardDestination = 'home' | 'review' | DashboardLibraryTarget;
export type FocusOrCreateDashboard = (
  destination?: DashboardDestination,
) => Promise<OpenDashboardResponse>;

/**
 * Creates a serialized dashboard opener. Serialization matters because two quick
 * toolbar clicks can otherwise both finish querying before either creates a tab. A
 * last explicit destination received during the open is applied before completion.
 * An unspecified toolbar request never replaces an explicit notification route.
 */
export function createDashboardOpener(api: DashboardBrowserApi): FocusOrCreateDashboard {
  let pendingOpen: Promise<OpenDashboardResponse> | null = null;
  let requestedDestination: 'home' | 'review' | undefined;
  const pendingLibraryOpens = new Map<string, Promise<OpenDashboardResponse>>();

  return function focusOrCreateDashboard(
    destination?: DashboardDestination,
  ): Promise<OpenDashboardResponse> {
    if (typeof destination === 'object') {
      if (!isDashboardLibraryTarget(destination))
        return Promise.resolve({ ok: false, error: '无法打开这条记录。' });
      const dashboardUrl = api.runtime.getURL('dashboard.html');
      const targetUrl = `${dashboardUrl}?view=library${destination.itemId ? `&item=${encodeURIComponent(destination.itemId)}` : ''}`;
      const existing = pendingLibraryOpens.get(targetUrl);
      if (existing) return existing;
      const operation = openLibraryDashboard(api, dashboardUrl, targetUrl).finally(() => {
        if (pendingLibraryOpens.get(targetUrl) === operation) pendingLibraryOpens.delete(targetUrl);
      });
      pendingLibraryOpens.set(targetUrl, operation);
      return operation;
    }
    if (pendingOpen) {
      if (destination !== undefined) requestedDestination = destination;
      return pendingOpen;
    }

    requestedDestination = destination;
    const operation = openDashboard(api, () => requestedDestination);
    const trackedOperation = operation.finally(() => {
      if (pendingOpen === trackedOperation) {
        pendingOpen = null;
        requestedDestination = undefined;
      }
    });
    pendingOpen = trackedOperation;
    return trackedOperation;
  };
}

async function openDashboard(
  api: DashboardBrowserApi,
  getDestination: () => 'home' | 'review' | undefined,
): Promise<OpenDashboardResponse> {
  try {
    const dashboardUrl = api.runtime.getURL('dashboard.html');
    const tabs = await api.tabs.query({ url: `${dashboardUrl}*` });
    const existingTab = tabs.find(
      (tab) =>
        isDashboardUrl(tab.url, dashboardUrl) && tab.id !== undefined && tab.windowId !== undefined,
    );
    let destination = getDestination();
    const targetUrl = destination ? `${dashboardUrl}?view=${destination}` : dashboardUrl;
    let activeTab: DashboardTab;

    if (existingTab?.id !== undefined && existingTab.windowId !== undefined) {
      const updateProperties: { active: true; url?: string } = { active: true };
      if (destination && existingTab.url !== targetUrl) updateProperties.url = targetUrl;
      await Promise.all([
        api.tabs.update(existingTab.id, updateProperties),
        api.windows.update(existingTab.windowId, { focused: true }),
      ]);
      activeTab = existingTab;
    } else {
      activeTab = await api.tabs.create({ url: targetUrl, active: true });
    }

    while (getDestination() !== destination) {
      destination = getDestination();
      if (activeTab.id === undefined || destination === undefined) break;
      await api.tabs.update(activeTab.id, {
        active: true,
        url: `${dashboardUrl}?view=${destination}`,
      });
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : 'ValRecall could not open the study dashboard.',
    };
  }
}

/** Explicit saved-item navigation must never replace a dashboard that may contain edits. */
async function openLibraryDashboard(
  api: DashboardBrowserApi,
  dashboardUrl: string,
  targetUrl: string,
): Promise<OpenDashboardResponse> {
  try {
    const tabs = await api.tabs.query({ url: `${dashboardUrl}*` });
    const exact = tabs.find(
      (tab) => tab.url === targetUrl && tab.id !== undefined && tab.windowId !== undefined,
    );
    if (exact?.id !== undefined && exact.windowId !== undefined) {
      await Promise.all([
        api.tabs.update(exact.id, { active: true }),
        api.windows.update(exact.windowId, { focused: true }),
      ]);
    } else await api.tabs.create({ url: targetUrl, active: true });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : '资料库无法打开，请重试。',
    };
  }
}

function isDashboardUrl(candidate: string | undefined, dashboardUrl: string): boolean {
  return (
    candidate === dashboardUrl ||
    candidate?.startsWith(`${dashboardUrl}?`) === true ||
    candidate?.startsWith(`${dashboardUrl}#`) === true
  );
}
