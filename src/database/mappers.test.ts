import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { LEARNING_ITEM_SCHEMA_VERSION } from '../models/learning-item';
import { DatabaseError } from './errors';
import {
  cardFromPersisted,
  cardToPersisted,
  itemFromPersisted,
  itemToPersisted,
  migratePersistedItem,
  reviewLogFromPersisted,
  reviewLogToPersisted,
} from './mappers';
import type { ImageLearningItem, TextLearningItem, VideoLearningItem } from './types';

const now = new Date('2026-07-20T12:00:00.000Z');

function itemFixture(): VideoLearningItem {
  return {
    id: 'item-1',
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1test',
    canonicalUrl: 'https://www.bilibili.com/video/BV1test',
    videoId: 'BV1test',
    videoTitle: 'Hold this angle',
    uploader: 'Coach',
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 300,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: ['Set up before the peek.'],
    subtitleCurrent: ['Keep your crosshair at head height.'],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: 'Pre-aim the common swing.',
    situation: 'Holding a common angle',
    coreLesson: 'Pre-aim before the opponent swings.',
    mistakeToAvoid: '',
    recommendedAction: 'Set the crosshair first.',
    reason: 'It reduces correction time.',
    recallPrompt: 'What action should you take in this situation?',
    referenceAnswer: 'Pre-aim the common swing.',
    tags: ['valorant'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}

describe('database mappers', () => {
  it('round-trips FSRS cards without leaking Date references', () => {
    const card = createEmptyCard(now);
    const persisted = cardToPersisted(card);
    const restored = cardFromPersisted(persisted);

    expect(persisted.due).toBe(now.toISOString());
    expect(restored).toEqual(card);
    expect(restored.due).not.toBe(card.due);
  });

  it('preserves UTC milliseconds, timezone-equivalent instants, and last_review', () => {
    const localOffsetInstant = new Date('2026-07-20T13:00:00.987+01:00');
    const scheduled = fsrs().next(
      createEmptyCard(localOffsetInstant),
      localOffsetInstant,
      Rating.Good,
    ).card;
    const restored = cardFromPersisted(cardToPersisted(scheduled));

    expect(restored.due.getTime()).toBe(scheduled.due.getTime());
    expect(restored.due.getMilliseconds()).toBe(scheduled.due.getMilliseconds());
    expect(restored.last_review?.getTime()).toBe(localOffsetInstant.getTime());
    expect(restored.last_review?.toISOString()).toBe('2026-07-20T12:00:00.987Z');
  });

  it('round-trips official review logs', () => {
    const result = fsrs().next(createEmptyCard(now), now, Rating.Good);
    const persisted = reviewLogToPersisted(result.log);
    const restored = reviewLogFromPersisted(persisted);

    expect(persisted.review).toBe(now.toISOString());
    expect(restored).toEqual(result.log);
    expect(restored.review).not.toBe(result.log.review);
  });

  it('migrates the initial unversioned item shape and restores Dates', () => {
    const persisted = itemToPersisted(itemFixture());
    const legacy = {
      ...persisted,
      schemaVersion: 0,
      updatedAt: undefined,
      createdAt: new Date(persisted.createdAt),
      fsrsCard: { ...persisted.fsrsCard, due: new Date(persisted.fsrsCard.due) },
    };

    const migrated = migratePersistedItem(legacy);
    const restored = itemFromPersisted(migrated);

    expect(migrated.schemaVersion).toBe(LEARNING_ITEM_SCHEMA_VERSION);
    expect(migrated.sourceType).toBe('video');
    if (migrated.sourceType !== 'video') throw new Error('Expected a migrated video item.');
    expect(migrated.platform).toBe('bilibili');
    expect(migrated.updatedAt).toBe(migrated.createdAt);
    expect(restored.createdAt).toBeInstanceOf(Date);
    expect(restored.fsrsCard.due).toBeInstanceOf(Date);
  });

  it('normalizes schema v1 as Bilibili and rejects a YouTube value in the legacy schema', () => {
    const persisted = itemToPersisted(itemFixture());
    const legacy = { ...persisted, schemaVersion: 1, platform: 'bilibili' };

    expect(migratePersistedItem(legacy)).toMatchObject({
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      platform: 'bilibili',
    });
    expect(() => migratePersistedItem({ ...legacy, platform: 'youtube' })).toThrow(DatabaseError);
  });

  it('round-trips a schema v2 YouTube item', () => {
    const persisted = itemToPersisted({
      ...itemFixture(),
      platform: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoId: 'abcdefghijk',
    });

    expect(itemFromPersisted(persisted)).toMatchObject({
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      platform: 'youtube',
      videoId: 'abcdefghijk',
    });
  });

  it('round-trips a schema v2 Douyin item into the current item schema', () => {
    const persisted = itemToPersisted({
      ...itemFixture(),
      platform: 'douyin',
      sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=1',
      canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
      videoId: '7391234567890123456',
    });

    expect(itemFromPersisted(persisted)).toMatchObject({
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      platform: 'douyin',
      videoId: '7391234567890123456',
    });
    expect(() =>
      migratePersistedItem({ ...persisted, schemaVersion: 1, platform: 'douyin' }),
    ).toThrow(DatabaseError);
  });

  it('rejects schema v2 platform and source URL mismatches', () => {
    const persisted = itemToPersisted(itemFixture());

    expect(() =>
      migratePersistedItem({
        ...persisted,
        platform: 'youtube',
      }),
    ).toThrow(DatabaseError);
    expect(() =>
      migratePersistedItem({
        ...persisted,
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/shorts/abcdefghijk',
        canonicalUrl: null,
      }),
    ).toThrow(DatabaseError);
    expect(() =>
      migratePersistedItem({
        ...persisted,
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        canonicalUrl: 'https://www.youtube.com/watch?v=zyxwvutsrqp',
        videoId: 'abcdefghijk',
      }),
    ).toThrow(DatabaseError);
  });

  it('rejects invalid persisted dates', () => {
    const persisted = itemToPersisted(itemFixture());

    expect(() => cardFromPersisted({ ...persisted.fsrsCard, due: 'not-a-date' })).toThrow(
      DatabaseError,
    );
    expect(() => cardFromPersisted({ ...persisted.fsrsCard, last_review: 'not-a-date' })).toThrow(
      DatabaseError,
    );
  });

  it('round-trips a discriminated Text Moment without synthesizing video fields', () => {
    const text: TextLearningItem = {
      id: 'text-item',
      schemaVersion: 2,
      sourceType: 'text',
      title: 'Text title',
      categoryId: null,
      itemType: 'Understand',
      personalNote: '',
      situation: '',
      coreLesson: 'Text takeaway',
      mistakeToAvoid: '',
      recommendedAction: '',
      reason: '',
      recallPrompt: 'Text question?',
      referenceAnswer: 'Text answer.',
      tags: ['text'],
      createdAt: now,
      updatedAt: now,
      fsrsCard: createEmptyCard(now),
      reviewHistory: [],
      suspended: false,
      extractionDiagnostics: [],
    };

    const persisted = itemToPersisted(text);
    expect(persisted).toMatchObject({ sourceType: 'text', title: 'Text title' });
    expect(persisted).not.toHaveProperty('platform');
    expect(persisted).not.toHaveProperty('screenshotId');
    expect(itemFromPersisted(persisted)).toMatchObject({
      sourceType: 'text',
      title: 'Text title',
    });
  });

  it('round-trips an Image Moment without synthesizing platform or video fields', () => {
    const image: ImageLearningItem = {
      id: 'image-item',
      schemaVersion: 2,
      sourceType: 'image',
      title: 'Lineup diagram',
      imageAssetId: 'image-image-item',
      imageMimeType: 'image/webp',
      imageWidth: 1200,
      imageHeight: 800,
      categoryId: null,
      itemType: 'Notice',
      personalNote: '',
      situation: '',
      coreLesson: 'Use the corner as the alignment point.',
      mistakeToAvoid: '',
      recommendedAction: '',
      reason: '',
      recallPrompt: 'Where should the crosshair align?',
      referenceAnswer: 'On the upper corner.',
      tags: ['image'],
      createdAt: now,
      updatedAt: now,
      fsrsCard: createEmptyCard(now),
      reviewHistory: [],
      suspended: false,
      extractionDiagnostics: [],
    };

    const persisted = itemToPersisted(image);
    expect(persisted).toMatchObject({
      sourceType: 'image',
      imageAssetId: 'image-image-item',
      imageMimeType: 'image/webp',
    });
    expect(persisted).not.toHaveProperty('platform');
    expect(persisted).not.toHaveProperty('screenshotId');
    expect(itemFromPersisted(persisted)).toMatchObject({
      ...image,
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      fsrsCard: expect.objectContaining({ due: image.fsrsCard.due }),
    });
  });

  it('preserves a Library Video origin and nullable timestamp while legacy video defaults to capture', () => {
    const manual = itemToPersisted({
      ...itemFixture(),
      sourceType: 'video',
      videoOrigin: 'library',
      screenshotId: null,
      timestampSeconds: null,
      timestampDisplay: null,
    });
    expect(itemFromPersisted(manual)).toMatchObject({
      sourceType: 'video',
      videoOrigin: 'library',
      timestampSeconds: null,
      timestampDisplay: null,
    });

    const legacy = { ...itemToPersisted(itemFixture()) } as Record<string, unknown>;
    delete legacy.videoOrigin;
    expect(itemFromPersisted(legacy)).toMatchObject({ videoOrigin: 'capture' });
  });

  it('rejects inconsistent nullable timestamp pairs for Library Videos at both mapper boundaries', () => {
    expect(() =>
      itemToPersisted({
        ...itemFixture(),
        sourceType: 'video',
        videoOrigin: 'library',
        screenshotId: null,
        timestampSeconds: null,
        timestampDisplay: '01:23',
      }),
    ).toThrow(DatabaseError);

    const persisted = itemToPersisted({
      ...itemFixture(),
      sourceType: 'video',
      videoOrigin: 'library',
      screenshotId: null,
      timestampSeconds: null,
      timestampDisplay: null,
    });
    expect(() =>
      itemFromPersisted({ ...persisted, timestampSeconds: 83, timestampDisplay: null }),
    ).toThrow(DatabaseError);
  });
});
