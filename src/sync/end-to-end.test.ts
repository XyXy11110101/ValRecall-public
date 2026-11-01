// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MobileRepository,
  mobileCompletionState,
  mobileVisibleTasks,
} from '../database/mobile-repository';
import { ValRecallRepository } from '../database/repository';
import { SyncRepository } from '../database/sync-repository';
import { SyncClient } from '../mobile/sync-client';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncRequest, SyncResponse } from './contracts';
import { DesktopSyncService } from './service';
import { seedHistoricalTask } from '../testing/historical-task';

const connections: { close(): void }[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
});

/** Exercise domain boundaries through real JSON/UTF-8, without native hosts or real data. */
function wire<T>(value: T): T {
  return JSON.parse(new TextDecoder().decode(new TextEncoder().encode(JSON.stringify(value)))) as T;
}

async function fixture(start = '2026-10-13T12:00:00.000Z', initialBalance = 0) {
  // Each device has its own factory; neither can accidentally see the other's database.
  const desktopFactory = new IDBFactory();
  const mobileFactory = new IDBFactory();
  let now = new Date(start);
  let timeZone = 'Europe/London';
  let sequence = 0;
  let loseNextPushReply = false;
  const pushes: Extract<SyncRequest, { type: 'push' }>[] = [];
  const responses: Extract<SyncResponse, { type: 'receipts' }>[] = [];
  const openDesktop = () => {
    const repository = new ValRecallRepository({
      indexedDBFactory: desktopFactory,
      databaseName: 'synthetic-desktop',
      clock: () => new Date(now),
    });
    connections.push(repository);
    return repository;
  };
  const openMobile = () => {
    const repository = new MobileRepository({
      indexedDBFactory: mobileFactory,
      databaseName: 'synthetic-mobile',
      clock: () => new Date(now),
      idGenerator: () => `phone-operation-${++sequence}`,
    });
    connections.push(repository);
    return repository;
  };
  const connectDesktop = (repository: ValRecallRepository) =>
    new SyncRepository(repository, {
      clock: () => new Date(now),
      legacyLoader: async () => ({
        ...DEFAULT_ALLOWANCE,
        balance: initialBalance,
        totalEarned: initialBalance,
      }),
    });
  let desktop = openDesktop();
  let domain = connectDesktop(desktop);
  let service = new DesktopSyncService(
    domain,
    () => now.getTime(),
    () => timeZone,
  );
  let mobile = openMobile();
  let pairedEpoch = await domain.getEpoch();
  const request = async (input: SyncRequest): Promise<unknown> => {
    if (input.type === 'push') pushes.push(wire(input));
    const response = wire(await service.handle('synthetic-phone', wire(input)));
    if (response.type === 'receipts') responses.push(response);
    if (input.type === 'push' && loseNextPushReply) {
      loseNextPushReply = false;
      throw new Error('Synthetic loss after desktop commit');
    }
    return response;
  };
  const connectMobile = () =>
    new SyncClient(mobile, {
      request,
      clock: () => now.getTime(),
      pairStatus: async () => ({
        paired: true,
        deviceId: 'synthetic-phone',
        epoch: pairedEpoch,
      }),
    });
  let client = connectMobile();
  return {
    get desktop() {
      return desktop;
    },
    get domain() {
      return domain;
    },
    get mobile() {
      return mobile;
    },
    get client() {
      return client;
    },
    get now() {
      return new Date(now);
    },
    pushes,
    responses,
    setTime(value: string) {
      now = new Date(value);
    },
    setTimeZone(value: string) {
      timeZone = value;
    },
    loseAppliedReply() {
      loseNextPushReply = true;
    },
    async rePair() {
      pairedEpoch = await domain.getEpoch();
      return pairedEpoch;
    },
    restart() {
      desktop.close();
      mobile.close();
      desktop = openDesktop();
      domain = connectDesktop(desktop);
      service = new DesktopSyncService(
        domain,
        () => now.getTime(),
        () => timeZone,
      );
      mobile = openMobile();
      client = connectMobile();
    },
    async seedTask() {
      return seedHistoricalTask(desktop, now, 'desktop-routine', '每天阅读 / Daily reading');
    },
  };
}

