import type { SeekResult } from './extraction';
import { isPageSubtitleSnapshot, type PageSubtitleSnapshot } from './page-subtitles';
import { CAPTURE_DRAFT_SCHEMA_VERSION, type CaptureDraft } from './learning-item';
import { isVideoPlatform, type VideoPlatform } from './platform';
import {
  detectVideoPlatform,
  hasConsistentVideoIdentity,
  isSupportedVideoUrl,
} from '../shared/video-url';

export const MESSAGE_PROTOCOL_VERSION = 1 as const;

export const MESSAGE_TYPES = {
  capturePage: 'VALRECALL_CAPTURE_PAGE',
  validateCapturePage: 'VALRECALL_VALIDATE_CAPTURE_PAGE',
  captureDraftReady: 'VALRECALL_CAPTURE_DRAFT_READY',
  getPendingCapture: 'VALRECALL_GET_PENDING_CAPTURE',
  pendingCaptureChanged: 'VALRECALL_PENDING_CAPTURE_CHANGED',
  seekToTimestamp: 'VALRECALL_SEEK_TO_TIMESTAMP',
  openSource: 'VALRECALL_OPEN_SOURCE',
  openDashboard: 'VALRECALL_OPEN_DASHBOARD',
  sendTestReminder: 'VALRECALL_SEND_TEST_REMINDER',
  sendTestDailyPlan: 'VALRECALL_SEND_TEST_DAILY_PLAN',
  refreshReviewReminders: 'VALRECALL_REFRESH_REVIEW_REMINDERS',
  getReminderStatus: 'VALRECALL_GET_REMINDER_STATUS',
  dismissCapture: 'VALRECALL_DISMISS_CAPTURE',
} as const;

export interface CapturePageMessage {
  type: typeof MESSAGE_TYPES.capturePage;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload?: { subtitleSnapshot: PageSubtitleSnapshot | null };
}

export interface ValidateCapturePageMessage {
  type: typeof MESSAGE_TYPES.validateCapturePage;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload: { draftId: string };
}

export interface CaptureDraftReadyMessage {
  type: typeof MESSAGE_TYPES.captureDraftReady;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload: CaptureDraft;
}

export interface GetPendingCaptureMessage {
  type: typeof MESSAGE_TYPES.getPendingCapture;
  version: typeof MESSAGE_PROTOCOL_VERSION;
}

export interface PendingCaptureChangedMessage {
  type: typeof MESSAGE_TYPES.pendingCaptureChanged;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload: CapturePageResponse;
}

export interface SeekToTimestampMessage {
  type: typeof MESSAGE_TYPES.seekToTimestamp;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload: {
    timestampSeconds: number;
    pauseAfterSeek?: boolean;
  };
}

export interface OpenSourceMessage {
  type: typeof MESSAGE_TYPES.openSource;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload: {
    platform?: VideoPlatform;
    sourceUrl: string;
    canonicalUrl: string | null;
    timestampSeconds: number | null;
    pauseAfterSeek: boolean;
  };
}

export interface DismissCaptureMessage {
  type: typeof MESSAGE_TYPES.dismissCapture;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  /** Older readers may omit it; current writers require identity before deleting. */
  payload?: { draftId: string };
}

export interface DashboardLibraryTarget {
  view: 'library';
  itemId?: string;
}

export interface OpenDashboardMessage {
  type: typeof MESSAGE_TYPES.openDashboard;
  version: typeof MESSAGE_PROTOCOL_VERSION;
  payload?: DashboardLibraryTarget;
}

export interface SendTestReminderMessage {
  type: typeof MESSAGE_TYPES.sendTestReminder;
  version: typeof MESSAGE_PROTOCOL_VERSION;
}

export interface SendTestDailyPlanMessage {
  type: typeof MESSAGE_TYPES.sendTestDailyPlan;
  version: typeof MESSAGE_PROTOCOL_VERSION;
}

export interface RefreshReviewRemindersMessage {
  type: typeof MESSAGE_TYPES.refreshReviewReminders;
  version: typeof MESSAGE_PROTOCOL_VERSION;
}

export interface GetReminderStatusMessage {
  type: typeof MESSAGE_TYPES.getReminderStatus;
  version: typeof MESSAGE_PROTOCOL_VERSION;
}

export type ValRecallMessage =
  | CapturePageMessage
  | ValidateCapturePageMessage
  | CaptureDraftReadyMessage
  | GetPendingCaptureMessage
  | PendingCaptureChangedMessage
  | SeekToTimestampMessage
  | OpenSourceMessage
  | OpenDashboardMessage
  | SendTestReminderMessage
  | SendTestDailyPlanMessage
  | RefreshReviewRemindersMessage
  | GetReminderStatusMessage
  | DismissCaptureMessage;

