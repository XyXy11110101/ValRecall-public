// @vitest-environment node
import { createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import type { ImageLearningItem, VideoLearningItem } from '../database';
import { DATABASE_NAME, DATABASE_VERSION, STORE_NAMES } from '../database/migrations';
import { EXPORT_SCHEMA_VERSION } from '../database/types';
import {
  DAILY_TASK_KINDS,
  DAILY_TASK_SCHEMA_VERSION,
  TASK_EXPORT_SCHEMA_VERSION,
  type DailyTask,
} from '../models/daily-task';
import { deriveSourceGroups } from './source-groups';

const now = new Date('2026-07-23T12:00:00.000Z');

describe('derived source grouping', () => {
  it('chooses nonempty metadata independently and breaks capture-time ties by ID', () => {
    const older = item({ id: 'older', createdAt: new Date('2026-07-20T12:00:00Z') });
    const a = item({
      id: 'a',
      videoTitle: '  Selected title  ',
      uploader: ' ',
      screenshotId: null,
    });
    const b = item({
      id: 'b',
      videoTitle: 'Other title',
      uploader: '  Selected uploader  ',
      screenshotId: 'shot-b',
    });
    const newest = item({
      id: 'newest',
      createdAt: now,
      videoTitle: ' ',
      uploader: null,
      screenshotId: null,
    });
    for (const inputs of [
      [older, b, newest, a],
      [a, newest, b, older],
    ]) {
      const before = [...inputs];
      const group = deriveSourceGroups(inputs, now).groups[0]!;
      expect(group).toMatchObject({
        title: 'Selected title',
        uploader: 'Selected uploader',
        representativeScreenshotId: 'shot-b',
        earliestCaptureAt: older.createdAt,
        latestCaptureAt: now,
      });
      expect(inputs).toEqual(before);
    }
  });

  it('aggregates a large source group without spreading timestamps into function arguments', () => {
    const repeated = item({ id: 'large-source' });
    const inputs = Array<VideoLearningItem>(150_000).fill(repeated);
    const group = deriveSourceGroups(inputs, now).groups[0]!;
    expect(group.totalCount).toBe(inputs.length);
    expect(group.dueCount).toBe(inputs.length);
    expect(group.earliestCaptureAt).toEqual(repeated.createdAt);
    expect(group.latestCaptureAt).toEqual(repeated.createdAt);
    expect(group.items[0]).toBe(repeated);
  });

  it('groups YouTube captures by video ID while retaining item-specific playlist context', () => {
    const first = item({
      id: 'youtube-first',
      platform: 'youtube',
      videoId: 'AbCdEf_123-',
      sourceUrl:
        'https://www.youtube.com/watch?v=AbCdEf_123-&list=PLAYLIST_A&index=2&t=20s&utm_source=x',
      canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
      timestampSeconds: 20,
    });
    const second = item({
      id: 'youtube-second',
      platform: 'youtube',
      videoId: 'AbCdEf_123-',
      sourceUrl:
        'https://www.youtube.com/watch?tracking=1&list=PLAYLIST_B&v=AbCdEf_123-&index=8&t=80s',
      canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
      timestampSeconds: 80,
    });

    const result = deriveSourceGroups([second, first], now);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: 'youtube:AbCdEf_123-',
      canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
      totalCount: 2,
    });
    expect(result.groups[0]?.items.map((candidate) => candidate.sourceUrl)).toEqual([
      first.sourceUrl,
      second.sourceUrl,
    ]);
  });

  it('groups direct and modal Douyin captures by numeric ID and keeps different IDs separate', () => {
    const sharedId = '7391234567890123456';
    const modal = item({
      id: 'douyin-modal',
      platform: 'douyin',
      videoId: sharedId,
      sourceUrl:
        `https://www.douyin.com/user/self?showTab=favorite_collection&modal_id=${sharedId}` +
        '&from_tab_name=main',
      canonicalUrl: `https://www.douyin.com/video/${sharedId}`,
    });
    const direct = item({
      id: 'douyin-direct',
      platform: 'douyin',
      videoId: sharedId,
      sourceUrl: `https://www.douyin.com/video/${sharedId}?tracking=1`,
      canonicalUrl: `https://www.douyin.com/video/${sharedId}`,
    });
    const other = item({
      id: 'douyin-other',
      platform: 'douyin',
      videoId: '7391234567890123457',
      sourceUrl: 'https://www.douyin.com/video/7391234567890123457',
      canonicalUrl: 'https://www.douyin.com/video/7391234567890123457',
    });

    const result = deriveSourceGroups([modal, direct, other], now);

    expect(result.groups).toHaveLength(2);
    const shared = result.groups.find((group) => group.videoId === sharedId);
    expect(shared).toMatchObject({
      key: `douyin:${sharedId}`,
      canonicalUrl: `https://www.douyin.com/video/${sharedId}`,
      totalCount: 2,
    });
    expect(shared?.items).toEqual(expect.arrayContaining([modal, direct]));
  });

  it('groups Bilibili parts by stable video ID without losing each part URL', () => {
    const partOne = item({
      id: 'bilibili-p1',
      platform: 'bilibili',
      videoId: 'BV1AbC123',
      sourceUrl: 'https://www.bilibili.com/video/BV1AbC123?p=1&from=collection',
      canonicalUrl: 'https://www.bilibili.com/video/BV1AbC123',
      timestampSeconds: 40,
    });
    const partTwo = item({
      id: 'bilibili-p2',
      platform: 'bilibili',
      videoId: 'BV1AbC123',
      sourceUrl: 'https://www.bilibili.com/video/BV1AbC123?p=2&spm_id_from=333',
      canonicalUrl: 'https://www.bilibili.com/video/BV1AbC123',
      timestampSeconds: 10,
    });

    const result = deriveSourceGroups([partOne, partTwo], now);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      key: 'bilibili:BV1AbC123',
      canonicalUrl: 'https://www.bilibili.com/video/BV1AbC123',
      totalCount: 2,
    });
    expect(result.groups[0]?.items.map((candidate) => candidate.sourceUrl)).toEqual([
      partTwo.sourceUrl,
      partOne.sourceUrl,
    ]);
  });

  it('groups Watch Later tracking variants and direct Bilibili URLs by stable bvid', () => {
    const watchLaterFirst = item({
      id: 'bilibili-watch-later-first',
      platform: 'bilibili',
      videoId: 'BV1Ab411c7Cd',
      sourceUrl:
        'https://www.bilibili.com/list/watchlater?oid=100000000000001&bvid=BV1Ab411c7Cd&vd_source=first',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      timestampSeconds: 10,
    });
    const watchLaterSecond = item({
      id: 'bilibili-watch-later-second',
      platform: 'bilibili',
      videoId: 'BV1Ab411c7Cd',
      sourceUrl:
        'https://www.bilibili.com/list/watchlater?spm_id_from=other&bvid=BV1Ab411c7Cd&oid=999',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      timestampSeconds: 20,
    });
    const direct = item({
      id: 'bilibili-direct',
      platform: 'bilibili',
      videoId: 'BV1Ab411c7Cd',
      sourceUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      timestampSeconds: 30,
    });
    const other = item({
      id: 'bilibili-watch-later-other',
      platform: 'bilibili',
      videoId: 'BV1Different',
      sourceUrl: 'https://www.bilibili.com/list/watchlater?bvid=BV1Different',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Different',
      timestampSeconds: 40,
    });

    const result = deriveSourceGroups([other, direct, watchLaterSecond, watchLaterFirst], now);

    const shared = result.groups.find((group) => group.videoId === 'BV1Ab411c7Cd');
    expect(result.groups).toHaveLength(2);
    expect(shared).toMatchObject({
      key: 'bilibili:BV1Ab411c7Cd',
      canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
      totalCount: 3,
    });
    expect(shared?.items.map((candidate) => candidate.sourceUrl)).toEqual([
      watchLaterFirst.sourceUrl,
      watchLaterSecond.sourceUrl,
      direct.sourceUrl,
    ]);
  });

  it('does not merge different Bilibili video identities', () => {
    const result = deriveSourceGroups(
      [
        item({
          id: 'bilibili-a',
          platform: 'bilibili',
          videoId: 'BV1AbC123',
          sourceUrl: 'https://www.bilibili.com/video/BV1AbC123?p=2',
          canonicalUrl: 'https://www.bilibili.com/video/BV1AbC123',
        }),
        item({
          id: 'bilibili-b',
          platform: 'bilibili',
          videoId: 'BV1Different',
          sourceUrl: 'https://www.bilibili.com/video/BV1Different?p=2',
          canonicalUrl: 'https://www.bilibili.com/video/BV1Different',
        }),
      ],
      now,
    );

    expect(result.groups.map((group) => group.key).sort()).toEqual([
      'bilibili:BV1AbC123',
      'bilibili:BV1Different',
    ]);
  });

  it('keeps malformed or inconsistent legacy items visible as ungrouped', () => {
    const malformed = item({
      id: 'malformed',
      platform: 'youtube',
      videoId: 'AbCdEf_123-',
      sourceUrl: 'https://www.youtube.com/shorts/AbCdEf_123-',
      canonicalUrl: null,
    });
    const inconsistent = item({
      id: 'inconsistent',
      platform: 'douyin',
      videoId: '7391234567890123456',
      sourceUrl: 'https://www.douyin.com/video/7391234567890123457',
      canonicalUrl: null,
    });

    const result = deriveSourceGroups([malformed, inconsistent], now);

    expect(result.groups).toEqual([]);
    expect(result.ungrouped.map((candidate) => candidate.id)).toEqual([
      'inconsistent',
      'malformed',
    ]);
  });

  it('keeps Image Moments ungrouped and safely groups a manual Video without capture media', () => {
    const captured = item({
      id: 'captured-video',
      timestampSeconds: 15,
      screenshotId: 'captured-screenshot',
    });
    const manual = item({
      id: 'manual-video',
      sourceType: 'video',
      videoOrigin: 'library',
      timestampSeconds: null,
      timestampDisplay: null,
      screenshotId: null,
    });
    const image = imageItem('image-moment');

    const result = deriveSourceGroups([image, manual, captured], now);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.items.map((candidate) => candidate.id)).toEqual([
      captured.id,
      manual.id,
    ]);
    expect(result.groups[0]?.representativeScreenshotId).toBe('captured-screenshot');
    expect(result.ungrouped).toEqual([image]);
  });

  it('uses the newest non-empty title and falls back to platform plus video ID', () => {
    const older = item({
      id: 'older',
      videoTitle: 'Older title',
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
    });
    const newer = item({
      id: 'newer',
      videoTitle: 'Newer title',
      createdAt: new Date('2026-07-22T12:00:00.000Z'),
    });
    const untitled = item({
      id: 'untitled',
      videoId: 'ZyXwVu_987-',
      sourceUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
      canonicalUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
      videoTitle: '   ',
    });

    const result = deriveSourceGroups([older, newer, untitled], now);

    expect(result.groups.find((group) => group.videoId === 'AbCdEf_123-')?.title).toBe(
      'Newer title',
    );
    expect(result.groups.find((group) => group.videoId === 'ZyXwVu_987-')?.title).toBe(
      'YouTube ZyXwVu_987-',
    );
  });

  it('uses an existing screenshot reference and has a deterministic missing-screenshot fallback', () => {
    const withScreenshot = item({
      id: 'with-screenshot',
      screenshotId: 'shot-1',
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
    });
    const newerWithout = item({
      id: 'without-screenshot',
      screenshotId: null,
      createdAt: new Date('2026-07-22T12:00:00.000Z'),
    });
    const noScreenshotAtAll = item({
      id: 'other-source',
      videoId: 'ZyXwVu_987-',
      sourceUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
      canonicalUrl: 'https://www.youtube.com/watch?v=ZyXwVu_987-',
      screenshotId: null,
    });

    const result = deriveSourceGroups([newerWithout, withScreenshot, noScreenshotAtAll], now);

    expect(
      result.groups.find((group) => group.videoId === 'AbCdEf_123-')?.representativeScreenshotId,
    ).toBe('shot-1');
    expect(
      result.groups.find((group) => group.videoId === 'ZyXwVu_987-')?.representativeScreenshotId,
    ).toBeNull();
  });

  it('calculates due and total counts and orders items by video timestamp', () => {
    const future = item({
      id: 'future',
      timestampSeconds: 90,
      due: new Date('2026-07-24T12:00:00.000Z'),
    });
    const due = item({
      id: 'due',
      timestampSeconds: 10,
      due: new Date('2026-07-22T12:00:00.000Z'),
    });
    const suspended = item({
      id: 'suspended',
      timestampSeconds: 50,
      due: new Date('2026-07-22T12:00:00.000Z'),
      suspended: true,
    });

    const result = deriveSourceGroups([future, suspended, due], now);

    expect(result.groups[0]).toMatchObject({ totalCount: 3, dueCount: 1 });
    expect(result.groups[0]?.items.map((candidate) => candidate.id)).toEqual([
      'due',
      'suspended',
      'future',
    ]);
  });

  it('does not mutate learning records, FSRS cards, histories, task models, or schemas', () => {
    const sourceItem = item({ id: 'protected' });
    const cardReference = sourceItem.fsrsCard;
    const historyReference = sourceItem.reviewHistory;
    const task: DailyTask = {
      id: 'practice-task',
      schemaVersion: 1,
      title: 'Practise protected item',
      notes: null,
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-23',
      scheduledTime: null,
      selectedWeekdays: [],
      linkedLearningItemId: sourceItem.id,
      priority: 'normal',
      archived: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const taskBefore = structuredClone(task);

    const result = deriveSourceGroups([sourceItem], now);

    expect(result.groups[0]?.items[0]).toBe(sourceItem);
    expect(sourceItem.fsrsCard).toBe(cardReference);
    expect(sourceItem.reviewHistory).toBe(historyReference);
    expect(task).toEqual(taskBefore);
    expect(DATABASE_NAME).toBe('valrecall');
    expect(DATABASE_VERSION).toBe(6);
    expect(Object.values(STORE_NAMES)).toEqual([
      'items',
      'screenshots',
      'reviews',
      'meta',
      'dailyTasks',
      'taskCompletions',
      'notes',
      'intakeReceipts',
      'wallet',
      'syncReceipts',
      'taskRevisions',
      'occurrenceRevisions',
      'taskSkips',
      'drafts',
      'learningReceipts',
      'reviewSessions',
    ]);
    expect(EXPORT_SCHEMA_VERSION).toBe(11);
    expect(DAILY_TASK_SCHEMA_VERSION).toBe(1);
    expect(TASK_EXPORT_SCHEMA_VERSION).toBe(2);
    expect(DAILY_TASK_KINDS).toEqual(['routine', 'one_off', 'practice']);
  });
});

function item(
  overrides: Partial<VideoLearningItem> & Pick<VideoLearningItem, 'id'> & { due?: Date },
): VideoLearningItem {
  const { due, id, ...itemOverrides } = overrides;
  const createdAt = itemOverrides.createdAt ?? new Date('2026-07-21T12:00:00.000Z');
  const card = createEmptyCard(createdAt);
  return {
    id,
    schemaVersion: 2,
    platform: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
    canonicalUrl: 'https://www.youtube.com/watch?v=AbCdEf_123-',
    videoId: 'AbCdEf_123-',
    videoTitle: 'Video title',
    uploader: 'Creator',
    description: null,
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: '',
    situation: '',
    coreLesson: 'Keep the model unchanged.',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'What is the lesson?',
    referenceAnswer: 'Keep the model unchanged.',
    tags: [],
    createdAt,
    updatedAt: createdAt,
    fsrsCard: {
      ...card,
      due: due ?? card.due,
    },
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
    ...itemOverrides,
  };
}

function imageItem(id: string): ImageLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'image',
    title: 'Image Moment',
    imageAssetId: `asset-${id}`,
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: 'Use the image as the recall cue.',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'What does this image demonstrate?',
    referenceAnswer: 'The image demonstrates the saved lesson.',
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
