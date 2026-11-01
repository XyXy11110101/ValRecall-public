import { describe, expect, it } from 'vitest';

import {
  isCaptureConsistencyResponse,
  isOpenDashboardResponse,
  isReminderStatusResponse,
  isSeekToTimestampResponse,
  isTestReminderResponse,
  isValRecallMessage,
  MESSAGE_PROTOCOL_VERSION,
  MESSAGE_TYPES,
} from './messages';
import type { PageSubtitleSnapshot } from './page-subtitles';

describe('ValRecall message validation', () => {
  it('validates optional library targets while retaining old dashboard requests', () => {
    const message = { type: MESSAGE_TYPES.openDashboard, version: MESSAGE_PROTOCOL_VERSION };
    for (const payload of [
      undefined,
      { view: 'library' },
      { view: 'library', itemId: '回忆题 & one' },
    ])
      expect(isValRecallMessage({ ...message, ...(payload ? { payload } : {}) })).toBe(true);
    for (const payload of [
      null,
      {},
      { view: 'review' },
      { view: 'library', itemId: '' },
      { view: 'library', itemId: ' ' },
      { view: 'library', itemId: 'x'.repeat(513) },
      { view: 'library', itemId: 'x\ny' },
      { view: 'library', itemId: 1 },
    ])
      expect(isValRecallMessage({ ...message, payload })).toBe(false);
  });
  it('accepts capture and valid seek contracts', () => {
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.capturePage,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.capturePage,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { subtitleSnapshot: subtitleSnapshot() },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.validateCapturePage,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { draftId: 'draft-modal' },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'douyin',
          sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=1',
          canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
          timestampSeconds: 12.5,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'bilibili',
          sourceUrl:
            'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd&vd_source=tracking',
          canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
          timestampSeconds: 42,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openDashboard,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.sendTestReminder,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.sendTestDailyPlan,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.refreshReviewReminders,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.getReminderStatus,
        version: MESSAGE_PROTOCOL_VERSION,
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.seekToTimestamp,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { timestampSeconds: 12.5, pauseAfterSeek: true },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          sourceUrl: 'https://www.bilibili.com/video/BV1abc123',
          canonicalUrl: null,
          timestampSeconds: 12.5,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture&index=2',
          canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
          timestampSeconds: 12.5,
          pauseAfterSeek: false,
        },
      }),
    ).toBe(true);
  });

  it('accepts null only for a validated source-only open request', () => {
    for (const payload of [
      {
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture&index=2',
        canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
      },
      {
        platform: 'bilibili',
        sourceUrl: 'https://www.bilibili.com/video/BV1abc123?p=2',
        canonicalUrl: 'https://www.bilibili.com/video/BV1abc123',
      },
      {
        platform: 'douyin',
        sourceUrl: 'https://www.douyin.com/user/self?modal_id=7391234567890123456',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
      },
    ] as const) {
      expect(
        isValRecallMessage({
          type: MESSAGE_TYPES.openSource,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: { ...payload, timestampSeconds: null, pauseAfterSeek: false },
        }),
      ).toBe(true);
    }

    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.seekToTimestamp,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { timestampSeconds: null, pauseAfterSeek: false },
      }),
    ).toBe(false);

    for (const timestampSeconds of [undefined, '12', Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        isValRecallMessage({
          type: MESSAGE_TYPES.openSource,
          version: MESSAGE_PROTOCOL_VERSION,
          payload: {
            platform: 'youtube',
            sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            timestampSeconds,
            pauseAfterSeek: false,
          },
        }),
      ).toBe(false);
    }

    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
          canonicalUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
          timestampSeconds: null,
          pauseAfterSeek: false,
        },
      }),
    ).toBe(false);
  });

  it('rejects unknown, negative, and structurally invalid messages', () => {
    expect(isValRecallMessage({ type: 'CAPTURE' })).toBe(false);
    expect(isValRecallMessage({ type: MESSAGE_TYPES.capturePage })).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.capturePage,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          subtitleSnapshot: { ...subtitleSnapshot(), tracks: [{ text: 'unvalidated' }] },
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.validateCapturePage,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { draftId: '' },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.seekToTimestamp,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { timestampSeconds: -1 },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'douyin',
          sourceUrl: 'https://v.douyin.com/abc123/',
          canonicalUrl: null,
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'bilibili',
          sourceUrl: 'https://www.bilibili.com/list/watchlater?oid=100000000000001',
          canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
          timestampSeconds: 42,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'douyin',
          sourceUrl: 'https://www.douyin.com/video/7391234567890123456',
          canonicalUrl: 'https://www.douyin.com/video/7391234567890123457',
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
          canonicalUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'bilibili',
          sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
          canonicalUrl: null,
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/shorts/AbCdEf_123-',
          canonicalUrl: null,
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.captureDraftReady,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {},
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.openSource,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          sourceUrl: 'javascript:alert(1)',
          canonicalUrl: null,
          timestampSeconds: 1,
          pauseAfterSeek: true,
        },
      }),
    ).toBe(false);
  });

  it('validates complete capture and seek response boundaries', () => {
    const draft = {
      draftId: 'draft-1',
      schemaVersion: 1,
      platform: 'bilibili',
      sourceUrl: 'https://www.bilibili.com/video/BV1abc123?p=2',
      canonicalUrl: 'https://www.bilibili.com/video/BV1abc123',
      videoId: 'BV1abc123',
      videoTitle: 'Lesson',
      uploader: null,
      description: null,
      timestampSeconds: 12,
      timestampDisplay: '00:12',
      videoDurationSeconds: 120,
      chapterTitle: null,
      videoBounds: null,
      screenshotDataUrl: null,
      subtitleBefore: [],
      subtitleCurrent: ['Hold this angle.'],
      subtitleAfter: [],
      subtitleCueData: [],
      subtitleStatus: 'current_only',
      subtitleExtractionStrategy: 'visible_video_overlay',
      subtitleConfidence: 'medium',
      capturedAt: '2026-07-20T12:00:00.000Z',
      extractionDiagnostics: [],
    };

    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { ok: true, draft },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          ok: true,
          draft: {
            ...draft,
            schemaVersion: 2,
            platform: 'douyin',
            sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=1',
            canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
            videoId: '7391234567890123456',
            videoDurationSeconds: null,
          },
        },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          ok: true,
          draft: {
            ...draft,
            schemaVersion: 1,
            platform: 'douyin',
            sourceUrl: 'https://www.douyin.com/video/7391234567890123456',
            canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
            videoId: '7391234567890123456',
          },
        },
      }),
    ).toBe(false);

    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          ok: true,
          draft: {
            ...draft,
            schemaVersion: 2,
            platform: 'youtube',
            sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            videoId: 'ZyXwVu_987-',
          },
        },
      }),
    ).toBe(false);

    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          ok: true,
          draft: {
            ...draft,
            schemaVersion: 2,
            platform: 'youtube',
            sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLfixture',
            canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            videoId: 'AbCdEf_123-',
          },
        },
      }),
    ).toBe(true);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: {
          ok: true,
          draft: {
            ...draft,
            platform: 'youtube',
            sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
            videoId: 'AbCdEf_123-',
          },
        },
      }),
    ).toBe(false);
    expect(
      isValRecallMessage({
        type: MESSAGE_TYPES.pendingCaptureChanged,
        version: MESSAGE_PROTOCOL_VERSION,
        payload: { ok: false, error: { code: 'NOT_ALLOWED', message: 'No.' } },
      }),
    ).toBe(false);
    expect(
      isSeekToTimestampResponse({
        ok: true,
        attempts: 1,
        timestampSeconds: 12,
        error: null,
        diagnostics: [],
      }),
    ).toBe(true);
    expect(
      isSeekToTimestampResponse({ ok: true, attempts: -1, timestampSeconds: 12, error: null }),
    ).toBe(false);
    expect(isOpenDashboardResponse({ ok: true })).toBe(true);
    expect(isOpenDashboardResponse({ ok: false, error: 'Dashboard could not open.' })).toBe(true);
    expect(isOpenDashboardResponse({ ok: false, error: '' })).toBe(false);
    expect(isTestReminderResponse({ ok: true })).toBe(true);
    expect(isTestReminderResponse({ ok: false, error: 'Notifications are unavailable.' })).toBe(
      true,
    );
    expect(isTestReminderResponse({ ok: false, error: '' })).toBe(false);
    expect(
      isReminderStatusResponse({
        ok: true,
        status: {
          nextReviewReminderAt: '2026-07-21T12:10:00.000Z',
          notificationPermission: 'granted',
        },
      }),
    ).toBe(true);
    expect(
      isReminderStatusResponse({
        ok: true,
        status: {
          nextReviewReminderAt: 'not-a-date',
          notificationPermission: 'granted',
        },
      }),
    ).toBe(false);
    expect(isCaptureConsistencyResponse({ ok: true })).toBe(true);
    expect(isCaptureConsistencyResponse({ ok: 'true' })).toBe(false);
  });
});

function subtitleSnapshot(): PageSubtitleSnapshot {
  return {
    version: 1,
    requestId: 'validated-bridge-request',
    platform: 'youtube',
    href: 'https://www.youtube.com/watch?v=AbCdEf_123-',
    collectedAt: 1_786_000_000_000,
    selectedLanguage: 'en',
    structuredStateInspected: false,
    video: { currentTime: 12.5, duration: 120, currentSrc: null },
    tracks: [],
  };
}
