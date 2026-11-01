import { createVideoPlatformAdapter } from '../adapters/registry';
import { isValRecallMessage, MESSAGE_TYPES } from '../models/messages';
import { captureCurrentPage } from './capture';
import {
  createCaptureConsistencySession,
  validateCaptureConsistencySession,
  type CaptureConsistencySession,
} from './capture-consistency';

let captureConsistencySession: CaptureConsistencySession | null = null;

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isValRecallMessage(message)) {
    return false;
  }

  if (message.type === MESSAGE_TYPES.capturePage) {
    const adapter = createVideoPlatformAdapter(
      document,
      document.location,
      message.payload?.subtitleSnapshot ?? null,
    );
    void captureCurrentPage({ adapter }).then((response) => {
      captureConsistencySession =
        adapter === null ? null : createCaptureConsistencySession(adapter, response);
      sendResponse(response);
    });
    return true;
  }

  if (message.type === MESSAGE_TYPES.validateCapturePage) {
    sendResponse({
      ok: validateCaptureConsistencySession(captureConsistencySession, message.payload.draftId),
    });
    return false;
  }

  if (message.type === MESSAGE_TYPES.seekToTimestamp) {
    const adapter = createVideoPlatformAdapter();
    if (adapter === null) {
      sendResponse({
        ok: false,
        attempts: 0,
        timestampSeconds: message.payload.timestampSeconds,
        error: 'The current page is not a supported video source.',
        diagnostics: [],
      });
      return false;
    }
    void adapter
      .seekToTimestamp(message.payload.timestampSeconds, {
        ...(message.payload.pauseAfterSeek === undefined
          ? {}
          : { pauseAfterSeek: message.payload.pauseAfterSeek }),
      })
      .then(sendResponse);
    return true;
  }

  return false;
});
