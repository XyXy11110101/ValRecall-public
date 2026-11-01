// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import {
  MobileRepository,
  mobileTaskProjection,
  mobileAvailableBalance,
} from '../database/mobile-repository';
import { STORE_NAMES } from '../database/migrations';
import { SYNC_SEQUENCE_KEY } from '../database/wallet';
import { requestResult, transactionComplete } from '../database/idb';
import { SyncClient } from '../mobile/sync-client';
import { computerTimeZone } from './protocol';
import { DesktopSyncService } from './service';
import type { SyncOperation, SyncRequest } from './contracts';

const connections: { close(): void }[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.close();
});
async function fixture() {
  // Noon on the computer's own calendar in the computer's own zone, as the sync service reports it,
  // so the dates below hold in every zone. The test about a zone change sets its own.
  let time = new Date(2026, 9, 16, 12);
  let lose = false;
  let zone = computerTimeZone();
  const desktop = new ValRecallRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'v2-desktop',
    clock: () => time,
  });
  const mobileFactory = new IDBFactory();
  const mobile = new MobileRepository({
    indexedDBFactory: mobileFactory,
    databaseName: 'v2-phone',
    clock: () => time,
  });
  connections.push(desktop, mobile);
  const domain = new SyncRepository(desktop, {
    clock: () => time,
    legacyLoader: async () => undefined,
  });
  const epoch = await domain.getEpoch();
  const service = new DesktopSyncService(
    domain,
    () => time.getTime(),
    () => zone,
  );
  const requests: SyncRequest[] = [];
  const client = new SyncClient(mobile, {
    pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch }),
    request: async (request) => {
      requests.push(request);
      const response = await service.handle('phone', JSON.parse(JSON.stringify(request)));
      if (lose && request.type === 'push') {
        lose = false;
        throw new Error('lost response');
      }
      return response;
    },
  });
  await client.sync();
  return {
    desktop,
    domain,
    mobile,
    mobileFactory,
    client,
    service,
    epoch,
    requests,
    setZone: (value: string) => {
      zone = value;
    },
    setTime: (at: string) => {
      time = new Date(at);
    },
    lose: () => {
      lose = true;
    },
    create: async (recurrence: 'daily' | 'specific_date' = 'daily', scheduledDate?: string) => {
      const row = await mobile.createTask({
        title: 'Synthetic task',
        recurrence,
        ...(scheduledDate ? { scheduledDate } : {}),
      });
      if (row.operation.kind !== 'create-task') throw new Error('fixture');
      return row.operation.task;
    },
  };
}

