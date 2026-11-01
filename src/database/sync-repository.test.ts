// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { SyncRepository } from './sync-repository';
import { readSyncBackup } from './sync-backup';
import { WalletRepository } from './wallet';
import { STORE_NAMES, runMigrations } from './migrations';
import { requestResult, transactionComplete } from './idb';
import { applyCaptureReward, DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncOperation, SyncSnapshot } from '../sync/contracts';
import { computerTimeZone } from '../sync/protocol';
import { seedHistoricalTask } from '../testing/historical-task';

// Noon on the computer's own calendar, and the computer's own zone, as the sync service reports it.
// The desktop paths pick "today" from local time, so a fixed UTC instant is a different day far from UTC.
const now = new Date(2026, 9, 13, 12);
const timeZone = computerTimeZone();
const repos: ValRecallRepository[] = [];
function fixture(legacy: unknown = undefined) {
  const factory = new IDBFactory();
  const repository = new ValRecallRepository({
    indexedDBFactory: factory,
    databaseName: 'sync-tests',
    clock: () => now,
  });
  repos.push(repository);
  const legacyLoader = vi.fn(async () => legacy);
  const sync = new SyncRepository(repository, { legacyLoader, clock: () => now });
  return { factory, repository, sync, legacyLoader };
}
async function routine(repository: ValRecallRepository, id = 'task-one') {
  return seedHistoricalTask(repository, now, id);
}
function completion(
  snapshot: SyncSnapshot,
  id = 'operation-one',
  taskId = 'task-one',
): SyncOperation {
  const task = snapshot.tasks.find((row) => row.task.id === taskId)!;
  return {
    id,
    kind: 'complete-task',
    at: now.toISOString(),
    date: '2026-10-13',
    timeZone,
    taskId,
    taskRevision: task.revision,
    occurrenceRevision:
      snapshot.occurrences.find((row) => row.taskId === taskId && row.date === '2026-10-13')
        ?.revision ?? null,
  };
}
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('unified wallet migration and atomic task changes', () => {
  it('upgrades v3 task data and migrates legacy allowance once without inferring rewards from the ledger', async () => {
    const test = fixture({
      ...DEFAULT_ALLOWANCE,
      balance: 123,
      totalEarned: 300,
      totalSpent: 177,
      ledgerSeq: 800,
    });
    const request = test.factory.open('sync-tests', 3);
    request.addEventListener('upgradeneeded', () =>
      runMigrations(request.result, request.transaction!, 0, 3),
    );
    const old = await requestResult(request);
    old.close();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    expect(snapshot.wallet).toEqual({
      ...DEFAULT_ALLOWANCE,
      balance: 123,
      totalEarned: 300,
      totalSpent: 177,
      ledgerSeq: 800,
    });
    await test.sync.getSnapshot(timeZone);
    expect(test.legacyLoader).toHaveBeenCalledTimes(1);
    expect((await test.repository.open()).version).toBe(6);
  });

  it('preserves source data and blocks completion if legacy loading or money validation fails', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, schemaVersion: 1, balance: -1 });
    await routine(test.repository);
    await expect(
      test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now),
    ).rejects.toThrow('金额');
    expect(await test.repository.listTaskCompletions()).toEqual([]);
    const tx = (await test.repository.open()).transaction(STORE_NAMES.wallet, 'readonly');
    expect(await requestResult(tx.objectStore(STORE_NAMES.wallet).get('state'))).toBeUndefined();
    expect(await requestResult(tx.objectStore(STORE_NAMES.wallet).count())).toBe(1); // revision only
    test.legacyLoader.mockRejectedValueOnce(new Error('legacy unavailable'));
    await expect(test.sync.ensureWallet()).rejects.toThrow('legacy unavailable');
  });

  it.each([1.5, -1, Number.NaN])(
    'rejects malformed raw ledger money (%s) before normalization',
    async (amount) => {
      const test = fixture({
        ...DEFAULT_ALLOWANCE,
        balance: 9,
        ledger: [
          {
            id: 'legacy-1',
            at: now.toISOString(),
            date: '2026-10-13',
            direction: 'earn',
            reason: 'manual',
            amount,
            balanceAfter: 9,
            note: 'Synthetic',
          },
        ],
      });
      await expect(test.sync.ensureWallet()).rejects.toThrow('账本金额');
      const tx = (await test.repository.open()).transaction(STORE_NAMES.wallet, 'readonly');
      expect(await requestResult(tx.objectStore(STORE_NAMES.wallet).get('state'))).toBeUndefined();
      expect(await requestResult(tx.objectStore(STORE_NAMES.wallet).count())).toBe(0);
    },
  );

  it('serializes concurrent desktop completion and other wallet writers in IndexedDB', async () => {
    const test = fixture();
    await routine(test.repository);
    await test.sync.ensureWallet();
    const wallet = new WalletRepository(test.repository, test.legacyLoader);
    const [first, second] = await Promise.all([
      test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now),
      test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now),
      wallet.update((state) => {
        const result = applyCaptureReward(state, '2026-10-13', now.toISOString());
        return { state: result.state, result };
      }),
    ]);
    expect([first.changed, second.changed]).toEqual([true, false]);
    expect((await wallet.load()).balance).toBe(12);
    expect(await test.repository.listTaskCompletions()).toHaveLength(1);
  });

  it('does not reward desktop historical completion and only reverses a rewarded occurrence', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 20, totalEarned: 20 });
    await routine(test.repository);
    expect(
      (await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-12', true, now)).reward,
    ).toBeNull();
    expect(
      (await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-12', false, now)).reward,
    ).toBeNull();
    await test.repository.completeTaskForDate('task-one', '2026-10-13');
    expect(
      (await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', false, now)).reward,
    ).toBeNull();
    expect((await test.sync.wallet.load()).balance).toBe(20);
  });
});

