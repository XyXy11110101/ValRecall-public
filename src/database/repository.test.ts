// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { Rating, State, createEmptyCard, fsrs } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEARNING_ITEM_SCHEMA_VERSION } from '../models/learning-item';
import { itemToPersisted } from './mappers';
import { STORE_NAMES } from './migrations';
import { reviewSchedulingStateFromCard } from './review-state';
import { ValRecallRepository } from './repository';
import { FsrsService } from '../fsrs';
import { LIBRARY_IMAGE_STORED_MAX_BYTES } from '../shared/library-image';
import {
  EXPORT_SCHEMA_VERSION,
  type NewImageLearningItem,
  type NewTextLearningItem,
  type NewVideoLearningItem,
} from './types';

const fixedNow = new Date('2026-07-20T12:00:00.000Z');
const VALID_ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function validPngBlob(): Blob {
  const binary = atob(VALID_ONE_PIXEL_PNG);
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
    type: 'image/png',
  });
}

function stubOnePixelImageDecode(): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 1, height: 1, close: vi.fn() }),
  );
}

function learningItem(overrides: Partial<NewVideoLearningItem> = {}): NewVideoLearningItem {
  return {
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1test',
    videoTitle: 'Angle discipline',
    timestampSeconds: 65,
    timestampDisplay: '01:05',
    itemType: 'Do',
    coreLesson: 'Pre-aim the likely swing.',
    recallPrompt: 'What action should you take in this situation?',
    referenceAnswer: 'Pre-aim before the opponent swings.',
    fsrsCard: createEmptyCard(fixedNow),
    personalNote: 'Remember common head height.',
    tags: ['valorant', 'crosshair'],
    ...overrides,
  };
}

function textLearningItem(overrides: Partial<NewTextLearningItem> = {}): NewTextLearningItem {
  return {
    title: 'Text-only angle note',
    itemType: 'Understand',
    coreLesson: 'Keep one escape route available.',
    recallPrompt: '  What space should remain available?  ',
    referenceAnswer: 'Keep one escape route available.',
    fsrsCard: createEmptyCard(fixedNow),
    tags: ['positioning'],
    ...overrides,
  };
}

function imageLearningItem(overrides: Partial<NewImageLearningItem> = {}): NewImageLearningItem {
  return {
    title: 'Image lineup',
    itemType: 'Notice',
    coreLesson: 'Align with the upper corner.',
    recallPrompt: 'Where should the crosshair align?',
    referenceAnswer: 'On the upper corner.',
    fsrsCard: createEmptyCard(fixedNow),
    tags: ['lineup'],
    ...overrides,
  };
}

