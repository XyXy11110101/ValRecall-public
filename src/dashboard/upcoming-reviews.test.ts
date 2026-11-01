import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import type { ImageLearningItem, VideoLearningItem } from '../database';
import {
  buildUpcomingReviewCohorts,
  bucketUpcomingReviewCohorts,
  formatReviewExact,
  formatReviewRelative,
  localReviewBucketBoundaries,
  rangeEnd,
} from './upcoming-reviews';

const now = new Date(2026, 6, 21, 12, 0, 0);

describe('upcoming review presentation model', () => {
  it('aggregates a large minute cohort without the function-argument limit', () => {
    const due = new Date(2026, 6, 21, 19, 40, 5);
    const repeated = item('large-cohort', due, State.Review, 'youtube');
    const inputs = Array<VideoLearningItem>(150_000).fill(repeated);
    const result = buildUpcomingReviewCohorts(inputs);
    expect(result.invalidCount).toBe(0);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({
      itemCount: inputs.length,
      earliestDue: due,
      latestDue: due,
      stateCounts: { 复习: inputs.length },
      platformCounts: { youtube: inputs.length, bilibili: 0, douyin: 0 },
    });
    expect(result.cohorts[0]?.itemIds).toHaveLength(inputs.length);
  });

  it('groups exact and second-different timestamps only within the same displayed local minute', () => {
    const exact = new Date(2026, 6, 21, 19, 40, 5, 100);
    const sameMinute = new Date(2026, 6, 21, 19, 40, 59, 999);
    const nextMinute = new Date(2026, 6, 21, 19, 41, 0, 0);
    const result = buildUpcomingReviewCohorts([
      item('b', sameMinute, State.Review, 'youtube'),
      item('a', exact, State.Learning, 'bilibili'),
      item('c', nextMinute, State.Relearning, 'douyin'),
    ]);

    expect(result.invalidCount).toBe(0);
    expect(result.cohorts).toHaveLength(2);
    expect(result.cohorts[0]).toMatchObject({
      key: '2026-07-21-19-40',
      itemCount: 2,
      itemIds: ['a', 'b'],
      stateCounts: { 学习中: 1, 复习: 1 },
      platformCounts: { bilibili: 1, youtube: 1, douyin: 0 },
    });
    expect(result.cohorts[0]?.earliestDue.getTime()).toBe(exact.getTime());
    expect(result.cohorts[0]?.latestDue.getTime()).toBe(sameMinute.getTime());
    expect(result.cohorts[0]?.items.map((value) => value.fsrsCard.due.getTime())).toEqual([
      exact.getTime(),
      sameMinute.getTime(),
    ]);
    expect(result.cohorts[1]?.key).toBe('2026-07-21-19-41');
  });

  it('counts Image and manual Video Moments without treating either as a fake platform', () => {
    const due = new Date(2026, 6, 21, 19, 40, 30);
    const manualVideo = item('manual-video', due, State.Review, 'youtube');
    manualVideo.sourceType = 'video';
    manualVideo.videoOrigin = 'library';
    manualVideo.timestampSeconds = null;
    manualVideo.timestampDisplay = null;
    manualVideo.screenshotId = null;
    const image = imageItem('image-moment', due);

    const result = buildUpcomingReviewCohorts([image, manualVideo]);

    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toMatchObject({
      itemIds: ['image-moment', 'manual-video'],
      itemCount: 2,
      platformCounts: { bilibili: 0, youtube: 1, douyin: 0 },
      textCount: 0,
      imageCount: 1,
    });
  });

  it('keeps a stable cohort key and deterministic order for a large cohort', () => {
    const due = new Date(2026, 6, 21, 19, 40, 30);
    const values = Array.from({ length: 40 }, (_, index) =>
      item(`item-${index.toString().padStart(2, '0')}`, due),
    ).reverse();
    const first = buildUpcomingReviewCohorts(values).cohorts[0]!;
    const second = buildUpcomingReviewCohorts([...values]).cohorts[0]!;
    expect(first.key).toBe(second.key);
    expect(first.itemCount).toBe(40);
    expect(first.itemIds).toEqual([...first.itemIds].sort());
  });

  it('reports invalid due values without hiding valid cohorts', () => {
    const invalid = item('invalid', new Date(2026, 6, 21, 15));
    invalid.fsrsCard.due = new Date(Number.NaN);
    const result = buildUpcomingReviewCohorts([invalid, item('valid', new Date(2026, 6, 21, 16))]);
    expect(result.invalidCount).toBe(1);
    expect(result.cohorts).toHaveLength(1);
  });

  it('buckets due, local Today, Tomorrow, Next 7 days and Later', () => {
    const values = [
      item('due', new Date(2026, 6, 21, 11, 59, 59)),
      item('today', new Date(2026, 6, 21, 23, 59)),
      item('tomorrow', new Date(2026, 6, 22, 10)),
      item('next-seven', new Date(2026, 6, 24, 10)),
      item('later', new Date(2026, 7, 1, 10)),
    ];
    const buckets = bucketUpcomingReviewCohorts(buildUpcomingReviewCohorts(values).cohorts, now);
    expect(buckets.map((bucket) => [bucket.key, bucket.itemCount])).toEqual([
      ['due-now', 1],
      ['today', 1],
      ['tomorrow', 1],
      ['next-seven-days', 1],
      ['later', 1],
    ]);
  });

  it('uses local calendar boundaries across midnight and daylight-saving changes', () => {
    const nearMidnight = new Date(2026, 2, 28, 23, 30);
    const boundaries = localReviewBucketBoundaries(nearMidnight);
    expect(boundaries.tomorrow.getDate()).toBe(29);
    expect(boundaries.tomorrow.getHours()).toBe(0);
    expect(boundaries.afterTomorrow.getDate()).toBe(30);
    expect(boundaries.afterTomorrow.getHours()).toBe(0);

    const autumn = localReviewBucketBoundaries(new Date(2026, 9, 24, 23, 30));
    expect(autumn.tomorrow.getDate()).toBe(25);
    expect(autumn.afterTomorrow.getDate()).toBe(26);
    expect(autumn.afterTomorrow.getHours()).toBe(0);
  });

  it('formats relative and exact local labels without seconds', () => {
    expect(formatReviewRelative(new Date(2026, 6, 21, 12, 18, 30), now)).toBe('19 分钟后');
    expect(formatReviewRelative(new Date(2026, 6, 21, 19, 40), now)).toBe('今天 19:40');
    expect(formatReviewRelative(new Date(2026, 6, 22, 10, 15), now)).toBe('明天 10:15');
    expect(formatReviewExact(new Date(2026, 6, 21, 19, 40, 59), now)).toBe('今天 19:40');
    expect(formatReviewExact(new Date(2026, 6, 22, 10, 15), now)).toBe('明天 10:15');
    expect(formatReviewExact(new Date(2026, 6, 31, 14, 20), now)).toContain('2026年7月31日');
  });

  it('creates deterministic bounded range ends and leaves All unbounded', () => {
    expect(rangeEnd(now, '7-days')?.getDate()).toBe(28);
    expect(rangeEnd(now, '30-days')?.getTime()).toBe(new Date(2026, 7, 20, 12).getTime());
    expect(rangeEnd(now, 'all')).toBeUndefined();
  });
});

