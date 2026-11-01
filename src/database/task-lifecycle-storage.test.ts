// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { WalletRepository, readAllowanceState } from './wallet';
import { STORE_NAMES, runMigrations } from './migrations';
import { requestResult, transactionComplete } from './idb';
import {
  DEFAULT_ALLOWANCE,
  applyTaskCompletionReward,
  applyTaskCompletionReversal,
  normalizeAllowance,
  spendAllowance,
} from '../shared/allowance';
import type { TaskSkip } from '../models/daily-task';
import { seedHistoricalTask } from '../testing/historical-task';

const now = new Date('2026-10-16T12:00:00.000Z');
const skip: TaskSkip = { taskId: 'routine', date: '2026-10-16', skippedAt: now.toISOString() };
const opened: ValRecallRepository[] = [];
function fixture(factory = new IDBFactory()) {
  const repo = new ValRecallRepository({
    indexedDBFactory: factory,
    databaseName: 'lifecycle-storage',
    clock: () => now,
  });
  opened.push(repo);
  return repo;
}
async function seed(repo: ValRecallRepository) {
  await seedHistoricalTask(repo, now, skip.taskId, 'Synthetic routine');
  const tx = (await repo.open()).transaction(STORE_NAMES.taskSkips, 'readwrite');
  const done = transactionComplete(tx);
  tx.objectStore(STORE_NAMES.taskSkips).put(skip);
  await done;
}
afterEach(() => {
  for (const repo of opened.splice(0)) repo.close();
});

