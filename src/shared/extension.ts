import {
  isSeekToTimestampResponse,
  isReminderStatusResponse,
  isTestReminderResponse,
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type OpenSourceMessage,
  type SeekToTimestampResponse,
  type TestReminderResponse,
  type ReminderStatusResponse,
} from '../models/messages';
import type { VideoPlatform } from '../models/platform';

export interface OpenSourceInput {
  platform: VideoPlatform;
  sourceUrl: string;
  canonicalUrl: string | null;
  timestampSeconds: number | null;
  pauseAfterSeek: boolean;
}

export function hasExtensionRuntime(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
}

export async function openSourceAtTimestamp(
  input: OpenSourceInput,
): Promise<SeekToTimestampResponse> {
  if (!hasExtensionRuntime()) {
    return {
      ok: false,
      attempts: 0,
      timestampSeconds: input.timestampSeconds ?? 0,
      error: 'Open Source works after ValRecall is loaded as an Edge extension.',
      diagnostics: [],
    };
  }
  const message: OpenSourceMessage = {
    type: MESSAGE_TYPES.openSource,
    version: MESSAGE_PROTOCOL_VERSION,
    payload: input,
  };
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    if (isSeekToTimestampResponse(response)) return response;
    return failedOpenSource(
      input.timestampSeconds ?? 0,
      'ValRecall received an invalid seek response.',
    );
  } catch (error) {
    return failedOpenSource(
      input.timestampSeconds ?? 0,
      error instanceof Error ? error.message : 'ValRecall could not contact the source opener.',
    );
  }
}

function failedOpenSource(timestampSeconds: number, error: string): SeekToTimestampResponse {
  return { ok: false, attempts: 0, timestampSeconds, error, diagnostics: [] };
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('The screenshot data could not be read.');
  return response.blob();
}

export function downloadJson(value: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function displayError(error: unknown, fallback = 'Something went wrong.'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export async function sendTestReminder(): Promise<TestReminderResponse> {
  if (!hasExtensionRuntime()) {
    return {
      ok: false,
      error: 'Test notifications work after ValRecall is loaded as an Edge extension.',
    };
  }
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.sendTestReminder,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    return isTestReminderResponse(response)
      ? response
      : { ok: false, error: 'ValRecall received an invalid reminder response.' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'ValRecall could not create the test reminder.',
    };
  }
}

export async function sendTestDailyPlan(): Promise<TestReminderResponse> {
  if (!hasExtensionRuntime()) {
    return {
      ok: false,
      error: 'Test notifications work after ValRecall is loaded as an Edge extension.',
    };
  }
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.sendTestDailyPlan,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    return isTestReminderResponse(response)
      ? response
      : { ok: false, error: 'ValRecall received an invalid Daily Plan response.' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'ValRecall could not create the Daily Plan test.',
    };
  }
}

export async function refreshReviewReminders(): Promise<TestReminderResponse> {
  if (!hasExtensionRuntime()) return { ok: true };
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.refreshReviewReminders,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    return isTestReminderResponse(response)
      ? response
      : { ok: false, error: 'ValRecall received an invalid reminder refresh response.' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : 'ValRecall could not refresh the review reminder.',
    };
  }
}

export async function getReminderStatus(): Promise<ReminderStatusResponse> {
  if (!hasExtensionRuntime()) {
    return {
      ok: true,
      status: {
        nextReviewReminderAt: null,
        notificationPermission: 'unavailable',
      },
    };
  }
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.getReminderStatus,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    return isReminderStatusResponse(response)
      ? response
      : { ok: false, error: 'ValRecall received an invalid reminder status response.' };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'ValRecall could not read the review reminder status.',
    };
  }
}