describe('ValRecallRepository', () => {
  let repository: ValRecallRepository;
  let sequence: number;

  beforeEach(() => {
    sequence = 0;
    repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'test-valrecall',
      clock: () => new Date(fixedNow),
      idGenerator: () => `generated-${(sequence += 1)}`,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('stores screenshots separately and reconstructs cards and Dates', async () => {
    const screenshot = new Blob(['image-bytes'], { type: 'image/png' });
    const created = await repository.createItem(learningItem(), screenshot);

    expect(created.screenshotId).toBe(`screenshot-${created.id}`);
    const loaded = await repository.getItem(created.id);
    const loadedScreenshot = await repository.getScreenshot(created.screenshotId as string);

    expect(loaded?.createdAt).toBeInstanceOf(Date);
    expect(loaded?.fsrsCard.due).toBeInstanceOf(Date);
    expect(loaded?.fsrsCard.due.toISOString()).toBe(fixedNow.toISOString());
    expect(loadedScreenshot?.type).toBe('image/png');
    expect(loadedScreenshot?.size).toBe(screenshot.size);
  });

  it('persists a current-only captured subtitle without requiring surrounding cues', async () => {
    const currentCue = '这是当前正在播放的字幕';
    const created = await repository.createItem(
      learningItem({
        id: 'current-only-caption',
        subtitleBefore: [],
        subtitleCurrent: [currentCue],
        subtitleAfter: [],
        subtitleCueData: [
          {
            startTime: null,
            endTime: null,
            text: currentCue,
            source: 'visible-overlay',
          },
        ],
      }),
      new Blob(['captured-frame'], { type: 'image/jpeg' }),
    );

    expect(created.subtitleBefore).toEqual([]);
    expect(created.subtitleCurrent).toEqual([currentCue]);
    expect(created.subtitleAfter).toEqual([]);
    await expect(repository.getItem(created.id)).resolves.toMatchObject({
      subtitleBefore: [],
      subtitleCurrent: [currentCue],
      subtitleAfter: [],
      subtitleCueData: [{ text: currentCue, source: 'visible-overlay' }],
    });

    const exported = await repository.exportData();
    expect(exported.items.find((item) => item.id === created.id)).toMatchObject({
      subtitleCurrent: [currentCue],
    });
  });

  it('creates, filters, edits, reviews, suspends, and deletes Text Moments without screenshots', async () => {
    const category = await repository.createCategory('Valorant');
    const created = await repository.createTextItem(textLearningItem({ categoryId: category.id }));

    expect(created).toMatchObject({
      sourceType: 'text',
      title: 'Text-only angle note',
      categoryId: category.id,
      recallPrompt: '  What space should remain available?  ',
      reviewHistory: [],
    });
    expect(await repository.listItems({ categoryId: category.id, source: 'text' })).toHaveLength(1);
    expect(await repository.listItems({ categoryId: category.id, source: 'youtube' })).toHaveLength(
      0,
    );
    expect((await repository.exportData()).screenshots).toEqual([]);

    const futureDue = new Date('2026-07-21T12:00:00.000Z');
    await repository.createTextItem(
      textLearningItem({
        id: 'text-upcoming',
        fsrsCard: createEmptyCard(futureDue),
      }),
    );
    expect(
      (await repository.listUpcomingReviewItems({ after: fixedNow, limit: 10 })).items.map(
        (item) => item.id,
      ),
    ).toContain('text-upcoming');

    const updated = await repository.updateItem(created.id, { title: 'Edited text title' });
    expect(updated.sourceType).toBe('text');
    if (updated.sourceType !== 'text') throw new Error('Expected a Text Moment.');
    expect(updated.title).toBe('Edited text title');

    const fsrsService = new FsrsService(repository, { clock: () => new Date(fixedNow) });
    await fsrsService.reviewItem(created.id, Rating.Good, fixedNow);
    expect(await repository.listReviews(created.id)).toHaveLength(1);

    await repository.updateItem(created.id, { suspended: true });
    expect(await repository.listDueItems(fixedNow, category.id)).toEqual([]);
    await repository.deleteItem(created.id);
    expect(await repository.getItem(created.id)).toBeUndefined();
    expect((await repository.exportData()).screenshots).toEqual([]);
  });

  it('defaults Text Moments to Uncategorized, validates required fields, and round-trips exports', async () => {
    await expect(
      repository.createTextItem(textLearningItem({ recallPrompt: '' })),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });

    const text = await repository.createTextItem(textLearningItem({ id: 'text-round-trip' }));
    await repository.createItem(
      learningItem({ id: 'video-round-trip' }),
      new Blob(['video-screenshot'], { type: 'image/png' }),
    );
    expect(text.categoryId).toBeNull();

    const exported = await repository.exportData();
    expect(exported.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(exported.items.map((item) => item.sourceType).sort()).toEqual(['text', 'video']);
    expect(exported.screenshots).toHaveLength(1);

    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'test-valrecall-text-import',
      clock: () => new Date(fixedNow),
    });
    await importedRepository.importData(exported, 'replace');
    const restored = await importedRepository.getItem(text.id);
    expect(restored).toMatchObject({
      sourceType: 'text',
      title: 'Text-only angle note',
      categoryId: null,
    });
    expect((await importedRepository.exportData()).screenshots).toHaveLength(1);
  });

  it('creates, schedules, filters, exports, imports, and deletes Image Moments atomically', async () => {
    const category = await repository.createCategory('Lineups');
    const imageBlob = validPngBlob();
    const created = await repository.createImageItem(
      imageLearningItem({ categoryId: category.id }),
      { blob: imageBlob, width: 1, height: 1 },
    );

    expect(created).toMatchObject({
      sourceType: 'image',
      categoryId: category.id,
      imageMimeType: 'image/png',
      imageWidth: 1,
      imageHeight: 1,
    });
    await expect(repository.getImageAsset(created.imageAssetId)).resolves.toMatchObject({
      size: imageBlob.size,
      type: 'image/png',
    });
    await expect(
      repository.listItems({ categoryId: category.id, source: 'image' }),
    ).resolves.toHaveLength(1);
    await expect(repository.listDueItems(fixedNow, category.id)).resolves.toMatchObject([
      { id: created.id, sourceType: 'image' },
    ]);

    const service = new FsrsService(repository, { clock: () => new Date(fixedNow) });
    await service.reviewItem(created.id, Rating.Good, fixedNow);
    await expect(repository.listReviews(created.id)).resolves.toHaveLength(1);

    const exported = await repository.exportData();
    expect(exported.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(exported.screenshots).toHaveLength(1);
    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'image-import',
      clock: () => new Date(fixedNow),
    });
    stubOnePixelImageDecode();
    await importedRepository.importData(exported, 'replace');
    await expect(importedRepository.getItem(created.id)).resolves.toMatchObject({
      sourceType: 'image',
      imageAssetId: created.imageAssetId,
    });
    await expect(importedRepository.getImageAsset(created.imageAssetId)).resolves.toBeInstanceOf(
      Blob,
    );

    await repository.deleteItem(created.id);
    await expect(repository.getImageAsset(created.imageAssetId)).resolves.toBeUndefined();
  });

  it('rejects invalid Image assets and rolls back an asset when item creation conflicts', async () => {
    await expect(
      repository.createImageItem(imageLearningItem(), {
        blob: new Blob(['svg'], { type: 'image/svg+xml' }),
        width: 100,
        height: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
    expect((await repository.exportData()).screenshots).toEqual([]);

    await repository.createTextItem(textLearningItem({ id: 'same-id' }));
    await expect(
      repository.createImageItem(imageLearningItem({ id: 'same-id' }), {
        blob: new Blob(['image'], { type: 'image/png' }),
        width: 100,
        height: 100,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.getImageAsset('image-same-id')).resolves.toBeUndefined();
  });

  it('does not overwrite a pre-existing binary when an Image Moment asset key collides', async () => {
    const database = await repository.open();
    const original = new Blob(['existing-local-bytes'], { type: 'image/png' });
    const transaction = database.transaction(STORE_NAMES.screenshots, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAMES.screenshots).add({
      id: 'image-asset-collision',
      blob: original,
      createdAt: fixedNow.toISOString(),
    });
    await done;

    await expect(
      repository.createImageItem(imageLearningItem({ id: 'asset-collision' }), {
        blob: validPngBlob(),
        width: 1,
        height: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const preserved = await repository.getImageAsset('image-asset-collision');
    expect(await preserved?.text()).toBe('existing-local-bytes');
    await expect(repository.getItem('asset-collision')).resolves.toBeUndefined();
  });

  it('rejects shared schema-6 asset ownership and preserves shared legacy bytes on delete', async () => {
    const first = await repository.createImageItem(imageLearningItem({ id: 'first-image' }), {
      blob: validPngBlob(),
      width: 1,
      height: 1,
    });
    const second = await repository.createImageItem(imageLearningItem({ id: 'second-image' }), {
      blob: validPngBlob(),
      width: 1,
      height: 1,
    });
    const sharedBackup = structuredClone(await repository.exportData());
    const exportedImages = sharedBackup.items.filter((item) => item.sourceType === 'image');
    if (exportedImages.length !== 2) throw new Error('Expected two exported Image Moments.');
    exportedImages[1]!.imageAssetId = exportedImages[0]!.imageAssetId;

    await expect(repository.importData(sharedBackup, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });

    const database = await repository.open();
    const transaction = database.transaction(STORE_NAMES.items, 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAMES.items).put(
      itemToPersisted({
        ...second,
        imageAssetId: first.imageAssetId,
      }),
    );
    await done;
    await repository.deleteItem(first.id);
    await expect(repository.getImageAsset(first.imageAssetId)).resolves.toBeInstanceOf(Blob);
  });

  it('filters schema-6 orphan assets and rejects malformed, oversized, or mismatched images', async () => {
    const image = await repository.createImageItem(imageLearningItem({ id: 'import-image' }), {
      blob: validPngBlob(),
      width: 1,
      height: 1,
    });
    const clean = structuredClone(await repository.exportData());
    clean.screenshots.push({
      id: 'orphan-image',
      mimeType: 'image/png',
      createdAt: fixedNow.toISOString(),
      dataBase64: btoa('not an image'),
    });
    stubOnePixelImageDecode();
    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'schema-6-orphan-filter',
      clock: () => new Date(fixedNow),
    });
    await expect(importedRepository.importData(clean, 'replace')).resolves.toMatchObject({
      items: 1,
      screenshots: 1,
    });
    expect((await importedRepository.exportData()).screenshots.map((asset) => asset.id)).toEqual([
      image.imageAssetId,
    ]);

    const malformed = structuredClone(await repository.exportData());
    malformed.screenshots[0]!.dataBase64 = btoa('not a png');
    await expect(repository.importData(malformed, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });

    const mismatched = structuredClone(await repository.exportData());
    const imageItem = mismatched.items.find((item) => item.sourceType === 'image');
    if (!imageItem || imageItem.sourceType !== 'image') {
      throw new Error('Expected an exported Image Moment.');
    }
    imageItem.imageWidth = 2;
    await expect(repository.importData(mismatched, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });

    const oversized = structuredClone(await repository.exportData());
    oversized.screenshots[0]!.dataBase64 = 'A'.repeat(
      Math.ceil(LIBRARY_IMAGE_STORED_MAX_BYTES / 3) * 4 + 1,
    );
    await expect(repository.importData(oversized, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });

  it('rejects a schema-6 merge that would overwrite another Moment asset', async () => {
    const existingBytes = new Blob([await validPngBlob().arrayBuffer(), new Uint8Array([0])], {
      type: 'image/png',
    });
    const existing = await repository.createImageItem(imageLearningItem({ id: 'existing-image' }), {
      blob: existingBytes,
      width: 1,
      height: 1,
    });
    const incomingRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'incoming-image-merge',
      clock: () => new Date(fixedNow),
    });
    await incomingRepository.createImageItem(imageLearningItem({ id: 'incoming-image' }), {
      blob: validPngBlob(),
      width: 1,
      height: 1,
    });
    const incoming = structuredClone(await incomingRepository.exportData());
    const incomingImage = incoming.items.find((item) => item.sourceType === 'image');
    if (!incomingImage || incomingImage.sourceType !== 'image' || !incoming.screenshots[0]) {
      throw new Error('Expected an incoming Image Moment and asset.');
    }
    incomingImage.imageAssetId = existing.imageAssetId;
    incoming.screenshots[0].id = existing.imageAssetId;
    stubOnePixelImageDecode();

    await expect(repository.importData(incoming, 'merge')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    await expect(repository.getItem('incoming-image')).resolves.toBeUndefined();
    await expect(repository.getImageAsset(existing.imageAssetId)).resolves.toMatchObject({
      size: existingBytes.size,
    });
  });

  it('creates manual YouTube, Bilibili, and Douyin videos without screenshots or extraction data', async () => {
    const definitions = [
      {
        id: 'manual-youtube',
        platform: 'youtube' as const,
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
        timestampSeconds: null,
        timestampDisplay: null,
      },
      {
        id: 'manual-bilibili',
        platform: 'bilibili' as const,
        sourceUrl: 'https://www.bilibili.com/video/BV1test',
        canonicalUrl: 'https://www.bilibili.com/video/BV1test',
        videoId: 'BV1test',
        timestampSeconds: 83,
        timestampDisplay: '01:23',
      },
      {
        id: 'manual-douyin',
        platform: 'douyin' as const,
        sourceUrl: 'https://www.douyin.com/video/7391234567890123456',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
        videoId: '7391234567890123456',
        timestampSeconds: null,
        timestampDisplay: null,
      },
    ];

    for (const definition of definitions) {
      const created = await repository.createManualVideoItem(
        learningItem({ ...definition, videoTitle: definition.id }),
      );
      expect(created).toMatchObject({
        sourceType: 'video',
        videoOrigin: 'library',
        screenshotId: null,
        extractionDiagnostics: [],
        subtitleCueData: [],
      });
    }
    expect((await repository.exportData()).screenshots).toEqual([]);
    await expect(repository.listItems({ source: 'youtube' })).resolves.toMatchObject([
      { id: 'manual-youtube' },
    ]);
    await expect(
      repository.updateItem('manual-youtube', { coreLesson: 'Updated without a timestamp.' }),
    ).resolves.toMatchObject({
      id: 'manual-youtube',
      timestampSeconds: null,
      coreLesson: 'Updated without a timestamp.',
    });

    const exported = await repository.exportData();
    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'manual-video-import',
      clock: () => new Date(fixedNow),
    });
    await expect(importedRepository.importData(exported, 'replace')).resolves.toMatchObject({
      items: 3,
      screenshots: 0,
    });
    await expect(importedRepository.getItem('manual-youtube')).resolves.toMatchObject({
      videoOrigin: 'library',
      timestampSeconds: null,
      screenshotId: null,
    });
  });

  it('imports schema 5 video/text backups and rejects schema 6 Image Moments without assets', async () => {
    await repository.createTextItem(textLearningItem({ id: 'old-text' }));
    await repository.createItem(
      learningItem({ id: 'old-video' }),
      new Blob(['screenshot'], { type: 'image/png' }),
    );
    const oldExport = structuredClone(await repository.exportData());
    oldExport.schemaVersion = 5;
    Reflect.deleteProperty(oldExport, 'notes');
    Reflect.deleteProperty(oldExport, 'intakeReceipts');
    for (const item of oldExport.items) {
      if (item.sourceType === 'video') delete (item as { videoOrigin?: string }).videoOrigin;
    }
    await expect(repository.importData(oldExport, 'replace')).resolves.toMatchObject({ items: 2 });

    const image = await repository.createImageItem(imageLearningItem({ id: 'missing-asset' }), {
      blob: new Blob(['image'], { type: 'image/png' }),
      width: 100,
      height: 100,
    });
    const broken = structuredClone(await repository.exportData());
    broken.screenshots = broken.screenshots.filter((asset) => asset.id !== image.imageAssetId);
    await expect(repository.importData(broken, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });

  it('rejects new items without a screenshot while allowing an empty legacy answer', async () => {
    await expect(
      repository.createItem(learningItem({ id: 'missing-image' }), undefined as unknown as Blob),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
    await expect(
      repository.createItem(
        learningItem({
          id: 'mismatched-video',
          platform: 'youtube',
          sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
          canonicalUrl: 'https://www.youtube.com/watch?v=zyxwvutsrqp',
          videoId: 'abcdefghijk',
        }),
        new Blob(['image']),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });

    const item = await repository.createItem(
      learningItem({ id: 'validated-item' }),
      new Blob(['image']),
    );
    const updated = await repository.updateItem(item.id, { referenceAnswer: '' });
    expect(updated.coreLesson).toBe(item.coreLesson);
    expect(updated.recallPrompt).toBe(item.recallPrompt);
    expect(updated.referenceAnswer).toBe('');

    const exported = await repository.exportData();
    await repository.clearAllData();
    await expect(repository.importData(exported, 'replace')).resolves.toMatchObject({ items: 1 });
    await expect(repository.getItem(item.id)).resolves.toMatchObject({
      coreLesson: item.coreLesson,
      recallPrompt: item.recallPrompt,
      referenceAnswer: '',
    });
  });

  it('round-trips a distinct whitespace-sensitive legacy Reference answer exactly', async () => {
    const exactLegacyAnswer = '  Earlier wording stays exact.\nKeep this second line.  ';
    const created = await repository.createTextItem(
      textLearningItem({
        id: 'legacy-answer-round-trip',
        coreLesson: 'The canonical Key takeaway.',
        referenceAnswer: exactLegacyAnswer,
      }),
    );

    const exported = await repository.exportData();
    expect(exported.items.find((item) => item.id === created.id)?.referenceAnswer).toBe(
      exactLegacyAnswer,
    );

    const importedRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'test-valrecall-legacy-answer-import',
      clock: () => new Date(fixedNow),
    });
    await expect(importedRepository.importData(exported, 'replace')).resolves.toMatchObject({
      items: 1,
    });
    await expect(importedRepository.getItem(created.id)).resolves.toMatchObject({
      coreLesson: 'The canonical Key takeaway.',
      referenceAnswer: exactLegacyAnswer,
    });
  });

  it('selects only unsuspended due items and supports library search', async () => {
    await repository.createItem(
      learningItem({ id: 'due', videoTitle: 'Due item' }),
      new Blob(['due']),
    );
    await repository.createItem(
      learningItem({ id: 'suspended', videoTitle: 'Suspended', suspended: true }),
      new Blob(['suspended']),
    );
    await repository.createItem(
      learningItem({
        id: 'future',
        videoTitle: 'Future lesson',
        fsrsCard: {
          ...(await repository.getItem('due'))!.fsrsCard,
          due: new Date('2026-07-21T12:00:00.000Z'),
        },
      }),
      new Blob(['future']),
    );
    await repository.createItem(
      learningItem({
        id: 'youtube',
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
        videoTitle: 'YouTube lesson',
      }),
      new Blob(['youtube']),
    );

    const dueItems = await repository.listDueItems();
    expect(dueItems.map((item) => item.id)).toEqual(expect.arrayContaining(['due', 'youtube']));
    expect(dueItems).toHaveLength(2);
    await expect(repository.listItems({ query: 'future' })).resolves.toMatchObject([
      { id: 'future' },
    ]);
    await expect(repository.listItems({ status: 'suspended' })).resolves.toMatchObject([
      { id: 'suspended' },
    ]);
    await expect(repository.listItems({ platform: 'youtube' })).resolves.toMatchObject([
      { id: 'youtube', platform: 'youtube' },
    ]);
  });

  it('uses the exact persisted due millisecond boundary', async () => {
    const before = new Date(fixedNow.getTime() - 1);
    const equal = new Date(fixedNow);
    const after = new Date(fixedNow.getTime() + 1);
    await repository.createItem(
      learningItem({ id: 'overdue-ms', fsrsCard: createEmptyCard(before) }),
      new Blob(['overdue']),
    );
    await repository.createItem(
      learningItem({ id: 'equal-ms', fsrsCard: createEmptyCard(equal) }),
      new Blob(['equal']),
    );
    await repository.createItem(
      learningItem({ id: 'future-ms', fsrsCard: createEmptyCard(after) }),
      new Blob(['future']),
    );
    await repository.createItem(
      learningItem({
        id: 'suspended-ms',
        fsrsCard: createEmptyCard(before),
        suspended: true,
      }),
      new Blob(['suspended']),
    );

    await expect(repository.listDueItems(fixedNow)).resolves.toMatchObject([
      { id: 'overdue-ms' },
      { id: 'equal-ms' },
    ]);
    await expect(repository.listItems({ status: 'future', now: fixedNow })).resolves.toMatchObject([
      { id: 'future-ms' },
    ]);
  });

  it('reads upcoming reviews through only the due-indexed item store in stable order', async () => {
    const dueTimes = [
      new Date('2026-07-20T12:10:00.000Z'),
      new Date('2026-07-20T12:10:00.000Z'),
      new Date('2026-07-20T13:00:00.000Z'),
      new Date('2026-07-20T14:00:00.000Z'),
    ];
    const definitions = [
      { id: 'learning', state: State.Learning, due: dueTimes[0]! },
      { id: 'review', state: State.Review, due: dueTimes[1]! },
      { id: 'relearning', state: State.Relearning, due: dueTimes[2]! },
      { id: 'suspended-future', state: State.Review, due: dueTimes[3]!, suspended: true },
    ];
    for (const definition of definitions) {
      const card = createEmptyCard(definition.due);
      card.state = definition.state;
      await repository.createItem(
        learningItem({
          id: definition.id,
          fsrsCard: card,
          suspended: definition.suspended ?? false,
        }),
        new Blob([definition.id]),
      );
    }

    const database = await repository.open();
    const transactionSpy = vi.spyOn(database, 'transaction');
    const listAllSpy = vi.spyOn(repository, 'listItems');
    const first = await repository.listUpcomingReviewItems({
      after: fixedNow,
      before: new Date('2026-07-20T15:00:00.000Z'),
      limit: 2,
    });

    expect(first.items.map((item) => [item.id, item.fsrsCard.state])).toEqual([
      ['learning', State.Learning],
      ['review', State.Review],
    ]);
    expect(first.items.every((item) => item.reviewHistory.length === 0)).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({
      due: dueTimes[1]!.toISOString(),
      itemId: 'review',
    });
    expect(listAllSpy).not.toHaveBeenCalled();
    expect(transactionSpy).toHaveBeenLastCalledWith(STORE_NAMES.items, 'readonly');

    const second = await repository.listUpcomingReviewItems({
      after: fixedNow,
      before: new Date('2026-07-20T15:00:00.000Z'),
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual(['relearning']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it('applies strict upcoming bounds/limits and reports encountered invalid records', async () => {
    const insideDue = new Date('2026-07-20T12:10:00.123Z');
    const boundaryDue = new Date('2026-07-20T13:00:00.000Z');
    const inside = await repository.createItem(
      learningItem({ id: 'inside-range', fsrsCard: createEmptyCard(insideDue) }),
      new Blob(['inside']),
    );
    await repository.createItem(
      learningItem({ id: 'at-before-boundary', fsrsCard: createEmptyCard(boundaryDue) }),
      new Blob(['boundary']),
    );
    const database = await repository.open();
    const invalid = itemToPersisted({ ...inside, id: 'invalid-due' });
    invalid.fsrsCard.due = 'not-a-date';
    const transaction = database.transaction(STORE_NAMES.items, 'readwrite');
    transaction.objectStore(STORE_NAMES.items).put(invalid);
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error), { once: true });
    });

    const page = await repository.listUpcomingReviewItems({
      after: fixedNow,
      before: boundaryDue,
      limit: 10,
    });
    expect(page.items.map((item) => item.id)).toEqual(['inside-range']);
    expect(page.items[0]?.fsrsCard.due.toISOString()).toBe(insideDue.toISOString());
    expect(page.invalidCount).toBe(0);

    const unbounded = await repository.listUpcomingReviewItems({
      after: fixedNow,
      limit: 10,
    });
    expect(unbounded.invalidCount).toBe(1);
    await expect(
      repository.listUpcomingReviewItems({ after: fixedNow, limit: 101 }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
  });

  it('omits history-store reads on operational lists while preserving all filters and full-history defaults', async () => {
    const selected = await repository.createTextItem(textLearningItem({ id: 'selected-history' }));
    await repository.createTextItem(textLearningItem({ id: 'another-item', title: 'Other' }));
    const scheduler = new FsrsService(repository, { clock: () => new Date(fixedNow) });
    await scheduler.reviewItem(selected.id, Rating.Good);
    const full = await repository.listItems({ query: 'Text-only', source: 'text' });
    expect(full[0]?.reviewHistory).toHaveLength(1);
    const database = await repository.open();
    const transactionSpy = vi.spyOn(database, 'transaction');
    const lean = await repository.listItems({
      query: 'Text-only',
      source: 'text',
      includeReviewHistory: false,
    });
    expect(transactionSpy).toHaveBeenCalledExactlyOnceWith([STORE_NAMES.items], 'readonly');
    expect(lean).toEqual(full.map((item) => ({ ...item, reviewHistory: [] })));
    transactionSpy.mockRestore();
    expect((await repository.getItem(selected.id))?.reviewHistory).toHaveLength(1);
    expect(
      (await repository.listItems()).find((item) => item.id === selected.id)?.reviewHistory,
    ).toHaveLength(1);
  });

  it('counts due/recent/review summaries without using listItems', async () => {
    const reviewedAt = new Date('2026-07-20T10:00:00.000Z');
    const due = await repository.createItem(
      learningItem({ id: 'summary-due', updatedAt: new Date('2026-07-20T11:00:00.000Z') }),
      new Blob(['due']),
    );
    await repository.createItem(
      learningItem({
        id: 'summary-future',
        updatedAt: new Date('2026-07-20T11:30:00.000Z'),
        fsrsCard: createEmptyCard(new Date('2026-07-21T12:00:00.000Z')),
      }),
      new Blob(['future']),
    );
    const next = fsrs().next(due.fsrsCard, reviewedAt, Rating.Good);
    await repository.saveReview({
      id: 'summary-review',
      itemId: due.id,
      expectedState: reviewSchedulingStateFromCard(due.fsrsCard),
      card: next.card,
      log: next.log,
    });
    const listAllSpy = vi.spyOn(repository, 'listItems');

    await expect(repository.countDueReviewItems(fixedNow)).resolves.toBe(1);
    await expect(repository.listRecentItems(1)).resolves.toMatchObject([
      { id: 'summary-future', reviewHistory: [] },
    ]);
    await expect(
      repository.countReviewsBetween(
        new Date('2026-07-20T00:00:00.000Z'),
        new Date('2026-07-21T00:00:00.000Z'),
      ),
    ).resolves.toBe(1);
    expect(listAllSpy).not.toHaveBeenCalled();
  });

  it('filters All, Bilibili, YouTube and Douyin without cross-platform leakage', async () => {
    await repository.createItem(
      learningItem({ id: 'platform-bilibili', videoTitle: 'Bilibili filter lesson' }),
      new Blob(['bilibili']),
    );
    await repository.createItem(
      learningItem({
        id: 'platform-youtube',
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
        videoTitle: 'YouTube filter lesson',
      }),
      new Blob(['youtube']),
    );

    await expect(repository.listItems({ platform: 'douyin' })).resolves.toEqual([]);
    await repository.createItem(
      learningItem({
        id: 'platform-douyin',
        platform: 'douyin',
        sourceUrl: 'https://www.douyin.com/video/7391234567890123456',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
        videoId: '7391234567890123456',
        videoTitle: 'Douyin filter lesson',
      }),
      new Blob(['douyin']),
    );

    await expect(repository.listItems()).resolves.toHaveLength(3);
    await expect(repository.listItems({ platform: 'bilibili' })).resolves.toMatchObject([
      { id: 'platform-bilibili', platform: 'bilibili' },
    ]);
    await expect(repository.listItems({ platform: 'youtube' })).resolves.toMatchObject([
      { id: 'platform-youtube', platform: 'youtube' },
    ]);
    await expect(repository.listItems({ platform: 'douyin' })).resolves.toMatchObject([
      { id: 'platform-douyin', platform: 'douyin' },
    ]);
  });

  it('updates the card and appends a separate review record atomically', async () => {
    const item = await repository.createItem(
      learningItem({ id: 'review-me' }),
      new Blob(['review']),
    );
    const result = fsrs().next(item.fsrsCard, fixedNow, Rating.Good);
    const expectedState = reviewSchedulingStateFromCard(item.fsrsCard);

    const saved = await repository.saveReview({
      id: 'review-1',
      itemId: item.id,
      expectedState: { ...expectedState, due: item.fsrsCard.due.toISOString() },
      card: result.card,
      log: result.log,
    });
    const reloaded = await repository.getItem(item.id);

    expect(saved.log.rating).toBe(Rating.Good);
    expect(reloaded?.fsrsCard.due.toISOString()).toBe(result.card.due.toISOString());
    expect(reloaded?.reviewHistory).toHaveLength(1);
    expect(reloaded?.reviewHistory[0]?.log.review).toBeInstanceOf(Date);
  });

  it('accepts content-only edits but rejects genuine scheduling-state changes atomically', async () => {
    const contentEdited = await repository.createItem(
      learningItem({ id: 'content-edit-before-review' }),
      new Blob(['content']),
    );
    const contentExpected = reviewSchedulingStateFromCard(contentEdited.fsrsCard);
    const contentResult = fsrs().next(contentEdited.fsrsCard, fixedNow, Rating.Good);
    await repository.updateItem(contentEdited.id, { videoTitle: 'Edited title only' });

    await expect(
      repository.saveReview({
        id: 'content-edit-review',
        itemId: contentEdited.id,
        expectedState: contentExpected,
        card: contentResult.card,
        log: contentResult.log,
      }),
    ).resolves.toMatchObject({ itemId: contentEdited.id });

    const dueChanged = await repository.createItem(
      learningItem({ id: 'one-millisecond-stale' }),
      new Blob(['due']),
    );
    const dueExpected = reviewSchedulingStateFromCard(dueChanged.fsrsCard);
    const dueResult = fsrs().next(dueChanged.fsrsCard, fixedNow, Rating.Good);
    await repository.updateItem(dueChanged.id, {
      fsrsCard: {
        ...dueChanged.fsrsCard,
        due: new Date(dueChanged.fsrsCard.due.getTime() + 1),
      },
    });

    await expect(
      repository.saveReview({
        id: 'must-not-save-one-millisecond-stale',
        itemId: dueChanged.id,
        expectedState: dueExpected,
        card: dueResult.card,
        log: dueResult.log,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.listReviews(dueChanged.id)).resolves.toEqual([]);

    const replaced = await repository.createItem(
      learningItem({ id: 'same-due-replaced-card' }),
      new Blob(['replaced']),
    );
    const replacedExpected = reviewSchedulingStateFromCard(replaced.fsrsCard);
    const replacedResult = fsrs().next(replaced.fsrsCard, fixedNow, Rating.Good);
    await repository.updateItem(replaced.id, {
      fsrsCard: { ...replaced.fsrsCard, reps: replaced.fsrsCard.reps + 1 },
    });

    await expect(
      repository.saveReview({
        id: 'must-not-save-replaced-card',
        itemId: replaced.id,
        expectedState: replacedExpected,
        card: replacedResult.card,
        log: replacedResult.log,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.listReviews(replaced.id)).resolves.toEqual([]);
  });

  it('rejects a review for a deleted Moment without writing history', async () => {
    const item = await repository.createItem(
      learningItem({ id: 'deleted-before-review' }),
      new Blob(['deleted']),
    );
    const expectedState = reviewSchedulingStateFromCard(item.fsrsCard);
    const result = fsrs().next(item.fsrsCard, fixedNow, Rating.Good);
    await repository.deleteItem(item.id);

    await expect(
      repository.saveReview({
        id: 'must-not-save-deleted',
        itemId: item.id,
        expectedState,
        card: result.card,
        log: result.log,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(repository.listReviews(item.id)).resolves.toEqual([]);
  });

  it('rejects a stale or newly suspended review without changing card/history data', async () => {
    const suspended = await repository.createItem(
      learningItem({ id: 'suspended-during-session' }),
      new Blob(['suspended']),
    );
    const suspendedResult = fsrs().next(suspended.fsrsCard, fixedNow, Rating.Good);
    await repository.updateItem(suspended.id, { suspended: true });

    await expect(
      repository.saveReview({
        id: 'must-not-save-suspended',
        itemId: suspended.id,
        expectedState: reviewSchedulingStateFromCard(suspended.fsrsCard),
        card: suspendedResult.card,
        log: suspendedResult.log,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.listReviews(suspended.id)).resolves.toEqual([]);

    const stale = await repository.createItem(
      learningItem({ id: 'stale-session-item' }),
      new Blob(['stale']),
    );
    const first = fsrs().next(stale.fsrsCard, fixedNow, Rating.Hard);
    await repository.saveReview({
      id: 'first-authoritative-review',
      itemId: stale.id,
      expectedState: reviewSchedulingStateFromCard(stale.fsrsCard),
      card: first.card,
      log: first.log,
    });

    await expect(
      repository.saveReview({
        id: 'stale-duplicate-review',
        itemId: stale.id,
        expectedState: reviewSchedulingStateFromCard(stale.fsrsCard),
        card: first.card,
        log: first.log,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(repository.listReviews(stale.id)).resolves.toHaveLength(1);
  });

  it('normalizes a raw legacy item when persisting a review', async () => {
    const item = await repository.createItem(
      learningItem({ id: 'legacy-review' }),
      new Blob(['review']),
    );
    const persisted = (await repository.exportData()).items[0];
    if (!persisted) throw new Error('Expected a persisted learning item.');
    const database = await repository.open();
    const transaction = database.transaction('items', 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore('items').put({
      ...persisted,
      schemaVersion: 1,
      platform: 'bilibili',
      fsrsCard: {
        ...persisted.fsrsCard,
        due: new Date(persisted.fsrsCard.due),
      },
    });
    await done;

    const result = fsrs().next(item.fsrsCard, fixedNow, Rating.Good);
    await repository.saveReview({
      itemId: item.id,
      expectedState: reviewSchedulingStateFromCard(item.fsrsCard),
      card: result.card,
      log: result.log,
    });

    const exported = await repository.exportData();
    expect(exported.items[0]).toMatchObject({
      id: 'legacy-review',
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      platform: 'bilibili',
    });
    await expect(repository.listReviews(item.id)).resolves.toHaveLength(1);
  });

  it('exports, clears and imports JSON-safe learning data', async () => {
    await repository.createItem(
      learningItem({ id: 'exported' }),
      new Blob(['export-image'], { type: 'image/png' }),
    );
    await repository.setMeta('runtime.pendingCapture', { draftId: 'transient' });
    const exported = await repository.exportData();

    expect(exported.application).toBe('ValRecall');
    expect(exported.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(exported.items[0]?.createdAt).toBe(fixedNow.toISOString());
    expect(exported.items[0]?.fsrsCard.due).toBe(fixedNow.toISOString());
    expect(exported.items[0]?.personalNote).toBe('Remember common head height.');
    expect(exported.screenshots[0]).toMatchObject({
      id: 'screenshot-exported',
      mimeType: 'image/png',
    });
    expect(typeof exported.screenshots[0]?.dataBase64).toBe('string');
    expect(exported.meta.some((record) => record.key.startsWith('runtime.'))).toBe(false);

    await repository.clearAll();
    await expect(repository.listItems()).resolves.toEqual([]);

    await expect(repository.importData(exported, 'replace')).resolves.toEqual({
      items: 1,
      reviews: 0,
      screenshots: 1,
      tasks: 0,
      taskCompletions: 0,
      categories: 0,
      notes: 0,
      intakeReceipts: 0,
    });
    const restored = await repository.getItem('exported');
    expect(restored?.fsrsCard.due).toBeInstanceOf(Date);
    expect(restored?.personalNote).toBe('Remember common head height.');
    const screenshot = await repository.getScreenshot('screenshot-exported');
    expect(screenshot).toMatchObject({ type: 'image/png', size: 12 });
  });

  it('imports a schema v1 Bilibili export into the current item schema', async () => {
    await repository.createItem(
      learningItem({ id: 'legacy-export' }),
      new Blob(['legacy-image'], { type: 'image/png' }),
    );
    const current = await repository.exportData();
    const legacyExport = {
      ...current,
      schemaVersion: 1,
      items: current.items.map((item) => ({
        ...item,
        schemaVersion: 1,
        platform: 'bilibili',
      })),
    };

    await repository.clearAll();
    Reflect.deleteProperty(legacyExport, 'notes');
    Reflect.deleteProperty(legacyExport, 'intakeReceipts');
    await expect(repository.importData(legacyExport, 'replace')).resolves.toMatchObject({
      items: 1,
    });
    await expect(repository.getItem('legacy-export')).resolves.toMatchObject({
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      platform: 'bilibili',
      personalNote: 'Remember common head height.',
    });
  });

  it('rejects YouTube data labelled as an export schema v1 backup', async () => {
    await repository.createItem(
      learningItem({
        id: 'youtube-export',
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
        videoId: 'abcdefghijk',
      }),
      new Blob(['youtube-image'], { type: 'image/png' }),
    );
    const current = await repository.exportData();

    await expect(repository.importData({ ...current, schemaVersion: 1 })).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });

  it('round-trips Douyin items in the current export schema and preserves v1 as Bilibili-only', async () => {
    await repository.createItem(
      learningItem({
        id: 'douyin-export',
        platform: 'douyin',
        sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=1',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
        videoId: '7391234567890123456',
        videoTitle: 'Douyin lesson',
      }),
      new Blob(['douyin-image'], { type: 'image/png' }),
    );
    const current = await repository.exportData();

    expect(current).toMatchObject({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      items: [
        expect.objectContaining({
          schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
          platform: 'douyin',
          videoId: '7391234567890123456',
        }),
      ],
    });
    await expect(repository.importData(current, 'replace')).resolves.toMatchObject({ items: 1 });
    await expect(repository.getItem('douyin-export')).resolves.toMatchObject({
      platform: 'douyin',
    });
    await expect(repository.importData({ ...current, schemaVersion: 1 })).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });

  it('rejects malformed imports before changing existing data', async () => {
    await repository.createItem(learningItem({ id: 'keep-me' }), new Blob(['keep']));

    await expect(
      repository.importData({
        application: 'ValRecall',
        schemaVersion: 2,
        exportedAt: fixedNow.toISOString(),
        items: [{ id: 'unsafe', fsrsCard: { due: 'invalid' } }],
        reviews: [],
        screenshots: [],
        meta: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });

    await expect(repository.getItem('keep-me')).resolves.toMatchObject({ id: 'keep-me' });
  });

  it('rejects duplicate records and broken import references', async () => {
    await repository.createItem(learningItem({ id: 'graph-item' }), new Blob(['graph']));
    const exported = await repository.exportData();
    const duplicate = structuredClone(exported);
    const firstItem = duplicate.items[0];
    if (!firstItem) throw new Error('Expected an exported learning item.');
    duplicate.items.push(structuredClone(firstItem));

    await expect(repository.importData(duplicate)).rejects.toMatchObject({ code: 'INVALID_DATA' });

    const brokenReference = structuredClone(exported);
    if (brokenReference.items[0]?.sourceType === 'video') {
      brokenReference.items[0].screenshotId = 'missing-screenshot';
    }
    await expect(repository.importData(brokenReference)).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
  });

  it('creates stable Categories, enforces unique names, and renames without changing IDs', async () => {
    const tactics = await repository.createCategory('  Tactics   Review  ');

    expect(tactics).toMatchObject({
      id: 'category-generated-1',
      schemaVersion: 1,
      name: 'Tactics Review',
    });
    await expect(repository.createCategory('tactics review')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const renamed = await repository.renameCategory(tactics.id, 'Decision making');
    expect(renamed.id).toBe(tactics.id);
    expect(renamed.name).toBe('Decision making');
    await expect(repository.listCategories()).resolves.toEqual([
      expect.objectContaining({ id: tactics.id, name: 'Decision making' }),
    ]);
  });

  it('filters due Moments and builds Category counts without changing scheduling semantics', async () => {
    const tactics = await repository.createCategory('Tactics');
    const utility = await repository.createCategory('Utility');
    await repository.createItem(
      learningItem({ id: 'tactics-due', categoryId: tactics.id }),
      new Blob(['tactics-due']),
    );
    await repository.createItem(
      learningItem({
        id: 'tactics-future',
        categoryId: tactics.id,
        fsrsCard: createEmptyCard(new Date('2026-07-25T12:00:00.000Z')),
      }),
      new Blob(['tactics-future']),
    );
    await repository.createItem(
      learningItem({ id: 'tactics-suspended', categoryId: tactics.id, suspended: true }),
      new Blob(['tactics-suspended']),
    );
    await repository.createItem(
      learningItem({ id: 'uncategorized-due' }),
      new Blob(['uncategorized']),
    );

    await expect(repository.listDueItems(fixedNow, tactics.id)).resolves.toMatchObject([
      { id: 'tactics-due', categoryId: tactics.id },
    ]);
    await expect(repository.countDueReviewItems(fixedNow, tactics.id)).resolves.toBe(1);
    await expect(repository.countDueReviewItems(fixedNow, utility.id)).resolves.toBe(0);
    await expect(repository.listItems({ categoryId: null })).resolves.toMatchObject([
      { id: 'uncategorized-due', categoryId: null },
    ]);

    const summaries = await repository.listCategorySummaries(fixedNow);
    expect(summaries.find((summary) => summary.category?.id === tactics.id)).toMatchObject({
      totalCount: 3,
      dueCount: 1,
      nextReviewAt: fixedNow,
    });
    expect(summaries.find((summary) => summary.category?.id === utility.id)).toMatchObject({
      totalCount: 0,
      dueCount: 0,
      nextReviewAt: null,
    });
    expect(summaries.find((summary) => summary.category === null)).toMatchObject({
      totalCount: 1,
      dueCount: 1,
    });
  });

  it('merges and deletes Categories while preserving Moment identity, FSRS, tags, and screenshots', async () => {
    const source = await repository.createCategory('Source');
    const target = await repository.createCategory('Target');
    const created = await repository.createItem(
      learningItem({ id: 'move-me', categoryId: source.id, tags: ['keep', 'separate'] }),
      new Blob(['screenshot'], { type: 'image/png' }),
    );
    const dueBefore = created.fsrsCard.due.toISOString();

    await expect(repository.mergeCategory(source.id, target.id)).resolves.toBe(1);
    const merged = await repository.getItem(created.id);
    expect(merged).toMatchObject({
      id: created.id,
      categoryId: target.id,
      tags: ['keep', 'separate'],
    });
    expect(merged?.fsrsCard.due.toISOString()).toBe(dueBefore);
    await expect(repository.getScreenshot(created.screenshotId as string)).resolves.toBeInstanceOf(
      Blob,
    );
    await expect(repository.getCategory(source.id)).resolves.toBeUndefined();

    await expect(repository.deleteCategory(target.id)).resolves.toBe(1);
    await expect(repository.getItem(created.id)).resolves.toMatchObject({ categoryId: null });
    await expect(repository.getScreenshot(created.screenshotId as string)).resolves.toBeInstanceOf(
      Blob,
    );
  });

  it('round-trips Category IDs and treats legacy exports and stale selections as Uncategorized', async () => {
    const category = await repository.createCategory('Round trip');
    await repository.createItem(
      learningItem({ id: 'category-export', categoryId: category.id }),
      new Blob(['export']),
    );
    const exported = await repository.exportData();
    expect(exported.categories).toEqual([
      expect.objectContaining({ id: category.id, name: 'Round trip' }),
    ]);

    await repository.clearAll();
    await expect(repository.importData(exported, 'replace')).resolves.toMatchObject({
      categories: 1,
    });
    await expect(repository.getItem('category-export')).resolves.toMatchObject({
      categoryId: category.id,
    });

    const legacy = { ...exported, schemaVersion: 3 } as Record<string, unknown>;
    delete legacy.categories;
    delete legacy.notes;
    delete legacy.intakeReceipts;
    const legacyItems = structuredClone(exported.items);
    if (legacyItems[0]) delete (legacyItems[0] as { categoryId?: string | null }).categoryId;
    legacy.items = legacyItems;
    await expect(repository.importData(legacy, 'replace')).resolves.toMatchObject({
      categories: 0,
    });
    await expect(repository.getItem('category-export')).resolves.toMatchObject({
      categoryId: null,
    });

    const factory = new IDBFactory();
    const firstTab = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'category-tabs',
      clock: () => new Date(fixedNow),
      idGenerator: () => 'shared',
    });
    const secondTab = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'category-tabs',
      clock: () => new Date(fixedNow),
      idGenerator: () => 'second',
    });
    const shared = await firstTab.createCategory('Shared');
    await secondTab.deleteCategory(shared.id);
    await expect(
      firstTab.createItem(
        learningItem({ id: 'stale-capture', categoryId: shared.id }),
        new Blob(['stale']),
      ),
    ).resolves.toMatchObject({ categoryId: null });
    firstTab.close();
    secondTab.close();
  });

  it('deletes the item, screenshot and associated review history together', async () => {
    const item = await repository.createItem(
      learningItem({ id: 'delete-me' }),
      new Blob(['image']),
    );
    const result = fsrs().next(item.fsrsCard, fixedNow, Rating.Hard);
    await repository.saveReview({
      itemId: item.id,
      expectedState: reviewSchedulingStateFromCard(item.fsrsCard),
      card: result.card,
      log: result.log,
    });

    await repository.deleteItem(item.id);

    await expect(repository.getItem(item.id)).resolves.toBeUndefined();
    await expect(repository.listReviews(item.id)).resolves.toEqual([]);
    await expect(repository.getScreenshot(item.screenshotId as string)).resolves.toBeUndefined();
  });
});

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), { once: true });
  });
}