describe('synthetic desktop-to-phone domain integration', () => {
  it('commits offline spending exactly once even when its reply is lost and both sides restart', async () => {
    const test = await fixture('2026-10-13T12:00:00.000Z', 20);
    await test.client.sync();
    const spend = await test.mobile.enqueueSpend(7, '午后零食');
    expect((await test.mobile.load()).snapshot?.wallet.balance).toBe(20);
    test.loseAppliedReply();
    await expect(test.client.sync()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(await test.domain.wallet.load()).toMatchObject({ balance: 13, totalSpent: 7 });
    test.restart();
    await expect(test.mobile.cancelNeverSent(spend.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    const synced = await test.client.sync();
    expect(test.responses[1]).toEqual(test.responses[0]);
    expect(synced.state.snapshot?.wallet).toMatchObject({ balance: 13, totalSpent: 7 });
    expect(
      synced.state.snapshot?.wallet.ledger.filter((entry) => entry.source === 'spend'),
    ).toHaveLength(1);
    expect(synced.state.outbox).toEqual([]);
  });

  it('preserves insufficient-balance conflicts and does not debit later after new earnings', async () => {
    const test = await fixture('2026-10-13T12:00:00.000Z', 10);
    await test.client.sync();
    const spend = await test.mobile.enqueueSpend(8);
    await test.domain.wallet.update((state) => ({
      state: { ...state, balance: 3 },
      result: undefined,
    }));
    const synced = await test.client.sync();
    expect(synced.conflicts).toBe(1);
    expect(synced.state.outbox[0]).toMatchObject({ id: spend.id, status: 'conflict' });
    expect(synced.state.snapshot?.wallet).toMatchObject({ balance: 3, totalSpent: 0 });
    const task = await test.seedTask();
    await test.domain.changeTaskCompletionAtomic(task.id, '2026-10-13', true, test.now);
    await test.client.sync();
    expect(test.pushes).toHaveLength(1);
    expect((await test.domain.wallet.load()).balance).toBe(8);
  });

  it('creates offline and earns exactly once for each saved day after a delayed connection', async () => {
    const test = await fixture('2026-10-10T12:00:00.000Z', 37);
    await test.client.sync();
    const created = await test.mobile.createTask({
      title: '读一章书 📚 / Read one chapter',
      notes: '中文与 English remain unchanged.',
      recurrence: 'daily',
    });
    if (created.operation.kind !== 'create-task') throw new Error('Expected synthetic creation');
    const taskId = created.operation.task.id;
    for (const day of ['10', '11', '12']) {
      test.setTime(`2026-10-${day}T12:00:00.000Z`);
      await test.mobile.enqueueCompletion(taskId);
    }
    const offline = await test.mobile.load();
    expect(offline.outbox).toHaveLength(4);
    expect(offline.snapshot?.wallet.balance).toBe(37);
    expect(mobileVisibleTasks(offline)[0]?.task).toEqual(created.operation.task);
    expect(await test.desktop.listTasks()).toEqual([]);

    test.setTime('2026-10-15T12:00:00.000Z');
    const synced = await test.client.sync();
    expect(synced).toMatchObject({ pushed: 4, remaining: 0, conflicts: 0 });
    expect(synced.state.outbox).toEqual([]);
    expect(synced.state.snapshot?.wallet).toMatchObject({ balance: 57, totalEarned: 57 });
    expect((await test.desktop.listTaskCompletions()).map((row) => row.localDate).sort()).toEqual([
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(test.responses[0]?.receipts.map((row) => row.reward)).toEqual([5, 5, 5, 5]);
    expect((await test.desktop.exportData()).sync?.receipts).toHaveLength(4);
    await test.client.sync();
    expect(test.pushes).toHaveLength(1);
    expect((await test.domain.wallet.load()).balance).toBe(57);
  });

  it('restarts both devices after an applied reply is lost and reuses durable original receipts', async () => {
    const test = await fixture();
    await test.client.sync();
    const created = await test.mobile.createTask({ title: '离线后重试', recurrence: 'daily' });
    if (created.operation.kind !== 'create-task') throw new Error('Expected synthetic creation');
    await test.mobile.enqueueCompletion(created.operation.task.id);
    const ids = (await test.mobile.load()).outbox.map((row) => row.id);
    test.loseAppliedReply();
    await expect(test.client.sync()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect((await test.domain.wallet.load()).balance).toBe(10);
    expect(
      (await test.mobile.load()).outbox.every((row) => row.attempted && row.status === 'pending'),
    ).toBe(true);

    test.restart();
    expect((await test.mobile.load()).outbox.map((row) => row.id)).toEqual(ids);
    await expect(test.mobile.cancelNeverSent(created.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    const synced = await test.client.sync();
    expect(test.pushes.map((batch) => batch.operations.map((row) => row.id))).toEqual([ids, ids]);
    expect(test.responses[1]).toEqual(test.responses[0]);
    expect(synced.state.outbox).toEqual([]);
    expect(synced.state.snapshot?.wallet.balance).toBe(10);
    expect(await test.desktop.listTaskCompletions()).toHaveLength(1);
    expect((await test.desktop.exportData()).sync?.receipts).toHaveLength(2);
  });

  it('deduplicates an offline occurrence already completed on the computer', async () => {
    const test = await fixture();
    const task = await test.seedTask();
    await test.client.sync();
    await test.mobile.enqueueCompletion(task.id);
    await test.domain.changeTaskCompletionAtomic(task.id, '2026-10-13', true, test.now);
    const synced = await test.client.sync();
    expect(test.responses[0]?.receipts[0]).toMatchObject({ status: 'duplicate', reward: 0 });
    expect(synced.state.outbox).toEqual([]);
    expect(mobileCompletionState(synced.state, task.id, '2026-10-13')).toBe('confirmed');
    expect((await test.domain.wallet.load()).balance).toBe(5);
    expect(await test.desktop.listTaskCompletions()).toHaveLength(1);
  });

  it('retains a conflict for a stale phone operation after computer completion and undo', async () => {
    const test = await fixture();
    const task = await test.seedTask();
    await test.client.sync();
    const queued = await test.mobile.enqueueCompletion(task.id);
    await test.domain.changeTaskCompletionAtomic(task.id, '2026-10-13', true, test.now);
    await test.domain.changeTaskCompletionAtomic(task.id, '2026-10-13', false, test.now);
    const synced = await test.client.sync();
    expect(synced).toMatchObject({ conflicts: 1, remaining: 0 });
    expect(synced.state.outbox[0]).toMatchObject({
      id: queued.id,
      status: 'conflict',
      receipt: { reward: 0 },
    });
    expect(mobileCompletionState(synced.state, task.id, '2026-10-13')).toBe('open');
    expect((await test.domain.wallet.load()).balance).toBe(0);

    const reconfirmed = await test.mobile.enqueueCompletion(task.id);
    expect(reconfirmed.id).not.toBe(queued.id);
    const fresh = await test.client.sync();
    expect(fresh.state.outbox).toHaveLength(1);
    expect(fresh.state.outbox[0]?.id).toBe(queued.id);
    expect(fresh.state.snapshot?.wallet.balance).toBe(5);
    expect(await test.desktop.listTaskCompletions()).toHaveLength(1);
  });

  it('does not reapply a lost successful operation when the computer undoes it before retry', async () => {
    const test = await fixture();
    const task = await test.seedTask();
    await test.client.sync();
    await test.mobile.enqueueCompletion(task.id);
    test.loseAppliedReply();
    await expect(test.client.sync()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await test.domain.changeTaskCompletionAtomic(task.id, '2026-10-13', false, test.now);
    test.restart();
    const synced = await test.client.sync();
    expect(test.responses[1]).toEqual(test.responses[0]);
    expect(test.responses[1]?.receipts[0]).toMatchObject({ status: 'applied', reward: 5 });
    // A receipt describes the original transaction; the current authoritative snapshot wins.
    expect(synced.state.snapshot?.wallet.balance).toBe(0);
    expect(synced.state.outbox).toEqual([]);
    expect(mobileCompletionState(synced.state, task.id, '2026-10-13')).toBe('open');
    expect(await test.desktop.listTaskCompletions()).toEqual([]);
  });

  it('blocks the old queue after restore and keeps it isolated until explicit acceptance', async () => {
    const test = await fixture();
    const task = await test.seedTask();
    await test.client.sync();
    const oldState = await test.mobile.load();
    const backup = await test.desktop.exportData();
    const queued = await test.mobile.enqueueCompletion(task.id);
    await test.desktop.importData(backup, 'replace', { restoreWallet: true });

    // An old native session cannot write into a freshly restored desktop epoch.
    await expect(test.client.sync()).rejects.toMatchObject({ code: 'EPOCH_CHANGED' });
    expect(await test.desktop.listTaskCompletions()).toEqual([]);
    expect((await test.mobile.load()).outbox[0]).toMatchObject({
      id: queued.id,
      status: 'pending',
      attempted: false,
    });
    const epoch = await test.rePair();
    await expect(test.client.sync()).rejects.toMatchObject({
      code: 'EPOCH_CHANGED',
      newEpoch: epoch,
    });
    expect(test.pushes).toHaveLength(0);
    expect((await test.mobile.load()).archives).toEqual([]);

    await test.mobile.acceptNewEpoch(epoch);
    const synced = await test.client.sync();
    expect(synced).toMatchObject({ pushed: 0, remaining: 0 });
    expect(synced.state.epoch).toBe(epoch);
    expect(synced.state.archives[0]?.snapshot).toEqual(oldState.snapshot);
    expect(synced.state.outbox[0]).toMatchObject({
      id: queued.id,
      epoch: oldState.epoch,
      status: 'isolated',
    });
    expect(synced.state.snapshot?.wallet.balance).toBe(0);
    expect(test.pushes).toHaveLength(0);

    await test.mobile.enqueueCompletion(task.id);
    const fresh = await test.client.sync();
    expect(fresh.state.snapshot?.wallet.balance).toBe(5);
    expect(fresh.state.outbox[0]?.status).toBe('isolated');
    expect(await test.desktop.listTaskCompletions()).toHaveLength(1);
  });

  it('uses the last synced computer zone offline and never re-dates saved history after travel', async () => {
    const test = await fixture('2026-10-13T23:30:00.000Z');
    test.setTimeZone('Asia/Shanghai');
    const task = await test.seedTask();
    await test.client.sync();
    const east = await test.mobile.enqueueCompletion(task.id);
    expect(east.operation).toMatchObject({ date: '2026-10-14', timeZone: 'Asia/Shanghai' });

    test.setTime('2026-10-14T00:00:00.000Z');
    test.setTimeZone('America/Los_Angeles');
    const moved = await test.client.sync();
    expect(moved.state.snapshot?.timeZone).toBe('America/Los_Angeles');
    expect(moved.state.snapshot?.completions[0]).toMatchObject({
      localDate: '2026-10-14',
      completedAt: '2026-10-13T23:30:00.000Z',
    });
    test.setTime('2026-10-14T00:05:00.000Z');
    const west = await test.mobile.enqueueCompletion(task.id);
    expect(west.operation).toMatchObject({ date: '2026-10-13', timeZone: 'America/Los_Angeles' });
    const synced = await test.client.sync();
    expect(synced.state.snapshot?.wallet.balance).toBe(10);
    expect(synced.state.snapshot?.completions.map((row) => row.localDate).sort()).toEqual([
      '2026-10-13',
      '2026-10-14',
    ]);
    expect(synced.state.snapshot?.wallet.ledger.map((row) => row.date)).toEqual([
      '2026-10-13',
      '2026-10-14',
    ]);
    expect(test.pushes[0]?.operations[0]).toEqual(east.operation);
    expect(test.pushes[1]?.operations[0]).toEqual(west.operation);
  });
});
