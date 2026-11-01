import { setDraftWritesStopped } from '../database/drafts';
import { MESSAGE_PROTOCOL_VERSION } from '../models/messages';

const CLEAR_PENDING_CAPTURE = 'VALRECALL_CLEAR_PENDING_CAPTURE';

export const PENDING_CAPTURE_NOT_CLEARED = '等待整理的捕获没清除，请再试一次。';

type Sender = { id?: string | undefined; url?: string | undefined };

export interface PendingCaptureClearApi {
  runtime: {
    id: string;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: Sender,
          sendResponse: (response: { ok: boolean }) => void,
        ) => boolean,
      ): void;
    };
  };
}

function isClearMessage(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === CLEAR_PENDING_CAPTURE &&
    (value as { version?: unknown }).version === MESSAGE_PROTOCOL_VERSION &&
    (value as { payload?: unknown }).payload === undefined
  );
}

/** Only the data page deletes everything, so no message a page caused can wipe a capture. */
function isDashboardSender(sender: Sender, id: string): boolean {
  if (!id || sender.id !== id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === id &&
      url.pathname === '/dashboard.html'
    );
  } catch {
    return false;
  }
}

/** The service worker's side. It answers, so the data page can say whether this worked. */
export function registerPendingCaptureClear(
  api: PendingCaptureClearApi,
  clear: () => Promise<void>,
): void {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isClearMessage(message)) return false;
    if (!isDashboardSender(sender, api.runtime.id)) {
      sendResponse({ ok: false });
      return false;
    }
    void clear()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        console.warn('[ValRecall] Pending capture could not be cleared.', error);
        sendResponse({ ok: false });
      });
    return true;
  });
}

/**
 * The person already confirmed the delete. Leaving flushes open editors, which must not write the
 * deleted text back, and an editor's "stay on this page?" question could keep that text on screen.
 * Capture listeners run first on the window, so this comes before every editor's own listener.
 */
function reloadWithoutAsking(reload: () => void): void {
  setDraftWritesStopped(true);
  window.addEventListener('beforeunload', (event) => event.stopImmediatePropagation(), {
    capture: true,
    once: true,
  });
  reload();
}

/** Screenshots and unsaved text also sit in the memory of every other open page. */
export function reloadWhenDataDeleted(
  api: PendingCaptureClearApi,
  reload: () => void = () => location.reload(),
): void {
  // The browser does not deliver a message to the frame that sent it. The data page has its own.
  api.runtime.onMessage.addListener((message, sender) => {
    if (isClearMessage(message) && isDashboardSender(sender, api.runtime.id)) {
      reloadWithoutAsking(reload);
    }
    // The service worker is the one that answers.
    return false;
  });
}

export interface DeleteNotice {
  text: string;
  tone: 'success' | 'warning';
}

const DELETE_NOTICE_KEY = 'valrecall.deleteNotice';

/**
 * The tab that ran the delete keeps hidden forms mounted, holding what was typed in them. It reloads
 * too, and the result it would have shown waits in this tab's session storage.
 */
export function reloadDataPageAfterDelete(
  notice: DeleteNotice,
  reload: () => void = () => location.reload(),
): void {
  try {
    sessionStorage.setItem(DELETE_NOTICE_KEY, JSON.stringify(notice));
  } catch {
    // Clearing memory matters more than the message.
  }
  reloadWithoutAsking(reload);
}

export function readDeleteNotice(): DeleteNotice | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(DELETE_NOTICE_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { text, tone } = value as { text?: unknown; tone?: unknown };
    return typeof text === 'string' && (tone === 'success' || tone === 'warning')
      ? { text, tone }
      : null;
  } catch {
    return null;
  }
}

export function clearDeleteNotice(): void {
  try {
    sessionStorage.removeItem(DELETE_NOTICE_KEY);
  } catch {
    // Nothing can be left behind if storage cannot be reached.
  }
}

/** Resolves false when the service worker could not be asked or could not finish. */
export async function requestPendingCaptureClear(): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: CLEAR_PENDING_CAPTURE,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    return (
      typeof response === 'object' &&
      response !== null &&
      (response as { ok?: unknown }).ok === true
    );
  } catch {
    return false;
  }
}
