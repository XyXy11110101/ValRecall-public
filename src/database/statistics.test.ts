// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { createEmptyCard, Rating } from 'ts-fsrs';
import { describe, expect, it, vi } from 'vitest';
import { FsrsService } from '../fsrs';
import { ValRecallRepository } from './repository';
import { statisticsAccumulator } from './statistics';

describe('learning statistics', () => {
  it('uses local calendar boundaries and separates repetitions, items and active days', () => {
    const now = new Date(2026, 8, 29, 12);
    const stats = statisticsAccumulator(7, now);
    stats.item({ id: 'a', createdAt: new Date(2026, 8, 23).toISOString(), suspended: true });
    stats.item({ id: 'b', createdAt: new Date(2026, 8, 22, 23, 59).toISOString() });
    const review = (itemId: string, at: Date, rating: number) =>
      stats.review({ itemId, reviewedAt: at.toISOString(), log: { rating } });
    review('a', new Date(2026, 8, 23), 1);
    review('a', new Date(2026, 8, 23, 12), 3);
    review('b', new Date(2026, 8, 29, 23, 59), 4);
    review('b', new Date(2026, 8, 30), 2);
    review('deleted', now, 2);
    expect(stats.result()).toMatchObject({
      reviewCount: 3,
      reviewedItems: 2,
      activeDays: 2,
      newItems: 1,
      ratings: { 1: 1, 2: 0, 3: 1, 4: 1 },
    });
    expect(stats.result().days).toHaveLength(7);
  });

  it.each([new Date(2026, 2, 31), new Date(2026, 9, 27)])(
    'keeps one bucket per local date across daylight-saving transitions: %s',
    (now) => {
      const stats = statisticsAccumulator(7, now);
      const days = stats.result().days;
      expect(days).toHaveLength(7);
      expect(new Set(days.map((day) => day.date)).size).toBe(7);
      stats.item({ id: 'a', createdAt: now.toISOString() });
      for (const day of days)
        stats.review({
          itemId: 'a',
          reviewedAt: new Date(`${day.date}T12:00:00`).toISOString(),
          log: { rating: 3 },
        });
      expect(stats.result().activeDays).toBe(7);
    },
  );

  it('rejects corrupt records rather than showing a successful zero', () => {
    const stats = statisticsAccumulator(7, new Date());
    expect(() => stats.item({ id: 'a', createdAt: 'invalid' })).toThrow();
    expect(() => stats.review({ reviewedAt: 'invalid' })).toThrow();
  });

  it('reads only items/reviews and reflects suspension, deletion and replacement import', async () => {
    const now = new Date(2026, 8, 29, 12);
    let id = 0;
    const repo = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      clock: () => now,
      idGenerator: () => `stats-${++id}`,
    });
    try {
      const item = await repo.createTextItem({
        title: 'Test',
        itemType: 'Understand',
        coreLesson: 'Answer',
        recallPrompt: 'Question',
        referenceAnswer: 'Answer',
        fsrsCard: createEmptyCard(now),
        tags: [],
      });
      await new FsrsService(repo, { clock: () => now }).reviewItem(item.id, Rating.Good, now);
      await repo.updateItem(item.id, { suspended: true });
      const backup = await repo.exportData();
      const db = await repo.open();
      const transaction = vi.spyOn(db, 'transaction');
      expect(await repo.getLearningStatistics(30, now)).toMatchObject({
        reviewCount: 1,
        reviewedItems: 1,
        activeDays: 1,
        newItems: 1,
      });
      expect(transaction).toHaveBeenCalledWith(['items', 'reviews'], 'readonly');
      expect(transaction).toHaveBeenCalledTimes(1);
      transaction.mockRestore();
      await repo.deleteItem(item.id);
      expect((await repo.getLearningStatistics(30, now)).reviewCount).toBe(0);
      await repo.importData(backup, 'replace');
      expect((await repo.getLearningStatistics(30, now)).reviewCount).toBe(1);
    } finally {
      await repo.close();
    }
  });
});