export type CapturePageResponse =
  | { ok: true; draft: CaptureDraft }
  | {
      ok: false;
      error: {
        code: 'UNSUPPORTED_PAGE' | 'VIDEO_NOT_FOUND' | 'SCREENSHOT_FAILED' | 'CAPTURE_FAILED';
        message: string;
      };
    };

export type SeekToTimestampResponse = SeekResult;

export type OpenDashboardResponse = { ok: true } | { ok: false; error: string };
export type TestReminderResponse = { ok: true } | { ok: false; error: string };
export type ReminderStatusResponse =
  | {
      ok: true;
      status: {
        nextReviewReminderAt: string | null;
        notificationPermission: 'granted' | 'denied' | 'unavailable';
      };
    }
  | { ok: false; error: string };
export interface CaptureConsistencyResponse {
  ok: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isDashboardLibraryTarget(value: unknown): value is DashboardLibraryTarget {
  return (
    isRecord(value) &&
    value.view === 'library' &&
    (value.itemId === undefined ||
      (typeof value.itemId === 'string' &&
        value.itemId.length > 0 &&
        value.itemId.length <= 512 &&
        value.itemId.trim() === value.itemId &&
        [...value.itemId].every(
          (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
        )))
  );
}

export function isValRecallMessage(value: unknown): value is ValRecallMessage {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    value.version !== MESSAGE_PROTOCOL_VERSION
  ) {
    return false;
  }

  switch (value.type) {
    case MESSAGE_TYPES.capturePage:
      return (
        value.payload === undefined ||
        (isRecord(value.payload) &&
          (value.payload.subtitleSnapshot === null ||
            isPageSubtitleSnapshot(value.payload.subtitleSnapshot)))
      );
    case MESSAGE_TYPES.getPendingCapture:
    case MESSAGE_TYPES.sendTestReminder:
    case MESSAGE_TYPES.sendTestDailyPlan:
    case MESSAGE_TYPES.refreshReviewReminders:
    case MESSAGE_TYPES.getReminderStatus:
      return true;
    case MESSAGE_TYPES.openDashboard:
      return value.payload === undefined || isDashboardLibraryTarget(value.payload);
    case MESSAGE_TYPES.dismissCapture:
      return (
        value.payload === undefined ||
        (isRecord(value.payload) &&
          typeof value.payload.draftId === 'string' &&
          value.payload.draftId.length > 0)
      );
    case MESSAGE_TYPES.validateCapturePage:
      return (
        isRecord(value.payload) &&
        typeof value.payload.draftId === 'string' &&
        value.payload.draftId.length > 0
      );
    case MESSAGE_TYPES.captureDraftReady:
      return isCaptureDraft(value.payload);
    case MESSAGE_TYPES.pendingCaptureChanged:
      return isCapturePageResponse(value.payload);
    case MESSAGE_TYPES.seekToTimestamp:
      return (
        isRecord(value.payload) &&
        typeof value.payload.timestampSeconds === 'number' &&
        Number.isFinite(value.payload.timestampSeconds) &&
        value.payload.timestampSeconds >= 0 &&
        (value.payload.pauseAfterSeek === undefined ||
          typeof value.payload.pauseAfterSeek === 'boolean')
      );
    case MESSAGE_TYPES.openSource:
      if (!isRecord(value.payload) || !isSupportedVideoUrlValue(value.payload.sourceUrl)) {
        return false;
      }
      {
        const detectedPlatform = detectVideoPlatform(value.payload.sourceUrl);
        const platform =
          value.payload.platform === undefined ? detectedPlatform : value.payload.platform;
        return (
          isVideoPlatform(platform) &&
          detectedPlatform === platform &&
          (value.payload.canonicalUrl === null ||
            isSafeCanonicalUrl(value.payload.canonicalUrl, platform)) &&
          hasConsistentVideoIdentity(
            platform,
            value.payload.sourceUrl,
            value.payload.canonicalUrl,
            null,
          ) &&
          (value.payload.timestampSeconds === null ||
            isNonNegativeNumber(value.payload.timestampSeconds)) &&
          typeof value.payload.pauseAfterSeek === 'boolean'
        );
      }
    default:
      return false;
  }
}

export function isCaptureConsistencyResponse(value: unknown): value is CaptureConsistencyResponse {
  return isRecord(value) && typeof value.ok === 'boolean';
}

export function isCaptureDraft(value: unknown): value is CaptureDraft {
  return (
    isRecord(value) &&
    typeof value.draftId === 'string' &&
    value.draftId.length > 0 &&
    (value.schemaVersion === 1 || value.schemaVersion === CAPTURE_DRAFT_SCHEMA_VERSION) &&
    isVideoPlatform(value.platform) &&
    (value.schemaVersion !== 1 || value.platform === 'bilibili') &&
    isSupportedVideoUrlValue(value.sourceUrl, value.platform) &&
    (value.canonicalUrl === null || isSafeCanonicalUrl(value.canonicalUrl, value.platform)) &&
    isNullableString(value.videoId) &&
    hasConsistentVideoIdentity(
      value.platform,
      value.sourceUrl,
      value.canonicalUrl,
      value.videoId,
    ) &&
    isNullableString(value.videoTitle) &&
    isNullableString(value.uploader) &&
    isNullableString(value.description) &&
    isNonNegativeNumber(value.timestampSeconds) &&
    typeof value.timestampDisplay === 'string' &&
    (value.videoDurationSeconds === null || isNonNegativeNumber(value.videoDurationSeconds)) &&
    isNullableString(value.chapterTitle) &&
    isVideoBounds(value.videoBounds) &&
    (value.screenshotDataUrl === null || isImageDataUrl(value.screenshotDataUrl)) &&
    isStringArray(value.subtitleBefore) &&
    isStringArray(value.subtitleCurrent) &&
    isStringArray(value.subtitleAfter) &&
    Array.isArray(value.subtitleCueData) &&
    value.subtitleCueData.every(isSubtitleCueData) &&
    ['timed_context', 'current_only', 'unavailable'].includes(String(value.subtitleStatus)) &&
    [
      'text_track_timed_cues',
      'timestamped_transcript_rows',
      'visible_video_overlay',
      'none',
    ].includes(String(value.subtitleExtractionStrategy)) &&
    ['high', 'medium', 'none'].includes(String(value.subtitleConfidence)) &&
    typeof value.capturedAt === 'string' &&
    !Number.isNaN(Date.parse(value.capturedAt)) &&
    Array.isArray(value.extractionDiagnostics) &&
    value.extractionDiagnostics.every(isExtractionDiagnostic)
  );
}

export function isCapturePageResponse(value: unknown): value is CapturePageResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return isCaptureDraft(value.draft);
  }
  return (
    isRecord(value.error) &&
    ['UNSUPPORTED_PAGE', 'VIDEO_NOT_FOUND', 'SCREENSHOT_FAILED', 'CAPTURE_FAILED'].includes(
      String(value.error.code),
    ) &&
    typeof value.error.message === 'string'
  );
}

