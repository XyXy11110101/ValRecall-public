// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { WalletRepository } from './wallet';
import { FsrsService } from '../fsrs';
import { ReviewSessionService } from '../fsrs/ReviewSessionService';
import { STORE_NAMES } from './migrations';
import { transactionComplete } from './idb';
import { contentRevision } from './sync-revision';
import { readReviewSession } from './review-sessions';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { readAllowanceState } from './wallet';

const now = new Date('2026-10-21T12:00:00Z');
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const repository = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'session',
    clock: () => now,
  });
  const scheduler = new FsrsService({ clock: () => now });
  const items = await Promise.all(
    ['a', 'b'].map((id) =>
      repository.createTextItem({
        id,
        title: id,
        itemType: 'Understand',
        recallPrompt: 'Why?',
        coreLesson: 'Answer',
        referenceAnswer: 'Answer',
        fsrsCard: scheduler.createInitialCard(),
      }),
    ),
  );
  const service = new ReviewSessionService(repository);
  const seed = {
    id: 'session-one',
    queue: items.map((item) => item.id),
    createdAt: now.toISOString(),
  };
  return { repository, scheduler, service, seed, items, wallet: new WalletRepository(repository) };
}
describe('durable Review completion', () => {
  it.each(['Again', 'Hard', 'Good', 'Easy'] as const)(
    'atomically rewards each %s rating and preserves the final session reward',
    async (rating) => {
      const { service, seed, items, scheduler, wallet, repository } = await fixture();
      const first = await service.rate(seed, items[0]!, rating, now, scheduler, now);
      expect(first.rewardAmount).toBe(1);
      expect(first.session.steps[0]?.rewardAmount).toBe(1);
      expect((await wallet.load()).balance).toBe(1);
      expect((await wallet.load()).lastReviewSessionDate).toBeNull();
      const final = await service.rate(seed, items[1]!, rating, now, scheduler, now);
      expect(final.session.status).toBe('completed');
      expect(final.rewardAmount).toBe(1);
      expect((await wallet.load()).balance).toBe(7);
      const replay = await service.rate(
        seed,
        items[1]!,
        rating,
        new Date(now.getTime() + 60000),
        scheduler,
        new Date(now.getTime() + 60000),
      );
      expect(replay).toEqual(final);
      expect((await repository.getItem('b'))?.reviewHistory).toHaveLength(1);
      expect((await wallet.load()).balance).toBe(7);
    },
  );
  it('keeps an interrupted rating reward but does not grant a completion or merge sessions', async () => {
    const { service, seed, items, scheduler, wallet } = await fixture();
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    expect((await service.sessions.get(seed.id))?.status).toBe('active');
    const next = { ...seed, id: 'new-session', queue: ['b'] };
    await service.finishItem(next, items[1]!, 'mastered', now);
    expect((await wallet.load()).balance).toBe(1);
    expect((await wallet.load()).lastReviewSessionDate).toBeNull();
    expect((await service.sessions.get(seed.id))?.steps).toHaveLength(1);
  });
  it('rolls back the last rating on wallet failure, retaining previous ratings', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    const validWallet = await wallet.load();
    const tx = (await repository.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: { invalid: true } });
    await done;
    await expect(service.rate(seed, items[1]!, 'Good', now, scheduler, now)).rejects.toThrow();
    expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(1);
    expect((await repository.getItem('b'))?.reviewHistory).toHaveLength(0);
    expect((await service.sessions.get(seed.id))?.status).toBe('active');
    const repair = (await repository.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const repaired = transactionComplete(repair);
    repair.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: validWallet });
    await repaired;
    await service.rate(seed, items[1]!, 'Good', now, scheduler, now);
    expect((await wallet.load()).balance).toBe(7);
  });
  it('settles a final mastery or genuine unavailable item without fabricating a rating', async () => {
    for (const kind of ['mastered', 'unavailable'] as const) {
      const { service, seed, items, scheduler, wallet, repository } = await fixture();
      await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
      if (kind === 'unavailable') await repository.deleteItem('b');
      const result = await service.finishItem(seed, items[1]!, kind, now);
      expect(result.status).toBe('completed');
      expect(result.steps.filter((step) => step.review)).toHaveLength(1);
      expect(result.steps[1]?.rewardAmount).toBeUndefined();
      expect((await wallet.load()).balance).toBe(6);
    }
  });
  it('rejects changed ratings and out-of-order or stale window operations', async () => {
    const { service, seed, items, scheduler, wallet } = await fixture();
    await expect(service.rate(seed, items[1]!, 'Good', now, scheduler, now)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    await expect(service.rate(seed, items[0]!, 'Easy', now, scheduler, now)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(service.finishItem(seed, items[1]!, 'unavailable', now)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await wallet.load()).balance).toBe(1);
  });
});

async function revision(repository: ValRecallRepository): Promise<string> {
  const tx = (await repository.open()).transaction(STORE_NAMES.wallet, 'readonly');
  const done = transactionComplete(tx);
  const value = await contentRevision(tx);
  await done;
  return value;
}