describe('durable cross-device operations', () => {
  it('deducts phone spending once across lost replies, restarts, and conflicting retries', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 20, totalEarned: 20 });
    const epoch = await test.sync.getEpoch();
    const operation: SyncOperation = {
      id: 'spend-one',
      kind: 'spend-allowance',
      at: now.toISOString(),
      amount: 7,
      note: '合成午餐',
    };
    const first = await test.sync.applyOperations(epoch, 'phone', [operation]);
    expect(first[0]).toMatchObject({ status: 'applied', reward: 0 });
    const restarted = new SyncRepository(test.repository, { legacyLoader: test.legacyLoader });
    expect(await restarted.applyOperations(epoch, 'phone', [operation])).toEqual(first);
    expect(
      (await restarted.applyOperations(epoch, 'phone', [{ ...operation, amount: 8 }]))[0]?.status,
    ).toBe('conflict');
    expect((await restarted.applyOperations(epoch, 'other-phone', [operation]))[0]?.status).toBe(
      'conflict',
    );
    const state = await test.sync.wallet.load();
    expect(state).toMatchObject({ balance: 13, totalEarned: 20, totalSpent: 7 });
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      source: 'spend',
      amount: 7,
      note: '合成午餐',
      at: operation.at,
    });
  });

  it('keeps insufficient-balance conflicts final and serializes competing spends', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 10, totalEarned: 10 });
    const epoch = await test.sync.getEpoch();
    const base = { kind: 'spend-allowance' as const, at: now.toISOString(), amount: 6, note: '' };
    const results = await Promise.all([
      test.sync.applyOperations(epoch, 'phone', [{ ...base, id: 'spend-a' }]),
      test.sync.applyOperations(epoch, 'phone', [{ ...base, id: 'spend-b' }]),
    ]);
    expect(
      results
        .flat()
        .map((row) => row.status)
        .sort(),
    ).toEqual(['applied', 'conflict']);
    expect((await test.sync.wallet.load()).balance).toBe(4);
    const rejectedId = results.flat().find((row) => row.status === 'conflict')!.operationId;
    await test.sync.wallet.update((state) => ({
      state: { ...state, balance: 100 },
      result: undefined,
    }));
    expect(
      (await test.sync.applyOperations(epoch, 'phone', [{ ...base, id: rejectedId }]))[0]?.status,
    ).toBe('conflict');
    expect((await test.sync.wallet.load()).balance).toBe(100);
  });

  it('rolls a phone deduction back if its durable receipt cannot be written', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 20, totalEarned: 20 });
    const epoch = await test.sync.getEpoch();
    const tx = (await test.repository.open()).transaction(STORE_NAMES.syncReceipts, 'readonly');
    const prototype = Object.getPrototypeOf(
      tx.objectStore(STORE_NAMES.syncReceipts),
    ) as IDBObjectStore;
    const original = prototype.add;
    const spy = vi.spyOn(prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === STORE_NAMES.syncReceipts) throw new Error('synthetic receipt failure');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    const operation: SyncOperation = {
      id: 'rollback-spend',
      kind: 'spend-allowance',
      at: now.toISOString(),
      amount: 7,
      note: '',
    };
    await expect(test.sync.applyOperations(epoch, 'phone', [operation])).rejects.toThrow(
      'synthetic',
    );
    spy.mockRestore();
    expect(await test.sync.wallet.load()).toMatchObject({ balance: 20, totalSpent: 0, ledger: [] });
    expect((await test.sync.applyOperations(epoch, 'phone', [operation]))[0]?.status).toBe(
      'applied',
    );
    expect((await test.sync.wallet.load()).balance).toBe(13);
  });

  it('applies a new +5 task reward followed by a deduction in the same ordered batch', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const receipts = await test.sync.applyOperations(snapshot.epoch, 'phone', [
      completion(snapshot),
      {
        id: 'earned-then-spent',
        kind: 'spend-allowance',
        at: now.toISOString(),
        amount: 5,
        note: '',
      },
    ]);
    expect(receipts.map((row) => [row.status, row.reward])).toEqual([
      ['applied', 5],
      ['applied', 0],
    ]);
    expect(await test.sync.wallet.load()).toMatchObject({
      balance: 0,
      totalEarned: 5,
      totalSpent: 5,
    });
  });

  it('stores original receipts, rejects changed payload/device identity, and never replays a reward', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const operation = completion(snapshot);
    const first = await test.sync.applyOperations(snapshot.epoch, 'phone-one', [operation]);
    expect(first[0]).toMatchObject({ status: 'applied', reward: 5 });
    expect(await test.sync.applyOperations(snapshot.epoch, 'phone-one', [operation])).toEqual(
      first,
    );
    expect(
      (await test.sync.applyOperations(snapshot.epoch, 'phone-two', [operation]))[0]?.status,
    ).toBe('conflict');
    expect(
      (
        await test.sync.applyOperations(snapshot.epoch, 'phone-one', [
          { ...operation, at: new Date(2026, 9, 13, 13).toISOString() },
        ])
      )[0]?.status,
    ).toBe('conflict');
    expect(
      (
        await test.sync.applyOperations(snapshot.epoch, 'phone-one', [
          { ...operation, id: 'new-operation' },
        ])
      )[0],
    ).toMatchObject({ status: 'duplicate', reward: 0 });
    expect((await test.sync.wallet.load()).balance).toBe(5);
  });

  it('applies an eligible saved action date after the computer day has changed', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const late = new SyncRepository(test.repository, {
      legacyLoader: test.legacyLoader,
      clock: () => new Date(2026, 9, 15, 12),
    });
    expect(
      (await late.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]))[0],
    ).toMatchObject({ status: 'applied', reward: 5 });
    expect((await test.repository.listTaskCompletions())[0]?.localDate).toBe('2026-10-13');
  });

  it('prevents stale offline completion after desktop undo, edit and delete/recreate', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const original = completion(snapshot);
    await test.sync.applyOperations(snapshot.epoch, 'phone', [original]);
    await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', false, now);
    expect(
      (
        await test.sync.applyOperations(snapshot.epoch, 'phone', [
          { ...original, id: 'after-undo' },
        ])
      )[0]?.status,
    ).toBe('conflict');
    expect((await test.sync.wallet.load()).balance).toBe(0);
    await test.repository.updateTask('task-one', { title: 'Changed' });
    expect(
      (
        await test.sync.applyOperations(snapshot.epoch, 'phone', [
          { ...original, id: 'after-edit' },
        ])
      )[0]?.status,
    ).toBe('conflict');
    await test.repository.deleteTask('task-one');
    await routine(test.repository);
    expect(
      (
        await test.sync.applyOperations(snapshot.epoch, 'phone', [
          { ...original, id: 'after-recreate' },
        ])
      )[0]?.status,
    ).toBe('conflict');
    expect((await test.sync.wallet.load()).balance).toBe(0);
  });

  it('reverses a past phone grant on a later desktop undo before a fresh completion can earn again', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    await test.sync.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]);
    const undo = await test.sync.changeTaskCompletionAtomic(
      'task-one',
      '2026-10-13',
      false,
      new Date(2026, 9, 15, 12),
    );
    expect(undo.reward?.state.balance).toBe(0);
    const refreshed = await test.sync.getSnapshot(timeZone);
    const repeat = completion(refreshed, 'fresh-after-undo');
    expect((await test.sync.applyOperations(snapshot.epoch, 'phone', [repeat]))[0]?.reward).toBe(5);
    expect((await test.sync.wallet.load()).balance).toBe(5);
  });

  it('creates and completes a mobile task in ordered operations with the creation ID as revision', async () => {
    const test = fixture();
    const task = await routine(test.repository, 'template');
    await test.repository.deleteTask('template');
    const epoch = await test.sync.getEpoch();
    const create: SyncOperation = {
      id: 'create-operation',
      kind: 'create-task',
      at: now.toISOString(),
      task: { ...task, id: 'phone-task' },
    };
    const complete: SyncOperation = {
      id: 'complete-operation',
      kind: 'complete-task',
      at: now.toISOString(),
      taskId: 'phone-task',
      date: '2026-10-13',
      timeZone,
      taskRevision: create.id,
      occurrenceRevision: null,
    };
    expect(
      (await test.sync.applyOperations(epoch, 'phone', [create, complete])).map(
        (row) => row.status,
      ),
    ).toEqual(['applied', 'applied']);
    expect((await test.sync.getSnapshot(timeZone)).tasks[0]?.revision).toBe(create.id);
    await test.repository.deleteTask('phone-task');
    expect((await test.sync.applyOperations(epoch, 'phone', [create]))[0]?.status).toBe('applied');
    expect(await test.repository.getTask('phone-task')).toBeUndefined();
    expect(
      (await test.sync.applyOperations(epoch, 'phone', [{ ...create, id: 'different-create' }]))[0]
        ?.status,
    ).toBe('conflict');
  });

  it('rolls back completion, reward and receipt together on a write failure', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const database = await test.repository.open();
    const transaction = database.transaction(STORE_NAMES.syncReceipts, 'readonly');
    const prototype = Object.getPrototypeOf(
      transaction.objectStore(STORE_NAMES.syncReceipts),
    ) as IDBObjectStore;
    const original = prototype.add;
    const spy = vi.spyOn(prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === STORE_NAMES.syncReceipts) throw new Error('synthetic receipt failure');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    });
    await expect(
      test.sync.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]),
    ).rejects.toThrow('synthetic');
    spy.mockRestore();
    expect(await test.repository.listTaskCompletions()).toEqual([]);
    expect((await test.sync.wallet.load()).balance).toBe(0);
    expect(
      (await test.sync.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]))[0]?.reward,
    ).toBe(5);
  });
});