export function isSeekToTimestampResponse(value: unknown): value is SeekToTimestampResponse {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    Number.isInteger(value.attempts) &&
    isNonNegativeNumber(value.attempts) &&
    isNonNegativeNumber(value.timestampSeconds) &&
    (value.error === null || typeof value.error === 'string') &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isExtractionDiagnostic)
  );
}

export function isOpenDashboardResponse(value: unknown): value is OpenDashboardResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  return value.ok || (typeof value.error === 'string' && value.error.trim().length > 0);
}

export function isTestReminderResponse(value: unknown): value is TestReminderResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok || (typeof value.error === 'string' && value.error.trim().length > 0);
}

export function isReminderStatusResponse(value: unknown): value is ReminderStatusResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (!value.ok) return typeof value.error === 'string' && value.error.trim().length > 0;
  if (!isRecord(value.status)) return false;
  return (
    (value.status.nextReviewReminderAt === null ||
      (typeof value.status.nextReviewReminderAt === 'string' &&
        !Number.isNaN(Date.parse(value.status.nextReviewReminderAt)))) &&
    ['granted', 'denied', 'unavailable'].includes(String(value.status.notificationPermission))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(value);
}

function isVideoBounds(value: unknown): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      isFiniteNumber(value.x) &&
      isFiniteNumber(value.y) &&
      isNonNegativeNumber(value.width) &&
      isNonNegativeNumber(value.height) &&
      isNonNegativeNumber(value.devicePixelRatio))
  );
}

function isSubtitleCueData(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.startTime === null || isNonNegativeNumber(value.startTime)) &&
    (value.endTime === null || isNonNegativeNumber(value.endTime)) &&
    typeof value.text === 'string' &&
    ['text-track', 'dom-transcript', 'visible-overlay'].includes(String(value.source))
  );
}

function isExtractionDiagnostic(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.field === 'string' &&
    typeof value.strategy === 'string' &&
    ['success', 'failed', 'skipped'].includes(String(value.status)) &&
    ['info', 'warning', 'error'].includes(String(value.severity)) &&
    typeof value.message === 'string'
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSupportedVideoUrlValue(value: unknown, platform?: VideoPlatform): value is string {
  return typeof value === 'string' && isSupportedVideoUrl(value, platform);
}

function isSafeCanonicalUrl(value: unknown, platform: VideoPlatform): value is string {
  return typeof value === 'string' && isSupportedVideoUrl(value, platform);
}