describe('signed wallet compatibility', () => {
  it('reverses the full reward and naturally offsets debt with later earnings', () => {
    const reversed = applyTaskCompletionReversal(
      { ...DEFAULT_ALLOWANCE, balance: 2, totalEarned: 5 },
      '2026-10-16',
    );
    expect(reversed.state).toMatchObject({ balance: -3, totalEarned: 0, totalSpent: 0 });
    expect(reversed.state.ledger[0]).toMatchObject({ amount: 5, balanceAfter: -3 });
    expect(normalizeAllowance(reversed.state)).toEqual(reversed.state);
    expect(readAllowanceState(reversed.state)).toEqual(reversed.state);
    expect(spendAllowance(reversed.state, 1).ok).toBe(false);
    expect(applyTaskCompletionReward(reversed.state, '2026-10-17').state.balance).toBe(2);
  });

  it('upgrades the authoritative v1 wallet without consulting stale preferences or replaying a truncated ledger', async () => {
    const factory = new IDBFactory();
    const request = factory.open('lifecycle-storage', 4);
    request.onupgradeneeded = () => runMigrations(request.result, request.transaction!, 0, 4);
    const oldDb = await requestResult(request);
    const old = {
      ...DEFAULT_ALLOWANCE,
      schemaVersion: 1,
      balance: 123,
      totalEarned: 500,
      totalSpent: 377,
      ledgerSeq: 999,
    };
    const tx = oldDb.transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({ key: 'state', value: old });
    await done;
    oldDb.close();
    const repo = fixture(factory);
    const loader = vi.fn(async () => {
      throw new Error('must not read legacy');
    });
    const wallet = new WalletRepository(repo, loader);
    expect(await wallet.load()).toEqual({ ...old, schemaVersion: 2 });
    expect((await repo.open()).version).toBe(6);
    await wallet.load();
    expect(loader).not.toHaveBeenCalled();
    const read = (await repo.open()).transaction(STORE_NAMES.wallet, 'readonly');
    expect(await requestResult(read.objectStore(STORE_NAMES.wallet).get('state'))).toEqual({
      key: 'state',
      value: { ...old, schemaVersion: 2 },
    });
    await transactionComplete(read);
    repo.close();
    await expect(requestResult(factory.open('lifecycle-storage', 4))).rejects.toMatchObject({
      name: 'VersionError',
    });
  });

  it.each([-1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid signed money %s',
    (balance) => {
      expect(() => readAllowanceState({ ...DEFAULT_ALLOWANCE, balance })).toThrow();
    },
  );
  it('rejects negative legacy balances and unknown versions instead of reinterpreting corruption', () => {
    expect(() =>
      readAllowanceState({ ...DEFAULT_ALLOWANCE, schemaVersion: 1, balance: -1 }),
    ).toThrow();
    expect(() => readAllowanceState({ ...DEFAULT_ALLOWANCE, schemaVersion: 3 })).toThrow();
    expect(() => readAllowanceState({ ...DEFAULT_ALLOWANCE, totalSpent: -1 })).toThrow();
  });
});

describe('independent skip and wallet backups', () => {
  it('round trips signed wallet and skips in v10; restoration of skips is independent of wallet choice', async () => {
    const repo = fixture();
    await seed(repo);
    const wallet = new WalletRepository(repo, async () => undefined);
    await wallet.update((state) => ({
      state: applyTaskCompletionReversal({ ...state, balance: 2, totalEarned: 5 }, '2026-10-16')
        .state,
      result: undefined,
    }));
    const backup = await repo.exportData();
    expect(backup.schemaVersion).toBe(11);
    expect(backup.taskSkips).toEqual([skip]);
    expect(backup.wallet?.balance).toBe(-3);
    await wallet.update((state) => ({ state: { ...state, balance: 10 }, result: undefined }));
    await repo.importData(backup, 'replace', { restoreWallet: false });
    expect((await wallet.load()).balance).toBe(10);
    expect((await repo.exportTasks()).taskSkips).toEqual([skip]);
    await repo.importData(backup, 'replace', { restoreWallet: true });
    expect(await wallet.load()).toEqual(backup.wallet);
    expect((await repo.exportTasks()).taskSkips).toEqual([skip]);
  });

  it('reads legacy v9 and task v1 without skips and never infers money from completion history', async () => {
    const repo = fixture();
    await seed(repo);
    const backup = await repo.exportData();
    await repo.importData(
      {
        ...backup,
        schemaVersion: 9,
        taskSkips: undefined,
        wallet: { ...backup.wallet, schemaVersion: 1 },
      },
      'replace',
      { restoreWallet: true },
    );
    expect((await repo.exportTasks()).taskSkips).toEqual([]);
    const tasks = await repo.exportTasks();
    await repo.importTasks({ ...tasks, schemaVersion: 1, taskSkips: undefined }, 'replace');
    expect((await repo.exportTasks()).taskSkips).toEqual([]);
    expect((await repo.exportData()).wallet?.balance).toBe(0);
  });

  it('preserves skips in task-only export v2 and clears them only with an explicit replacement or deletion', async () => {
    const repo = fixture();
    await seed(repo);
    const backup = await repo.exportTasks();
    expect(backup.schemaVersion).toBe(2);
    await repo.importTasks(backup, 'replace');
    expect(await repo.exportTasks()).toEqual(backup);
    await repo.deleteTask(skip.taskId);
    expect((await repo.exportTasks()).taskSkips).toEqual([]);
  });

  it('rejects conflicting merged completion/skip states atomically and keeps the local state', async () => {
    const repo = fixture();
    await seed(repo);
    const backup = await repo.exportTasks();
    const conflicting = {
      ...backup,
      taskSkips: [],
      taskCompletions: [
        { id: 'done', taskId: skip.taskId, localDate: skip.date, completedAt: now.toISOString() },
      ],
    };
    await expect(repo.importTasks(conflicting)).rejects.toThrow('冲突');
    expect(await repo.exportTasks()).toEqual(backup);
    const full = await repo.exportData();
    await expect(repo.importData({ ...full, ...conflicting, schemaVersion: 10 })).rejects.toThrow(
      '冲突',
    );
    expect((await repo.exportTasks()).taskSkips).toEqual([skip]);
  });

  it('rejects orphan, duplicate and contradictory skip records before any writes', async () => {
    const repo = fixture();
    await seed(repo);
    const backup = await repo.exportTasks();
    for (const taskSkips of [[{ ...skip, taskId: 'missing' }], [skip, skip]]) {
      await expect(repo.importTasks({ ...backup, taskSkips }, 'replace')).rejects.toThrow();
    }
    await expect(
      repo.importTasks(
        {
          ...backup,
          taskCompletions: [
            {
              id: 'done',
              taskId: skip.taskId,
              localDate: skip.date,
              completedAt: now.toISOString(),
            },
          ],
        },
        'replace',
      ),
    ).rejects.toThrow();
    expect(await repo.exportTasks()).toEqual(backup);
  });
});