describe('per-Moment review reward receipts', () => {
  it('grants once on double submission and changes sync revision once, including after a lost response', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    await wallet.ensureWallet();
    const before = await revision(repository);
    const [first, second] = await Promise.all([
      service.rate(seed, items[0]!, 'Good', now, scheduler, now),
      service.rate(seed, items[0]!, 'Good', now, scheduler, now),
    ]);
    expect(second).toEqual(first);
    const after = await revision(repository);
    expect(after).not.toBe(before);
    const replay = await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    expect(replay).toEqual(first);
    expect(await revision(repository)).toBe(after);
    expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(1);
    const state = await wallet.load();
    expect(state.balance).toBe(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      source: 'milestone',
      note: '完成一道回忆题 +1',
      amount: 1,
    });
    expect(readAllowanceState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each(['state', 'contentRevision', 'session'])(
    'rolls back rating, wallet and session on a %s write failure, then retries exactly once',
    async (faultKey) => {
      const { service, seed, items, scheduler, wallet, repository } = await fixture();
      await wallet.ensureWallet();
      const before = await revision(repository);
      const original = IDBObjectStore.prototype.put;
      const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        const row = args[0] as { key?: unknown };
        if (
          (this.name === STORE_NAMES.wallet && row.key === faultKey) ||
          (this.name === STORE_NAMES.reviewSessions && faultKey === 'session')
        )
          throw new DOMException('Synthetic disk failure', 'QuotaExceededError');
        return original.apply(this, args);
      });
      await expect(service.rate(seed, items[0]!, 'Good', now, scheduler, now)).rejects.toThrow();
      fault.mockRestore();
      expect((await repository.getItem('a'))?.reviewHistory).toEqual([]);
      expect((await repository.getItem('a'))?.fsrsCard).toEqual(items[0]!.fsrsCard);
      expect(await service.sessions.get(seed.id)).toBeUndefined();
      expect((await wallet.load()).balance).toBe(0);
      expect(await revision(repository)).toBe(before);
      await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
      await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
      expect((await wallet.load()).balance).toBe(1);
      expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(1);
    },
  );

  it('awards a later due review again, but rejects a stale second window', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    const firstSeed = { ...seed, queue: ['a'] };
    await service.rate(firstSeed, items[0]!, 'Good', now, scheduler, now);
    await expect(
      service.rate({ ...firstSeed, id: 'stale-window' }, items[0]!, 'Good', now, scheduler, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = (await repository.getItem('a'))!;
    const later = current.fsrsCard.due;
    const secondSeed = { id: 'next-due', queue: ['a'], createdAt: later.toISOString() };
    const result = await service.rate(secondSeed, current, 'Good', later, scheduler, later);
    expect(result.rewardAmount).toBe(1);
    expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(2);
    expect(
      (await wallet.load()).ledger.filter((entry) => entry.note === '完成一道回忆题 +1'),
    ).toHaveLength(2);
  });

  it('retains earlier progress and earnings when the final atomic wallet write fails', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    const before = await revision(repository);
    const original = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_NAMES.wallet)
        throw new DOMException('Synthetic full disk', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(service.rate(seed, items[1]!, 'Easy', now, scheduler, now)).rejects.toThrow();
    fault.mockRestore();
    expect(await service.sessions.get(seed.id)).toMatchObject({ status: 'active', revision: 1 });
    expect((await repository.getItem('a'))?.reviewHistory).toHaveLength(1);
    expect((await repository.getItem('b'))?.reviewHistory).toHaveLength(0);
    expect(await wallet.load()).toMatchObject({ balance: 1, lastReviewSessionDate: null });
    expect(await revision(repository)).toBe(before);
    await service.rate(seed, items[1]!, 'Easy', now, scheduler, now);
    await service.rate(seed, items[1]!, 'Easy', now, scheduler, now);
    expect(await wallet.load()).toMatchObject({ balance: 7, reviewStreak: 1 });
  });

  it('keeps rated evidence across clear, restore and wallet reset without restoring rewards', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    const first = await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    const backup = await repository.exportData();
    expect(backup.reviewSessions?.[0]?.steps[0]?.rewardAmount).toBe(1);
    await repository.clearAll();
    expect(await service.rate(seed, items[0]!, 'Good', now, scheduler, now)).toEqual(first);
    expect((await wallet.load()).balance).toBe(1);
    expect(await repository.getItem('a')).toBeUndefined();
    await repository.importData(backup, 'replace');
    expect((await wallet.load()).balance).toBe(1);
    await wallet.update(() => ({ state: structuredClone(DEFAULT_ALLOWANCE), result: undefined }));
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    expect((await wallet.load()).balance).toBe(0);

    const target = await fixture();
    await target.repository.importData(backup, 'replace', { restoreWallet: true });
    expect((await target.wallet.load()).balance).toBe(1);
    expect(
      (await target.service.rate(seed, items[0]!, 'Good', now, scheduler, now)).rewardAmount,
    ).toBe(1);
    expect((await target.wallet.load()).balance).toBe(1);
  });

  it('reads legacy v11 receipts without backfilling and rejects invalid reward evidence', async () => {
    const { service, seed, items, scheduler, wallet, repository } = await fixture();
    await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    const backup = await repository.exportData();
    const old = backup.reviewSessions![0]!;
    delete old.steps[0]!.rewardAmount;
    backup.wallet = structuredClone(DEFAULT_ALLOWANCE);
    await repository.importData(backup, 'replace', { restoreWallet: true });
    const replay = await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    expect(replay.rewardAmount).toBe(0);
    expect((await wallet.load()).balance).toBe(0);
    for (const invalid of [-1, 0, 2, null, '1']) {
      expect(() =>
        readReviewSession({ ...old, steps: [{ ...old.steps[0], rewardAmount: invalid }] }),
      ).toThrow('逐题复习奖励凭据无效');
    }
  });

  it('returns durable receipts even if a later unrelated operation corrupts the wallet', async () => {
    const { service, seed, items, scheduler, repository } = await fixture();
    const saved = await service.rate(seed, items[0]!, 'Good', now, scheduler, now);
    const tx = (await repository.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: { broken: true } });
    await done;
    expect(await service.rate(seed, items[0]!, 'Good', now, scheduler, now)).toEqual(saved);
  });
});
