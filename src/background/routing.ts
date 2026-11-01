import {
  isValRecallMessage,
  MESSAGE_TYPES,
  type DashboardLibraryTarget,
  type OpenDashboardResponse,
} from '../models/messages';

export const CAPTURE_COMMAND = 'capture-learning-moment';

export interface BackgroundRoutePort {
  onInstalled(listener: () => void): void;
  onToolbarClicked(listener: (tab: chrome.tabs.Tab) => void): void;
  onCommand(listener: (command: string, tab?: chrome.tabs.Tab) => void): void;
  onMessage(
    listener: (message: unknown, sendResponse: (response: unknown) => void) => boolean,
  ): void;
  setPanelOpenOnActionClick(enabled: boolean): Promise<void>;
}

export interface BackgroundRouteDependencies {
  openDashboard(target?: DashboardLibraryTarget): Promise<OpenDashboardResponse>;
  startCapture(tab?: chrome.tabs.Tab): Promise<void>;
}

export function registerBackgroundRoutes(
  port: BackgroundRoutePort,
  dependencies: BackgroundRouteDependencies,
): void {
  port.onInstalled(() => {
    void port
      .setPanelOpenOnActionClick(false)
      .catch((error: unknown) =>
        console.warn('[ValRecall] Toolbar side-panel behavior could not be disabled.', error),
      );
  });

  port.onToolbarClicked(() => {
    void safelyOpenDashboard(dependencies.openDashboard).then((response) => {
      if (!response.ok) console.warn('[ValRecall] Dashboard could not be opened.', response.error);
    });
  });

  port.onCommand((command, tab) => {
    if (command !== CAPTURE_COMMAND) return;
    void dependencies
      .startCapture(tab)
      .catch((error: unknown) => console.warn('[ValRecall] Capture command failed.', error));
  });

  port.onMessage((message, sendResponse) => {
    if (!isValRecallMessage(message) || message.type !== MESSAGE_TYPES.openDashboard) return false;
    void safelyOpenDashboard(() =>
      message.payload ? dependencies.openDashboard(message.payload) : dependencies.openDashboard(),
    ).then(sendResponse);
    return true;
  });
}

export function createChromeBackgroundRoutePort(
  api: Pick<typeof chrome, 'action' | 'commands' | 'runtime' | 'sidePanel'>,
): BackgroundRoutePort {
  return {
    onInstalled(listener) {
      api.runtime.onInstalled.addListener(listener);
    },
    onToolbarClicked(listener) {
      api.action.onClicked.addListener(listener);
    },
    onCommand(listener) {
      api.commands.onCommand.addListener(listener);
    },
    onMessage(listener) {
      api.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
        if (
          isValRecallMessage(message) &&
          message.type === MESSAGE_TYPES.openDashboard &&
          message.payload !== undefined &&
          !isDashboardPageSender(sender, api.runtime.id)
        ) {
          sendResponse({
            ok: false,
            error: '请从 ValRecall 侧栏或资料库打开已保存的回忆题。',
          } satisfies OpenDashboardResponse);
          return false;
        }
        return listener(message, sendResponse);
      });
    },
    async setPanelOpenOnActionClick(enabled) {
      await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: enabled });
    },
  };
}

/** Saved-item navigation is an extension UI action, not a content-page command. */
function isDashboardPageSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (!extensionId || sender.id !== extensionId || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === extensionId &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.pathname === '/sidepanel.html' || url.pathname === '/dashboard.html')
    );
  } catch {
    return false;
  }
}

async function safelyOpenDashboard(
  openDashboard: () => Promise<OpenDashboardResponse>,
): Promise<OpenDashboardResponse> {
  try {
    return await openDashboard();
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
