// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { DraftRepository } from './drafts';
import { MobileRepository, mobileAvailableBalance } from './mobile-repository';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncSnapshot } from '../sync/contracts';
import { requestResult, transactionComplete } from './idb';

const now = new Date('2026-10-21T12:00:00Z');
const snapshot: SyncSnapshot = {
  version: 2,
  sequence: 1,
  epoch: 'epoch',
  generatedAt: now.toISOString(),
  timeZone: 'Asia/Shanghai',
  tasks: [],
  completions: [],
  occurrences: [],
  taskSkips: [],
  wallet: { ...structuredClone(DEFAULT_ALLOWANCE), balance: 20 },
};
function fixture() {
  const factory = new IDBFactory();
  const repository = new MobileRepository({
    indexedDBFactory: factory,
    databaseName: 'mobile',
    clock: () => now,
  });
  return { factory, repository, drafts: new DraftRepository(repository, () => now) };
}
describe('mobile drafts stay local until explicit submission', () => {
  it('restores incomplete input without creating tasks or spending, and migrates only the mobile database', async () => {
    const { factory, repository, drafts } = fixture();
    const request = factory.open('mobile', 2);
    request.onupgradeneeded = () => {
      for (const name of ['state', 'outbox', 'archives'])
        request.result.createObjectStore(name, { keyPath: 'id' });
    };
    const old = await requestResult(request);
    const tx = old.transaction('state', 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore('state').put({ id: 'current', epoch: 'epoch', snapshot, nextSequence: 1 });
    await done;
    old.close();
    expect((await repository.open()).version).toBe(3);
    const draft = await drafts.save(
      {
        id: 'input',
        scope: 'mobile-spend',
        summary: '未完成',
        payload: { amount: '0.', note: '草稿\nEnglish', epoch: 'epoch' },
      },
      0,
    );
    repository.close();
    expect(await drafts.list('mobile-spend')).toEqual([draft]);
    expect((await repository.load()).outbox).toEqual([]);
    expect((await repository.load()).snapshot).toEqual(snapshot);
    expect((await factory.databases()).map((db) => db.name)).toEqual(['mobile']);
  });
  it('atomically consumes a spend draft, reserves once and survives a lost response plus acknowledged-row cleanup', async () => {
    const { repository, drafts } = fixture();
    await repository.applySnapshot(snapshot);
    const draft = await drafts.save(
      {
        id: 'spend-op',
        scope: 'mobile-spend',
        summary: '4元',
        payload: { amount: '4', note: '茶' },
      },
      0,
    );
    const commit = { id: draft.id, epoch: 'epoch', draft };
    const saved = await repository.enqueueSpend(4, '茶', now, commit);
    expect(await drafts.list('mobile-spend')).toEqual([]);
    expect(await repository.enqueueSpend(4, '茶', new Date(now.getTime() + 1000), commit)).toEqual(
      saved,
    );
    expect(mobileAvailableBalance(await repository.load())).toBe(16);
    await repository.markAttempted('epoch', [saved.id]);
    await repository.recordReceipts(
      'epoch',
      [saved.id],
      [{ operationId: saved.id, status: 'applied', reward: 0, walletDelta: -4, message: '确认' }],
    );
    await repository.applySnapshot(
      { ...snapshot, sequence: 2, wallet: { ...snapshot.wallet, balance: 16 } },
      [saved.id],
    );
    expect((await repository.load()).outbox).toEqual([]);
    await repository.enqueueSpend(4, '茶', now, commit);
    expect((await repository.load()).outbox).toEqual([]);
    expect(mobileAvailableBalance(await repository.load())).toBe(16);
    await expect(repository.enqueueSpend(5, '茶', now, commit)).rejects.toThrow('已提交');
  });
  it('keeps task and spend inputs after stale-window, insufficient-money or changed-epoch failures', async () => {
    const { repository, drafts } = fixture();
    await repository.applySnapshot(snapshot);
    const draft = await drafts.save(
      { id: 'task-op', scope: 'mobile-task', summary: '读书', payload: { title: '读书' } },
      0,
    );
    await drafts.save({ ...draft, payload: { title: '新版' } }, draft.revision);
    await expect(
      repository.createTask({ title: '读书', recurrence: 'daily' }, now, {
        id: draft.id,
        epoch: 'epoch',
        draft,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await repository.load()).outbox).toEqual([]);
    await expect(
      repository.enqueueSpend(21, '', now, { id: 'spend', epoch: 'epoch', draft }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    await repository.acceptNewEpoch('new-epoch');
    await expect(
      repository.createTask({ title: '读书', recurrence: 'daily' }, now, {
        id: draft.id,
        epoch: 'epoch',
        draft,
      }),
    ).rejects.toMatchObject({ code: 'EPOCH_CHANGED' });
    expect(await drafts.list('mobile-task')).toHaveLength(1);
    expect((await repository.load()).outbox).toEqual([]);
  });
  it('creates one task and one ordered operation under double submission', async () => {
    const { repository, drafts } = fixture();
    await repository.applySnapshot(snapshot);
    const draft = await drafts.save(
      { id: 'task-op', scope: 'mobile-task', summary: '读书', payload: { title: '读书' } },
      0,
    );
    const commit = { id: draft.id, epoch: 'epoch', draft };
    const values = { title: '读书', recurrence: 'daily' as const };
    const [first, second] = await Promise.all([
      repository.createTask(values, now, commit),
      repository.createTask(values, now, commit),
    ]);
    expect(second).toEqual(first);
    expect((await repository.load()).outbox).toHaveLength(1);
    expect(await drafts.list('mobile-task')).toEqual([]);
  });
});
