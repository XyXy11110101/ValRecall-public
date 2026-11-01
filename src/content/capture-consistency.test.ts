import { describe, expect, it, vi } from 'vitest';

import type { CapturePageResponse } from '../models/messages';
import {
  createCaptureConsistencySession,
  validateCaptureConsistencySession,
} from './capture-consistency';

describe('content capture consistency session', () => {
  it('binds validation to one draft and surfaces a changed modal', () => {
    const validate = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const adapter = { createCaptureConsistencyCheck: () => validate };
    const session = createCaptureConsistencySession(adapter, successfulCapture('draft-modal'));

    expect(validateCaptureConsistencySession(session, 'another-draft')).toBe(false);
    expect(validateCaptureConsistencySession(session, 'draft-modal')).toBe(true);
    expect(validateCaptureConsistencySession(session, 'draft-modal')).toBe(false);
  });

  it('contains a guard exception and clears failed captures', () => {
    const adapter = {
      createCaptureConsistencyCheck: () => () => {
        throw new Error('modal removed');
      },
    };
    expect(
      validateCaptureConsistencySession(
        createCaptureConsistencySession(adapter, successfulCapture('draft-error')),
        'draft-error',
      ),
    ).toBe(false);
    expect(
      createCaptureConsistencySession(adapter, {
        ok: false,
        error: { code: 'VIDEO_NOT_FOUND', message: 'No modal.' },
      }),
    ).toBeNull();
  });
});

function successfulCapture(draftId: string): CapturePageResponse {
  return {
    ok: true,
    draft: {
      draftId,
      schemaVersion: 2,
      platform: 'douyin',
      sourceUrl: 'https://www.douyin.com/video/7000000000000000002',
      canonicalUrl: 'https://www.douyin.com/video/7000000000000000002',
      videoId: '7000000000000000002',
      videoTitle: 'Modal lesson',
      uploader: null,
      description: null,
      timestampSeconds: 12,
      timestampDisplay: '00:12',
      videoDurationSeconds: 120,
      chapterTitle: null,
      videoBounds: null,
      screenshotDataUrl: null,
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      subtitleCueData: [],
      subtitleStatus: 'unavailable',
      subtitleExtractionStrategy: 'none',
      subtitleConfidence: 'none',
      capturedAt: '2026-07-22T12:00:00.000Z',
      extractionDiagnostics: [],
    },
  };
}
