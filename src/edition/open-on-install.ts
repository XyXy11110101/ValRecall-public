export interface InstallTabApi {
  runtime: {
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
    getURL(path: string): string;
  };
  tabs: { create(properties: { url: string }): Promise<unknown> };
}

/** A new user lands on Home. An extension or browser update opens nothing. */
export function openDashboardOnInstall(api: InstallTabApi): void {
  api.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return;
    void api.tabs
      .create({ url: api.runtime.getURL('dashboard.html') })
      .catch((error: unknown) =>
        console.warn('[ValRecall] Dashboard could not be opened after install.', error),
      );
  });
}