describe('backup version nine and epoch protection', () => {
  it.each(['tasks', 'all'] as const)(
    'preserves local mixed +2/+5/unknown grant provenance across %s replacement without restoring wallet',
    async (kind) => {
      const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 22, totalEarned: 22 });
      await test.sync.ensureWallet();
      await routine(test.repository, 'old-two');
      await routine(test.repository, 'new-five');
      await routine(test.repository, 'unknown');
      await test.repository.completeTaskForDate('old-two', '2026-10-12');
      await test.repository.completeTaskForDate('unknown', '2026-10-13');
      await test.sync.changeTaskCompletionAtomic('new-five', '2026-10-13', true, now);
      const tx = (await test.repository.open()).transaction(
        STORE_NAMES.occurrenceRevisions,
        'readwrite',
      );
      const done = transactionComplete(tx);
      tx.objectStore(STORE_NAMES.occurrenceRevisions).put({
        taskId: 'old-two',
        date: '2026-10-12',
        revision: 'old-grant',
        rewarded: true,
      });
      tx.objectStore(STORE_NAMES.occurrenceRevisions).delete(['unknown', '2026-10-13']);
      await done;
      const before = await test.sync.getSnapshot(timeZone);
      if (kind === 'tasks')
        await test.repository.importTasks(await test.repository.exportTasks(), 'replace');
      else {
        const backup = await test.repository.exportData();
        // Incoming metadata belongs to another wallet state and must not overwrite local proof.
        for (const row of backup.sync!.occurrenceRevisions) {
          row.rewarded = true;
          row.rewardAmount = 99;
        }
        await test.repository.importData(backup, 'replace', { restoreWallet: false });
      }
      expect(await test.sync.getEpoch()).not.toBe(before.epoch);
      expect((await test.sync.wallet.load()).balance).toBe(27);
      expect(
        (await test.sync.changeTaskCompletionAtomic('new-five', '2026-10-13', false, now)).reward
          ?.reward,
      ).toBe(5);
      expect(
        (await test.sync.changeTaskCompletionAtomic('old-two', '2026-10-12', false, now)).reward
          ?.reward,
      ).toBe(2);
      const unknownUndo = await test.sync.changeTaskCompletionAtomic(
        'unknown',
        '2026-10-13',
        false,
        now,
      );
      expect(unknownUndo.reward).toBeNull();
      expect(unknownUndo.warning).toContain('历史奖励金额无法确认');
      const unknownRedo = await test.sync.changeTaskCompletionAtomic(
        'unknown',
        '2026-10-13',
        true,
        now,
      );
      expect(unknownRedo.reward).toBeNull();
      expect(unknownRedo.warning).toContain('历史奖励金额无法确认');
      expect((await test.sync.wallet.load()).balance).toBe(20);
    },
  );

  it.each(['tasks', 'all', 'clear'] as const)(
    'does not repay an outstanding grant when %s replacement omits its completion',
    async (kind) => {
      const test = fixture();
      await routine(test.repository);
      await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now);
      const oldEpoch = await test.sync.getEpoch();
      if (kind === 'tasks') {
        const backup = await test.repository.exportTasks();
        await test.repository.importTasks({ ...backup, taskCompletions: [] }, 'replace');
      } else {
        const backup = await test.repository.exportData();
        if (kind === 'clear') await test.repository.clearAll();
        await test.repository.importData({ ...backup, taskCompletions: [] }, 'replace');
      }
      const snapshot = await test.sync.getSnapshot(timeZone);
      expect(snapshot.epoch).not.toBe(oldEpoch);
      expect(snapshot.completions).toHaveLength(0);
      expect(snapshot.wallet.balance).toBe(5);
      expect(
        (
          await test.sync.applyOperations(snapshot.epoch, 'phone', [
            completion(snapshot, 'after-restore'),
          ])
        )[0],
      ).toMatchObject({ status: 'applied', reward: 0 });
      expect((await test.sync.wallet.load()).balance).toBe(5);
      expect(
        (await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', false, now)).reward
          ?.reward,
      ).toBe(5);
      expect((await test.sync.wallet.load()).balance).toBe(0);
    },
  );

  it('keeps unknown legacy tombstones through clear and warns rather than granting or reversing money', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 20, totalEarned: 20 });
    await test.sync.ensureWallet();
    await routine(test.repository);
    await test.repository.completeTaskForDate('task-one', '2026-10-13');
    const tx = (await test.repository.open()).transaction(
      STORE_NAMES.occurrenceRevisions,
      'readwrite',
    );
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.occurrenceRevisions).clear();
    await done;
    const backup = await test.repository.exportTasks();
    await test.repository.clearAll();
    await test.repository.importTasks({ ...backup, taskCompletions: [] }, 'replace');
    const snapshot = await test.sync.getSnapshot(timeZone);
    const [receipt] = await test.sync.applyOperations(snapshot.epoch, 'phone', [
      completion(snapshot),
    ]);
    expect(receipt).toMatchObject({ status: 'applied', reward: 0 });
    expect(receipt?.message).toContain('历史奖励金额无法确认');
    const undo = await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', false, now);
    expect(undo.reward).toBeNull();
    expect(undo.warning).toContain('历史奖励金额无法确认');
    expect((await test.sync.wallet.load()).balance).toBe(20);
    expect(
      (await test.repository.exportData()).sync?.occurrenceRevisions[0]?.rewardAmount,
    ).toBeNull();
  });

  it('retains old +2 grants in backup/restore and never reverses them at the new +5 rate', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 12, totalEarned: 12 });
    await test.sync.ensureWallet();
    await routine(test.repository);
    await test.repository.completeTaskForDate('task-one', '2026-10-12');
    const tx = (await test.repository.open()).transaction(
      STORE_NAMES.occurrenceRevisions,
      'readwrite',
    );
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.occurrenceRevisions).put({
      taskId: 'task-one',
      date: '2026-10-12',
      revision: 'old-grant',
      rewarded: true,
    });
    await done;
    const backup = await test.repository.exportData();
    expect(backup.wallet?.balance).toBe(12);
    expect(backup.sync?.occurrenceRevisions[0]?.rewardAmount).toBe(2);
    const directUndo = await test.sync.changeTaskCompletionAtomic(
      'task-one',
      '2026-10-12',
      false,
      now,
    );
    expect(directUndo.reward?.reward).toBe(2);
    expect((await test.sync.wallet.load()).balance).toBe(10);
    // Simulate a v9 backup made by the previous release, without the amount field.
    delete backup.sync!.occurrenceRevisions[0]!.rewardAmount;
    await test.repository.importData(backup, 'replace', { restoreWallet: true });
    const result = await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-12', false, now);
    expect(result.reward?.reward).toBe(2);
    expect(await test.sync.wallet.load()).toMatchObject({
      balance: 10,
      totalEarned: 10,
      totalSpent: 0,
    });
    expect((await test.sync.wallet.load()).ledger[0]?.amount).toBe(2);
  });

  it('validates explicit historical reward amounts and preserves unknown legacy metadata', () => {
    const base = {
      receipts: [],
      taskRevisions: [],
      occurrenceRevisions: [
        { taskId: 't', date: '2026-10-12', revision: 'legacy', rewarded: null },
      ],
    };
    expect(readSyncBackup(base).occurrenceRevisions[0]?.rewardAmount).toBeNull();
    for (const rewardAmount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5', 0, null]) {
      expect(() =>
        readSyncBackup({
          ...base,
          occurrenceRevisions: [{ ...base.occurrenceRevisions[0], rewarded: true, rewardAmount }],
        }),
      ).toThrow();
    }
  });

  it('does not convert an unproven legacy historical completion into a grant during merge', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 20, totalEarned: 20 });
    await test.sync.ensureWallet();
    await routine(test.repository);
    await test.repository.completeTaskForDate('task-one', '2026-10-12');
    const tx = (await test.repository.open()).transaction(
      STORE_NAMES.occurrenceRevisions,
      'readwrite',
    );
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.occurrenceRevisions).clear();
    await done;
    await test.repository.importTasks(await test.repository.exportTasks(), 'merge');
    const backup = await test.repository.exportData();
    expect(backup.sync?.occurrenceRevisions[0]?.rewarded).toBeNull();
    await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-12', false, now);
    expect((await test.sync.wallet.load()).balance).toBe(20);
  });

  it('exports wallet/receipts, keeps wallet on merge/old replace, and restores it only explicitly', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    await test.sync.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]);
    const backup = await test.repository.exportData();
    expect(backup.schemaVersion).toBe(11);
    expect(backup.wallet?.balance).toBe(5);
    expect(backup.sync?.occurrenceRevisions[0]?.rewardAmount).toBe(5);
    expect(backup.sync?.receipts).toHaveLength(1);
    await test.sync.wallet.update((state) => ({
      state: { ...state, balance: 100, totalEarned: 100 },
      result: undefined,
    }));
    await test.repository.importData(backup, 'merge');
    expect((await test.sync.wallet.load()).balance).toBe(100);
    await test.repository.importData(backup, 'replace', { restoreWallet: true });
    expect((await test.sync.wallet.load()).balance).toBe(5);
    const restoredEpoch = await test.sync.getEpoch();
    expect(restoredEpoch).not.toBe(snapshot.epoch);
    await expect(
      test.sync.applyOperations(snapshot.epoch, 'phone', [completion(snapshot)]),
    ).rejects.toThrow('EPOCH_CHANGED');
    const old = { ...backup, schemaVersion: 8, wallet: undefined, sync: undefined };
    await test.repository.importData(old, 'replace');
    expect((await test.sync.wallet.load()).balance).toBe(5);
    await expect(
      test.repository.importData(old, 'replace', { restoreWallet: true }),
    ).rejects.toThrow('版本 9');
  });

  it('preserves wallet through clear and rejects old outboxes after task-only replacement', async () => {
    const test = fixture({ ...DEFAULT_ALLOWANCE, balance: 31, totalEarned: 31 });
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const backup = await test.repository.exportTasks();
    await test.repository.importTasks(backup, 'replace');
    expect(await test.sync.getEpoch()).not.toBe(snapshot.epoch);
    const epoch = await test.sync.getEpoch();
    await test.repository.clearAllData();
    expect(await test.sync.getEpoch()).not.toBe(epoch);
    expect((await test.sync.wallet.load()).balance).toBe(31);
    expect(await test.repository.listTasks()).toEqual([]);
  });

  it.each(['all', 'tasks'] as const)(
    'retains real reward metadata when merging its own %s backup',
    async (mode) => {
      const test = fixture();
      await routine(test.repository);
      await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now);
      if (mode === 'all')
        await test.repository.importData(await test.repository.exportData(), 'merge');
      else await test.repository.importTasks(await test.repository.exportTasks(), 'merge');
      await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', false, now);
      expect((await test.sync.wallet.load()).balance).toBe(0);
      await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now);
      expect((await test.sync.wallet.load()).balance).toBe(5);
    },
  );
});

