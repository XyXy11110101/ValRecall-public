import { IDBFactory } from 'fake-indexeddb';
import { Rating, State, type Card } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { ValRecallRepository } from '../database/repository';
import type { NewVideoLearningItem } from '../database/types';
import { FSRS_RATING_OPTIONS, FsrsError, FsrsService, toFsrsRating } from './FsrsService';

const fixedNow = new Date('2026-07-20T12:00:00.000Z');

function input(id: string): NewVideoLearningItem {
  return {
    id,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1test',
    videoTitle: 'Crosshair placement',
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    itemType: 'Notice',
    coreLesson: 'Notice whether the crosshair is already at head height.',
    recallPrompt: 'What cue should you notice here?',
    referenceAnswer: 'The crosshair should already be at likely head height.',
    fsrsCard: new FsrsService({ clock: () => new Date(fixedNow) }).createInitialCard(),
  };
}

describe('FsrsService', () => {
  it('creates an initial card due at the injected clock', () => {
    const service = new FsrsService({ clock: () => new Date(fixedNow) });
    const card = service.createInitialCard();

    expect(card.due.toISOString()).toBe(fixedNow.toISOString());
    expect(service.isDue(card)).toBe(true);
  });

  it.each(FSRS_RATING_OPTIONS)('uses the official scheduler for $label', ({ label, value }) => {
    const service = new FsrsService({ clock: () => new Date(fixedNow) });
    const original = service.createInitialCard();
    const originalDue = original.due.toISOString();
    const result = service.schedule(original, label);

    expect(result.rating).toBe(value);
    expect(result.log.rating).toBe(value);
    expect(result.log.review.toISOString()).toBe(fixedNow.toISOString());
    expect(result.nextDue.getTime()).toBeGreaterThan(fixedNow.getTime());
    expect(result.card.due.toISOString()).toBe(result.nextDue.toISOString());
    expect(original.due.toISOString()).toBe(originalDue);
    expect(original.reps).toBe(0);
  });

  it('previews all ratings without mutating the card', () => {
    const service = new FsrsService({ clock: () => new Date(fixedNow) });
    const card = service.createInitialCard();
    const preview = service.preview(card);

    expect(Object.keys(preview)).toEqual(['1', '2', '3', '4']);
    expect(preview[Rating.Good].log.rating).toBe(Rating.Good);
    expect(card.reps).toBe(0);
  });

  it('reproduces the verified Standard short-term and long-term schedule', () => {
    const service = new FsrsService({ clock: () => new Date(fixedNow) });
    const newCard = service.createInitialCard();
    const firstGood = service.schedule(newCard, Rating.Good, fixedNow);
    const secondGood = service.schedule(firstGood.card, Rating.Good, firstGood.nextDue);
    const reviewGood = service.schedule(secondGood.card, Rating.Good, secondGood.nextDue);
    const reviewAgain = service.schedule(secondGood.card, Rating.Again, secondGood.nextDue);
    const relearningGood = service.schedule(reviewAgain.card, Rating.Good, reviewAgain.nextDue);

    expectSchedule(firstGood.card, {
      state: State.Learning,
      due: '2026-07-20T12:10:00.000Z',
      scheduledDays: 0,
      stability: 2.3065,
      difficulty: 2.11810397,
      reps: 1,
      lapses: 0,
    });
    expectSchedule(secondGood.card, {
      state: State.Review,
      due: '2026-07-22T12:10:00.000Z',
      scheduledDays: 2,
      stability: 2.3065,
      difficulty: 2.11121424,
      reps: 2,
      lapses: 0,
    });
    expectSchedule(reviewGood.card, {
      state: State.Review,
      due: '2026-08-02T12:10:00.000Z',
      scheduledDays: 11,
      stability: 10.97104786,
      difficulty: 2.1043314,
      reps: 3,
      lapses: 0,
    });
    expectSchedule(reviewAgain.card, {
      state: State.Relearning,
      due: '2026-07-22T12:20:00.000Z',
      scheduledDays: 0,
      stability: 0.60770166,
      difficulty: 7.39223814,
      reps: 3,
      lapses: 1,
    });
    expectSchedule(relearningGood.card, {
      state: State.Review,
      due: '2026-07-23T12:20:00.000Z',
      scheduledDays: 1,
      stability: 0.65979762,
      difficulty: 7.38007427,
      reps: 4,
      lapses: 1,
    });
  });

  it.each([
    [Rating.Hard, State.Learning, '2026-07-20T12:06:00.000Z', 1.2931, 5.11217071],
    [Rating.Easy, State.Review, '2026-07-28T12:00:00.000Z', 8.2956, 1],
  ] as const)(
    'records the exact first-review schedule for rating %s',
    (rating, state, due, stability, difficulty) => {
      const service = new FsrsService({ clock: () => new Date(fixedNow) });
      const result = service.schedule(service.createInitialCard(), rating);

      expectSchedule(result.card, {
        state,
        due,
        scheduledDays: state === State.Review ? 8 : 0,
        stability,
        difficulty,
        reps: 1,
        lapses: 0,
      });
    },
  );

  it('persists the updated card and official log, then reconstructs both', async () => {
    let sequence = 0;
    const indexedDBFactory = new IDBFactory();
    const repository = new ValRecallRepository({
      indexedDBFactory,
      databaseName: 'fsrs-integration',
      clock: () => new Date(fixedNow),
      idGenerator: () => `review-${(sequence += 1)}`,
    });
    const item = await repository.createItem(input('item-1'), new Blob(['screenshot']));
    const service = new FsrsService(repository, {
      clock: () => new Date(fixedNow),
    });

    const result = await service.reviewItem(item.id, 'good');
    const reloaded = await repository.getItem(item.id);

    expect(result.reviewRecord.itemId).toBe(item.id);
    expect(result.log.rating).toBe(Rating.Good);
    expect(reloaded?.fsrsCard.due.toISOString()).toBe(result.nextDue.toISOString());
    expect(reloaded?.fsrsCard.state).toBe(State.Learning);
    expect(reloaded?.fsrsCard.reps).toBe(1);
    expect(reloaded?.reviewHistory).toHaveLength(1);
    expect(reloaded?.reviewHistory[0]?.log.review).toBeInstanceOf(Date);
    expect((await repository.listDueItems(fixedNow)).map(({ id }) => id)).not.toContain(item.id);

    const reopenedRepository = new ValRecallRepository({
      indexedDBFactory,
      databaseName: 'fsrs-integration',
      clock: () => new Date(fixedNow),
    });
    const reopened = await reopenedRepository.getItem(item.id);
    expect(reopened?.fsrsCard.due.getTime()).toBe(result.nextDue.getTime());
    expect(reopened?.fsrsCard.last_review?.getTime()).toBe(fixedNow.getTime());
    expect(reopened?.reviewHistory).toHaveLength(1);
  });

  it('persists a due follow-up review whose FSRS log due differs from the current card due', async () => {
    let sequence = 0;
    const repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'fsrs-follow-up-review',
      clock: () => new Date(fixedNow),
      idGenerator: () => `follow-up-${(sequence += 1)}`,
    });
    const item = await repository.createItem(input('follow-up-item'), new Blob(['screenshot']));
    const service = new FsrsService(repository);
    const first = await service.reviewItem(item.id, Rating.Good, new Date(fixedNow));

    const second = await service.reviewItem(item.id, Rating.Good, new Date(first.nextDue));
    const reloaded = await repository.getItem(item.id);

    expect(first.log.due.getTime()).toBe(item.fsrsCard.due.getTime());
    expect(second.log.due.getTime()).not.toBe(first.card.due.getTime());
    expect(reloaded?.reviewHistory).toHaveLength(2);
    expect(reloaded?.fsrsCard.due.getTime()).toBe(second.nextDue.getTime());
  });

  it('schedules a Douyin learning item through the unchanged official FSRS flow', async () => {
    const repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'fsrs-douyin-integration',
      clock: () => new Date(fixedNow),
      idGenerator: () => 'douyin-review',
    });
    const item = await repository.createItem(
      {
        ...input('douyin-item'),
        platform: 'douyin',
        sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=fixture',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
        videoId: '7391234567890123456',
        videoTitle: 'Douyin learning moment',
      },
      new Blob(['screenshot']),
    );
    const service = new FsrsService(repository, { clock: () => new Date(fixedNow) });

    const result = await service.reviewItem(item.id, 'good');
    const reloaded = await repository.getItem(item.id);

    expect(reloaded).toMatchObject({ platform: 'douyin' });
    expect(result.log.rating).toBe(Rating.Good);
    expect(reloaded?.reviewHistory).toHaveLength(1);
    expect(reloaded?.fsrsCard.due.toISOString()).toBe(result.nextDue.toISOString());
  });

  it('does not report a suspended learning item as due', async () => {
    const repository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'fsrs-suspended',
      clock: () => new Date(fixedNow),
    });
    const item = await repository.createItem(
      { ...input('suspended-item'), suspended: true },
      new Blob(['screenshot']),
    );
    const service = new FsrsService({ repository, clock: () => new Date(fixedNow) });

    expect(service.isDue(item)).toBe(false);
  });

  it('normalizes supported ratings and rejects invalid input', () => {
    expect(toFsrsRating('Again')).toBe(Rating.Again);
    expect(toFsrsRating('easy')).toBe(Rating.Easy);
    expect(() => toFsrsRating(0 as Rating.Again)).toThrow(FsrsError);
  });

  it('requires persistence for reviewItem', async () => {
    const service = new FsrsService({ clock: () => new Date(fixedNow) });
    await expect(service.reviewItem('missing', Rating.Good)).rejects.toMatchObject({
      code: 'PERSISTENCE_REQUIRED',
    });
  });
});

function expectSchedule(
  card: Card,
  expected: {
    state: State;
    due: string;
    scheduledDays: number;
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
  },
): void {
  expect(card).toMatchObject({
    state: expected.state,
    scheduled_days: expected.scheduledDays,
    stability: expected.stability,
    difficulty: expected.difficulty,
    reps: expected.reps,
    lapses: expected.lapses,
  });
  expect(card.due.toISOString()).toBe(expected.due);
}
