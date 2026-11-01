import { MESSAGE_PROTOCOL_VERSION } from '../models/messages';

const RETRY_CAPTURE = 'VALRECALL_RETRY_CAPTURE';

export interface CaptureRetryApi {
  runtime: {
    id: string;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: { id?: string | undefined; url?: string | undefined },
          sendResponse: (response: { ok: boolean }) => void,
        ) => boolean,
      ): void;
    };
  };
}

function isRetryCaptureMessage(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === RETRY_CAPTURE &&
    (value as { version?: unknown }).version === MESSAGE_PROTOCOL_VERSION
  );
}

/** A capture starts only from a press in our own panel, never from a message a page caused. */
function isSidePanelSender(
  sender: { id?: string | undefined; url?: string | undefined },
  id: string,
) {
  if (!id || sender.id !== id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === id &&
      url.pathname === '/sidepanel.html'
    );
  } catch {
    return false;
  }
}

/** startCapture reports its own failures through the panel, so this only says that it finished. */
export function registerCaptureRetry(
  api: CaptureRetryApi,
  startCapture: () => Promise<void>,
): void {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isRetryCaptureMessage(message)) return false;
    if (!isSidePanelSender(sender, api.runtime.id)) {
      sendResponse({ ok: false });
      return false;
    }
    void startCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        console.warn('[ValRecall] Capture retry failed.', error);
        sendResponse({ ok: false });
      });
    return true;
  });
}

/** Resolves false when the background could not be asked or could not run the capture. */
export async function requestCaptureRetry(): Promise<boolean> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: RETRY_CAPTURE,
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