describe('desktop skip and restore', () => {
  const occurrenceOf = (snapshot: SyncSnapshot) =>
    snapshot.occurrences.find((row) => row.taskId === 'task-one' && row.date === '2026-10-13');

  it('writes no task row, moves only the occurrence revision, and moves no money', async () => {
    const test = fixture();
    await routine(test.repository);
    const before = await test.sync.getSnapshot(timeZone);
    const taskBefore = (await test.repository.listTasks())[0];
    expect(
      await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now),
    ).toEqual({ changed: true });
    const after = await test.sync.getSnapshot(timeZone);
    expect((await test.repository.listTasks())[0]).toEqual(taskBefore);
    expect(after.tasks[0]?.revision).toBe(before.tasks[0]?.revision);
    expect(occurrenceOf(after)?.revision).not.toBe(occurrenceOf(before)?.revision ?? null);
    expect(after.taskSkips.map((row) => row.date)).toEqual(['2026-10-13']);
    expect((await test.sync.wallet.load()).balance).toBe(0);
    expect((await test.repository.getHomeTaskOverview('2026-10-13')).today).toEqual([]);
  });

  it('reports a repeat as unchanged, and restore then complete pays +5 exactly once', async () => {
    const test = fixture();
    await routine(test.repository);
    await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now);
    expect(
      await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now),
    ).toEqual({ changed: false });
    await expect(
      test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now),
    ).rejects.toThrow();
    expect(
      await test.sync.changeTaskSkipAtomic('restore-task', 'task-one', '2026-10-13', now),
    ).toEqual({ changed: true });
    expect(
      await test.sync.changeTaskSkipAtomic('restore-task', 'task-one', '2026-10-13', now),
    ).toEqual({ changed: false });
    const done = await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now);
    expect(done.reward?.reward).toBe(5);
    expect((await test.sync.wallet.load()).balance).toBe(5);
  });

  it('refuses a one-off, a finished occurrence, another date and a missing task', async () => {
    const test = fixture();
    await routine(test.repository);
    const oneOff = await test.repository.createTask({
      title: 'once',
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-13',
    });
    await expect(
      test.sync.changeTaskSkipAtomic('skip-task', oneOff.id, '2026-10-13', now),
    ).rejects.toThrow();
    await expect(
      test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-12', now),
    ).rejects.toThrow();
    await expect(
      test.sync.changeTaskSkipAtomic('skip-task', 'missing', '2026-10-13', now),
    ).rejects.toThrow('任务不存在。');
    await test.sync.changeTaskCompletionAtomic('task-one', '2026-10-13', true, now);
    await expect(
      test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now),
    ).rejects.toThrow();
    expect((await test.sync.getSnapshot(timeZone)).taskSkips).toEqual([]);
  });

  it('turns a queued phone completion into a conflict with no reward', async () => {
    const test = fixture();
    await routine(test.repository);
    const snapshot = await test.sync.getSnapshot(timeZone);
    const queued = completion(snapshot);
    await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now);
    const [receipt] = await test.sync.applyOperations(snapshot.epoch, 'phone', [queued]);
    expect(receipt?.status).toBe('conflict');
    expect((await test.sync.wallet.load()).balance).toBe(0);
    expect(await test.repository.listTaskCompletions()).toEqual([]);
  });

  it('lets the phone restore a desktop skip with the fresh revision', async () => {
    const test = fixture();
    await routine(test.repository);
    await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now);
    const fresh = await test.sync.getSnapshot(timeZone);
    const [receipt] = await test.sync.applyOperations(fresh.epoch, 'phone', [
      {
        id: 'phone-restore',
        kind: 'restore-task',
        at: now.toISOString(),
        date: '2026-10-13',
        timeZone,
        taskId: 'task-one',
        taskRevision: fresh.tasks[0]!.revision,
        occurrenceDate: '2026-10-13',
        occurrenceRevision: occurrenceOf(fresh)?.revision ?? null,
      },
    ]);
    expect(receipt?.status).toBe('applied');
    expect((await test.sync.getSnapshot(timeZone)).taskSkips).toEqual([]);
  });

  it('lists the skip on the desktop overview for its own day only', async () => {
    const test = fixture();
    await routine(test.repository);
    await test.sync.changeTaskSkipAtomic('skip-task', 'task-one', '2026-10-13', now);
    const today = await test.repository.getHomeTaskOverview('2026-10-13');
    expect(today.skipped?.map((row) => row.task.id)).toEqual(['task-one']);
    expect((await test.repository.getHomeTaskOverview('2026-10-14')).skipped).toEqual([]);
  });
});