describe('v2 lifecycle and ordering integration', () => {
  it('preserves offline day keys across midnight, DST fallback and a later computer-zone change', async () => {
    const f = await fixture();
    f.setZone('Europe/London');
    await f.client.sync();
    f.setTime('2026-10-24T22:59:00Z');
    const task = await f.create();
    await f.mobile.enqueueCompletion(task.id);
    f.setTime('2026-10-24T23:01:00Z');
    await f.mobile.enqueueCompletion(task.id);
    f.setTime('2026-10-25T01:30:00Z');
    await f.mobile.enqueueCompletion(task.id);
    expect(
      (await f.mobile.load()).outbox.filter((row) => row.operation.kind === 'complete-task'),
    ).toHaveLength(2);
    f.setTime('2026-10-28T10:00:00Z');
    f.setZone('America/New_York');
    await f.client.sync();
    expect((await f.domain.wallet.load()).balance).toBe(15); // creation5 + two completions10
    expect((await f.desktop.listTaskCompletions()).map((row) => row.localDate).sort()).toEqual([
      '2026-10-24',
      '2026-10-25',
    ]);
    expect((await f.mobile.load()).snapshot?.timeZone).toBe('America/New_York');
    await f.mobile.enqueueTaskAction('undo-task', task.id, '2026-10-24');
    await f.client.sync();
    expect((await f.domain.wallet.load()).balance).toBe(10);
    expect((await f.desktop.listTaskCompletions())[0]?.localDate).toBe('2026-10-25');
  });

  it('cannot remint a one-off reward by moving a retained paid tombstone to another date', async () => {
    const f = await fixture();
    const task = await f.create('specific_date', '2026-10-13');
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    const backup = await f.desktop.exportData();
    await f.desktop.importData({ ...backup, taskCompletions: [] }, 'replace', {
      restoreWallet: false,
    });
    await f.desktop.updateTask(task.id, { scheduledDate: '2026-10-16' });
    await expect(
      f.domain.changeTaskCompletionAtomic(task.id, '2026-10-16', true, new Date(2026, 9, 16, 12)),
    ).rejects.toThrow('历史结算');
    expect((await f.domain.wallet.load()).balance).toBe(10);
  });

  it('keeps snapshot counters out of backups and restarts them only under a restored epoch', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    const before = await f.domain.getSnapshot('Europe/London');
    const backup = await f.desktop.exportData();
    expect(JSON.stringify(backup)).not.toContain(SYNC_SEQUENCE_KEY);
    await f.desktop.importData(backup, 'replace', { restoreWallet: true });
    const after = await f.domain.getSnapshot('Europe/London');
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.sequence).toBe(1);
    expect(after.wallet.balance).toBe(10);
  });
  it('completes an overdue one-off on the actual day, deduplicates PC completion and preserves its original date', async () => {
    const f = await fixture();
    const task = await f.create('specific_date', '2026-10-13');
    const row = await f.mobile.enqueueCompletion(task.id);
    expect(row.operation).toMatchObject({ date: '2026-10-16', occurrenceDate: '2026-10-13' });
    await f.client.sync();
    expect((await f.domain.wallet.load()).ledger[0]).toMatchObject({
      amount: 5,
      date: '2026-10-16',
    });
    expect(await f.desktop.getTask(task.id)).toMatchObject({ scheduledDate: '2026-10-13' });
    expect(await f.desktop.listTaskCompletions()).toHaveLength(1);
    await f.desktop.updateTask(task.id, { scheduledDate: '2026-10-16' });
    await f.domain.changeTaskCompletionAtomic(
      task.id,
      '2026-10-16',
      true,
      new Date(2026, 9, 16, 12),
    );
    expect((await f.domain.wallet.load()).balance).toBe(10);
    expect(await f.desktop.listTaskCompletions()).toHaveLength(1);
  });

  it('undoes never-sent completion locally, and compensates an uncertain committed completion without duplication', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.mobile.enqueueCompletion(task.id);
    await f.mobile.enqueueTaskAction('undo-task', task.id, '2026-10-16');
    expect((await f.mobile.load()).outbox).toHaveLength(1);
    await f.mobile.enqueueCompletion(task.id);
    f.lose();
    await expect(f.client.sync()).rejects.toThrow();
    expect((await f.domain.wallet.load()).balance).toBe(10);
    await f.mobile.enqueueTaskAction('undo-task', task.id, '2026-10-16');
    expect(mobileTaskProjection(await f.mobile.load()).completions).toEqual([]);
    f.lose();
    await expect(f.client.sync()).rejects.toThrow();
    expect((await f.domain.wallet.load()).balance).toBe(5); // undo only reverses completion
    await f.client.sync();
    expect((await f.domain.wallet.load()).balance).toBe(5);
    expect((await f.mobile.load()).outbox).toEqual([]);
    expect(await f.desktop.listTaskCompletions()).toEqual([]);
  });

  it('reserves pending reversals, creates exact debt and offsets it with subsequent income', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    await f.mobile.enqueueSpend(8); // spend the creation5 as well to exercise the same debt
    await f.client.sync();
    await f.mobile.enqueueTaskAction('undo-task', task.id, '2026-10-16');
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(0);
    await expect(f.mobile.enqueueSpend(1)).rejects.toThrow();
    await f.client.sync();
    expect((await f.mobile.load()).snapshot?.wallet.balance).toBe(-3);
    await expect(f.mobile.enqueueSpend(1)).rejects.toThrow();
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    expect((await f.domain.wallet.load()).balance).toBe(2);
    expect((await f.domain.wallet.load()).totalSpent).toBe(8);
  });

  it('skips/restores one recurring occurrence, retains it after a lost reply and leaves tomorrow untouched', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.client.sync();
    await f.mobile.enqueueTaskAction('cancel-task', task.id);
    await f.mobile.enqueueTaskAction('restore-task', task.id);
    expect((await f.mobile.load()).outbox).toEqual([]);
    await f.mobile.enqueueTaskAction('cancel-task', task.id);
    f.lose();
    await expect(f.client.sync()).rejects.toThrow();
    await f.client.sync();
    expect((await f.desktop.exportData()).taskSkips).toHaveLength(1);
    expect((await f.desktop.getTaskDaySummary('2026-10-16')).remaining).toBe(0);
    expect((await f.desktop.getTaskDaySummary('2026-10-17')).remaining).toBe(1);
    await f.mobile.enqueueTaskAction('restore-task', task.id);
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    expect((await f.desktop.exportData()).taskSkips).toEqual([]);
    expect((await f.domain.wallet.load()).balance).toBe(10);
  });

  it('archives only unfinished one-offs and never erases history or adjusts money implicitly', async () => {
    const f = await fixture();
    const unsent = await f.create('specific_date');
    await f.mobile.enqueueTaskAction('cancel-task', unsent.id);
    expect((await f.mobile.load()).outbox).toEqual([]);
    const task = await f.create('specific_date');
    await f.mobile.enqueueCompletion(task.id);
    await f.client.sync();
    await expect(f.mobile.enqueueTaskAction('cancel-task', task.id)).rejects.toThrow('撤销');
    await f.mobile.enqueueTaskAction('undo-task', task.id);
    await f.mobile.enqueueTaskAction('cancel-task', task.id);
    await f.client.sync();
    expect(await f.desktop.getTask(task.id)).toMatchObject({ archived: true });
    expect((await f.domain.wallet.load()).balance).toBe(5);
    expect((await f.domain.wallet.load()).ledger).toHaveLength(3);
    await f.desktop.archiveTask(task.id, false);
    expect(await f.desktop.getTask(task.id)).toMatchObject({ archived: false });
  });

  it('keeps stale skip/undo conflicts without overriding newer desktop actions', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.client.sync();
    await f.mobile.enqueueTaskAction('cancel-task', task.id);
    await f.domain.changeTaskCompletionAtomic(
      task.id,
      '2026-10-16',
      true,
      new Date(2026, 9, 16, 12, 1),
    );
    await f.client.sync();
    expect((await f.mobile.load()).outbox[0]?.status).toBe('conflict');
    expect((await f.domain.wallet.load()).balance).toBe(10);
    await f.mobile.enqueueTaskAction('undo-task', task.id);
    await f.desktop.updateTask(task.id, { title: 'Changed on PC' });
    await f.client.sync();
    expect((await f.mobile.load()).outbox.every((row) => row.status === 'conflict')).toBe(true);
    expect(await f.desktop.listTaskCompletions()).toHaveLength(1);
  });

  it('orders snapshots across clock rollback, concurrency and service restart; duplicate snapshots never clear acknowledgements', async () => {
    const f = await fixture();
    const before = (await f.mobile.load()).snapshot!;
    f.setTime('2025-01-01T00:00:00Z');
    const snapshots = await Promise.all([
      f.domain.getSnapshot('Europe/London'),
      f.domain.getSnapshot('Europe/London'),
    ]);
    expect(snapshots[0]!.sequence).toBe(before.sequence + 1);
    expect(snapshots[1]!.sequence).toBe(before.sequence + 2);
    await f.mobile.applySnapshot(snapshots[1]);
    await expect(f.mobile.applySnapshot(snapshots[0])).rejects.toThrow('较旧');
    const restarted = new SyncRepository(f.desktop);
    expect((await restarted.getSnapshot('Europe/London')).sequence).toBe(before.sequence + 3);
    const row = await f.mobile.createTask({ title: 'Pending ack', recurrence: 'daily' });
    await f.mobile.markAttempted(f.epoch, [row.id]);
    await f.mobile.recordReceipts(
      f.epoch,
      [row.id],
      [{ operationId: row.id, status: 'applied', reward: 0, walletDelta: 0, message: 'ok' }],
    );
    await f.mobile.applySnapshot(snapshots[1], [row.id]);
    expect((await f.mobile.load()).outbox).toHaveLength(1);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER, 'broken'])(
    'fails closed for corrupt/overflow sequence %s',
    async (value) => {
      const f = await fixture();
      const tx = (await f.desktop.open()).transaction(STORE_NAMES.wallet, 'readwrite');
      const done = transactionComplete(tx);
      tx.objectStore(STORE_NAMES.wallet).put({ key: SYNC_SEQUENCE_KEY, epoch: f.epoch, value });
      await done;
      await expect(f.domain.getSnapshot('Europe/London')).rejects.toThrow('序号');
      const read = (await f.desktop.open()).transaction(STORE_NAMES.wallet, 'readonly');
      expect(
        await requestResult(read.objectStore(STORE_NAMES.wallet).get(SYNC_SEQUENCE_KEY)),
      ).toMatchObject({ value });
    },
  );

  it('blocks mixed-version writes before attempting any queued operation', async () => {
    const f = await fixture();
    const task = await f.create();
    const operation = (await f.mobile.enqueueCompletion(task.id)).operation;
    expect(
      await f.service.handle('phone', {
        version: 1,
        type: 'push',
        epoch: f.epoch,
        operations: [operation],
      }),
    ).toMatchObject({ version: 1, type: 'error', code: 'INVALID_REQUEST' });
    const oldServer = new SyncClient(f.mobile, {
      pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch: f.epoch }),
      request: async () => ({ version: 1, type: 'error', code: 'INVALID_REQUEST', message: 'old' }),
    });
    await expect(oldServer.sync()).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' });
    expect((await f.mobile.load()).outbox.every((row) => !row.attempted)).toBe(true);
    expect(await f.desktop.listTaskCompletions()).toEqual([]);
  });

  it('loads v1 cache/archives and replays the same legacy operation fingerprint after an update without losing receipts', async () => {
    const f = await fixture();
    const task = await f.create();
    await f.client.sync();
    const snapshot = (await f.mobile.load()).snapshot!;
    const op: SyncOperation = {
      id: 'legacy-completion',
      kind: 'complete-task',
      at: '2026-10-16T12:00:00.000Z',
      taskId: task.id,
      date: '2026-10-16',
      timeZone: 'Europe/London',
      taskRevision: snapshot.tasks[0]!.revision,
      occurrenceRevision: null,
    };
    await f.domain.applyOperations(f.epoch, 'phone', [op]);
    const legacyFactory = new IDBFactory();
    const request = legacyFactory.open('legacy-phone', 1);
    request.onupgradeneeded = () => {
      for (const store of ['state', 'outbox', 'archives'])
        request.result.createObjectStore(store, { keyPath: 'id' });
    };
    const db = await requestResult(request);
    const tx = db.transaction(['state', 'outbox', 'archives'], 'readwrite');
    const done = transactionComplete(tx);
    const legacy = {
      ...snapshot,
      version: 1,
      sequence: undefined,
      taskSkips: undefined,
      wallet: { ...snapshot.wallet, schemaVersion: 1 },
    };
    tx.objectStore('state').put({
      id: 'current',
      epoch: f.epoch,
      snapshot: legacy,
      nextSequence: 2,
    });
    tx.objectStore('outbox').put({
      id: op.id,
      epoch: f.epoch,
      operation: op,
      attempted: true,
      status: 'pending',
      receipt: null,
      sequence: 1,
    });
    tx.objectStore('archives').put({
      id: 'old-archive',
      epoch: f.epoch,
      archivedAt: op.at,
      snapshot: legacy,
    });
    await done;
    db.close();
    const mobile = new MobileRepository({
      indexedDBFactory: legacyFactory,
      databaseName: 'legacy-phone',
    });
    connections.push(mobile);
    expect((await mobile.load()).outbox[0]?.operation).toEqual(op);
    await expect(mobile.enqueueSpend(1)).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED' });
    const client = new SyncClient(mobile, {
      pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch: f.epoch }),
      request: (request) => f.service.handle('phone', request),
    });
    await client.sync();
    const state = await mobile.load();
    expect(state.snapshot?.wallet.balance).toBe(10);
    expect(state.outbox).toEqual([]);
    expect(state.archives).toHaveLength(1);
    expect(state.archives[0]?.snapshot.version).toBe(1);
    expect((await f.domain.wallet.load()).ledger).toHaveLength(2);
  });
});
