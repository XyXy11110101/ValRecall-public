import { describe, expect, it, vi } from 'vitest';

import { FsrsService } from '../fsrs';
import type { CaptureDraft, LearningItemDraftFields } from '../models/learning-item';
import {
  buildScheduledLearningItemInput,
  keyTakeawayValidationMessage,
  recallPromptValidationMessage,
  scheduleAutomaticPreview,
  summariseSubtitleSource,
  subtitleUnavailableMessage,
} from './editor';

const fields: LearningItemDraftFields = {
  situation: 'Entry timing',
  coreLesson: 'Wait for the flash before moving.',
  mistakeToAvoid: '',
  recommendedAction: 'Wait for the flash before moving.',
  reason: '',
  recallPrompt: 'What action should you take in this situation?',
  referenceAnswer: 'Wait for the flash before moving.',
  tags: ['bilibili', 'do'],
};

const draft: CaptureDraft = {
  draftId: 'draft-1',
  schemaVersion: 1,
  platform: 'bilibili',
  sourceUrl: 'https://www.bilibili.com/video/BV1test',
  canonicalUrl: null,
  videoId: 'BV1test',
  videoTitle: 'Fixture lesson',
  uploader: null,
  description: null,
  timestampSeconds: 42,
  timestampDisplay: '00:42',
  videoDurationSeconds: 120,
  chapterTitle: null,
  videoBounds: null,
  screenshotDataUrl: 'data:image/jpeg;base64,AA==',
  subtitleBefore: [],
  subtitleCurrent: ['Wait for the flash.'],
  subtitleAfter: [],
  subtitleCueData: [],
  subtitleStatus: 'current_only',
  subtitleExtractionStrategy: 'visible_video_overlay',
  subtitleConfidence: 'medium',
  capturedAt: '2026-07-20T12:00:00.000Z',
  extractionDiagnostics: [],
};

describe('side-panel editor model', () => {
  it('debounces automatic preview work so the latest edit wins', async () => {
    vi.useFakeTimers();
    const generated: string[] = [];
    const cancelFirst = scheduleAutomaticPreview(() => {
      generated.push('old');
    });
    cancelFirst();
    scheduleAutomaticPreview(() => {
      generated.push('latest');
    });

    await vi.runAllTimersAsync();

    expect(generated).toEqual(['latest']);
    vi.useRealTimers();
  });

  it('requires a meaningful Key takeaway and rejects the settings-document signature', () => {
    expect(keyTakeawayValidationMessage('  ')).toContain('关键收获');
    expect(
      keyTakeawayValidationMessage(
        '\u701b\u6940\u7bb7\u7481\u5267\u7586\u0020\u701b\u6940\u7bb7\u6fb6\u0443\u76ac\u0020\u701b\u6940\u7bb7\u68f0\u6ec6\u58ca\u0020\u93bb\u5fda\u7adf\u93c2\u7470\u7d21\u0020\u699b\u6a3f\ue17b\u6d63\u5d87\u7586\u0020\u93ad\u3220\ue632\u699b\u6a3f\ue17b\u7481\u5267\u7586',
      ),
    ).toContain('字幕设置');
    expect(keyTakeawayValidationMessage('Use the flash before moving.')).toBeNull();
  });

  it('requires a non-empty Recall prompt without normalising authored text', () => {
    expect(recallPromptValidationMessage(' \n ')).toBe('保存前请填写回忆提示。');
    expect(recallPromptValidationMessage('  What did I miss here?  ')).toBeNull();
  });

  it('distinguishes unreadable player tracks from possible burned-in subtitles', () => {
    const unavailable = {
      ...draft,
      subtitleStatus: 'unavailable' as const,
      subtitleExtractionStrategy: 'none' as const,
      subtitleConfidence: 'none' as const,
      subtitleCurrent: [],
    };
    const playerTrack = {
      ...unavailable,
      extractionDiagnostics: [
        {
          field: 'subtitles',
          strategy: 'subtitles-available-unreadable',
          status: 'failed' as const,
          severity: 'warning' as const,
          message: 'Player subtitles were available but unreadable.',
        },
      ],
    };
    const burnedIn = {
      ...unavailable,
      extractionDiagnostics: [
        {
          field: 'subtitles',
          strategy: 'no-subtitles-available',
          status: 'failed' as const,
          severity: 'warning' as const,
          message: 'No player or DOM subtitle source was accessible.',
        },
      ],
    };

    expect(summariseSubtitleSource(playerTrack).label).toBe('Captions available but unreadable');
    expect(subtitleUnavailableMessage(playerTrack)).toBe(
      'Player captions were available but could not be read at this moment.',
    );
    expect(subtitleUnavailableMessage(burnedIn)).toBe(
      'The caption appears to be part of the video image and cannot be read without OCR.',
    );
  });

  it('builds a new save input with only coreLesson carrying the authored takeaway', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const fsrs = new FsrsService({ clock: () => now });
    const input = buildScheduledLearningItemInput({
      draft,
      videoTitle: 'Fixture lesson',
      itemType: 'Do',
      coreLesson: 'Use the flash before moving.',
      categoryId: null,
      fields: {
        ...fields,
        coreLesson: 'Use the flash before moving.',
        recallPrompt: '  What did I miss here?  ',
        referenceAnswer: 'A stale generated answer that must not become canonical.',
      },
      fsrsCard: fsrs.createInitialCard(),
    });

    expect(input.id).toBe('draft-1');
    expect(input.platform).toBe('bilibili');
    expect(input.coreLesson).toBe('Use the flash before moving.');
    expect(input.personalNote).toBe('');
    expect(input.referenceAnswer).toBe('Use the flash before moving.');
    expect(input.reason).toBe('');
    expect(input.recallPrompt).toBe('  What did I miss here?  ');
    expect(input.subtitleBefore).toEqual([]);
    expect(input.subtitleCurrent).toEqual(['Wait for the flash.']);
    expect(input.subtitleAfter).toEqual([]);
    expect(input.fsrsCard.due.toISOString()).toBe(now.toISOString());
    expect(fsrs.isDue(input.fsrsCard)).toBe(true);
  });
});