function item(
  id: string,
  due: Date,
  state: State = State.Review,
  platform: VideoLearningItem['platform'] = 'bilibili',
): VideoLearningItem {
  const card = createEmptyCard(due);
  card.state = state;
  return {
    id,
    schemaVersion: 2,
    platform,
    sourceUrl:
      platform === 'youtube'
        ? `https://www.youtube.com/watch?v=${id.padEnd(11, 'x').slice(0, 11)}`
        : platform === 'douyin'
          ? 'https://www.douyin.com/video/7391234567890123456'
          : `https://www.bilibili.com/video/BV${id}`,
    canonicalUrl: null,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: `screenshot-${id}`,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: new Date(2026, 6, 20),
    updatedAt: new Date(2026, 6, 20),
    fsrsCard: card,
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

function imageItem(id: string, due: Date): ImageLearningItem {
  return {
    id,
    schemaVersion: 2,
    sourceType: 'image',
    title: `Image ${id}`,
    imageAssetId: `asset-${id}`,
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: `Core ${id}`,
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: `Recall ${id}`,
    referenceAnswer: `Answer ${id}`,
    tags: [],
    createdAt: new Date(2026, 6, 20),
    updatedAt: new Date(2026, 6, 20),
    fsrsCard: createEmptyCard(due),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
