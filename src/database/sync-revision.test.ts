// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { SyncRepository } from './sync-repository';
import { bumpContentRevision } from './sync-revision';
import { STORE_NAMES } from './migrations';
import { transactionComplete } from './idb';
import { DesktopSyncService } from '../sync/service';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';

const repos: ValRecallRepository[] = [];
const zone = 'Europe/London';
const now = new Date('2026-10-17T12:00:00Z');
async function setup() {
  const repo = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'revision',
    clock: () => now,
  });
  repos.push(repo);
  const sync = new SyncRepository(repo, {
    clock: () => now,
    legacyLoader: async () => DEFAULT_ALLOWANCE,
  });
  await sync.getEpoch();
  return { repo, sync, state: () => sync.getChangeState(zone) };
}
afterEach(() => {
  for (const r of repos.splice(0)) r.close();
  vi.restoreAllMocks();
});

describe('transactional content revision', () => {
  it('reports corrupt durable data as action-required rather than a transient outage', async () => {
    const f = await setup();
    const epoch = (await f.state()).epoch;
    const tx = (await f.repo.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.wallet).put({
      key: 'state',
      value: { schemaVersion: 2, balance: 'invalid' },
    });
    await done;
    const service = new DesktopSyncService(f.sync);
    expect(
      await service.handle('phone', { version: 2, type: 'pull', epoch, token: null, cursor: 0 }),
    ).toMatchObject({ type: 'error', code: 'INVALID_DATA' });
    const corrupt = (await f.repo.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const corruptDone = transactionComplete(corrupt);
    corrupt.objectStore(STORE_NAMES.wallet).put({ key: 'contentRevision', value: 'invalid token' });
    await corruptDone;
    expect(
      await service.handle('phone', { version: 2, type: 'change-state', epoch }),
    ).toMatchObject({ type: 'error', code: 'INVALID_DATA' });
  });
  it('checks two small rows without writes, snapshots, sequence or wallet reads', async () => {
    const f = await setup();
    const db = await f.repo.open();
    const transactions = vi.spyOn(db, 'transaction');
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const service = new DesktopSyncService(f.sync);
    const getEpoch = vi.spyOn(f.sync, 'getEpoch');
    const getSnapshot = vi.spyOn(f.sync, 'getSnapshot');
    const baseline = await f.state();
    transactions.mockClear();
    get.mockClear();
    for (let i = 0; i < 3; i++)
      expect(
        await service.handle('phone', { version: 2, type: 'change-state', epoch: baseline.epoch }),
      ).toMatchObject(baseline);
    expect(
      transactions.mock.calls.every(
        (args) => args[0] === STORE_NAMES.wallet && args[1] === 'readonly',
      ),
    ).toBe(true);
    expect(get.mock.calls.map((args) => args[0])).toEqual(
      Array(3).fill(['epoch', 'contentRevision']).flat(),
    );
    expect(getAll).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(getEpoch).not.toHaveBeenCalled();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('moves with tasks, completions, wallet and restore, but not reads or no-op rewards', async () => {
    const f = await setup();
    let previous = await f.state();
    const changed = async () => {
      const next = await f.state();
      expect(next.contentRevision).not.toBe(previous.contentRevision);
      previous = next;
    };
    const task = await f.repo.createTask({
      title: 'Synthetic task',
      kind: 'routine',
      recurrence: 'daily',
    });
    await changed();
    await f.repo.updateTask(task.id, { title: 'Updated task' });
    await changed();
    await f.repo.completeTaskForDate(task.id, '2026-10-17');
    await changed();
    await f.repo.undoTaskCompletion(task.id, '2026-10-17');
    await changed();
    await f.sync.wallet.update((state) => ({ state: { ...state, balance: 10 }, result: null }));
    await changed();
    await f.sync.wallet.update((state) => ({ state, result: null }));
    expect(await f.state()).toEqual(previous);
    const snapshot = await f.sync.getSnapshot(zone);
    const second = await f.sync.getSnapshot(zone);
    expect(second.sequence).toBe(snapshot.sequence + 1);
    expect(snapshot.contentRevision).toBe(previous.contentRevision);
    expect(await f.state()).toEqual(previous);
    await f.repo.deleteTask(task.id);
    await changed();
    const backup = await f.repo.exportTasks();
    await f.repo.importTasks(backup, 'replace');
    await changed();
    expect((await f.state()).epoch).not.toBe(snapshot.epoch);
  });

  it('rolls back the marker with the transaction and keeps snapshot content coherent', async () => {
    const f = await setup();
    const task = await f.repo.createTask({ title: 'Before', kind: 'routine', recurrence: 'daily' });
    const before = await f.state();
    const tx = (await f.repo.open()).transaction(
      [STORE_NAMES.wallet, STORE_NAMES.dailyTasks],
      'readwrite',
    );
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.dailyTasks).put({ ...task, title: 'Aborted' });
    bumpContentRevision(tx);
    tx.abort();
    await done.catch(() => undefined);
    expect(await f.state()).toEqual(before);
    const pulling = f.sync.getSnapshot(zone);
    const updating = f.repo.updateTask(task.id, { title: 'After' });
    const snap = await pulling;
    await updating;
    const after = await f.state();
    expect(snap.tasks[0]?.task.title).toBe(
      snap.contentRevision === after.contentRevision ? 'After' : 'Before',
    );
    expect((await f.sync.getSnapshot(zone)).contentRevision).toBe(after.contentRevision);
  });
});
