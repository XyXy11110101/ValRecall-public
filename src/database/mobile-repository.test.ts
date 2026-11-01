// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncReceipt, SyncSnapshot } from '../sync/contracts';
import { requestResult, transactionComplete } from './idb';
import { MobileRepository, mobileCompletionState, mobileVisibleTasks } from './mobile-repository';

const now = new Date('2026-10-13T23:30:00Z');
function snapshot(epoch = 'epoch-1'): SyncSnapshot {
  return {
    version: 2,
    sequence: 1,
    taskSkips: [],
    epoch,
    generatedAt: now.toISOString(),
    timeZone: 'Asia/Shanghai',
    tasks: [],
    completions: [],
    occurrences: [],
    wallet: structuredClone(DEFAULT_ALLOWANCE),
  };
}
function receipt(
  operationId: string,
  status: SyncReceipt['status'] = 'applied',
  reward = 0,
): SyncReceipt {
  return { operationId, status, reward, message: '已处理' };
}

describe('isolated mobile repository and durable outbox', () => {
  let factory: IDBFactory;
  let repository: MobileRepository;
  let sequence: number;
  beforeEach(() => {
    factory = new IDBFactory();
    sequence = 0;
    repository = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'mobile-test',
      clock: () => now,
      idGenerator: () => `id-${++sequence}`,
    });
  });

  it('requires an initial confirmed snapshot before authoring', async () => {
    expect(await repository.load()).toEqual({
      epoch: null,
      snapshot: null,
      outbox: [],
      archives: [],
    });
    await expect(
      repository.createTask({ title: '读书', recurrence: 'daily' }),
    ).rejects.toMatchObject({ code: 'INITIAL_SYNC_REQUIRED' });
    await expect(repository.enqueueCompletion('task')).rejects.toMatchObject({
      code: 'INITIAL_SYNC_REQUIRED',
    });
    await expect(repository.enqueueSpend(1)).rejects.toMatchObject({
      code: 'INITIAL_SYNC_REQUIRED',
    });
  });

  it('persists an offline spend without changing confirmed money and reserves it until fresh snapshot', async () => {
    const initial = snapshot();
    initial.wallet.balance = 12;
    await repository.applySnapshot(initial);
    const spend = await repository.enqueueSpend(7, ' 点心 ');
    expect(spend.operation).toMatchObject({ kind: 'spend-allowance', amount: 7, note: '点心' });
    expect((await repository.load()).snapshot?.wallet.balance).toBe(12);
    await expect(repository.enqueueSpend(6)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    await repository.markAttempted('epoch-1', [spend.id]);
    await expect(repository.cancelNeverSent(spend.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    await expect(
      repository.recordReceipts('epoch-1', [spend.id], [receipt(spend.id, 'applied', 5)]),
    ).rejects.toThrow();
    await repository.recordReceipts('epoch-1', [spend.id], [receipt(spend.id)]);
    await expect(repository.enqueueSpend(6)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    repository.close();
    const reopened = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'mobile-test',
    });
    expect((await reopened.load()).outbox[0]).toMatchObject({
      id: spend.id,
      status: 'acknowledged',
    });
    const settled = snapshot();
    settled.sequence = 2;
    settled.wallet.balance = 5;
    await reopened.applySnapshot(settled, [spend.id]);
    expect((await reopened.load()).outbox).toEqual([]);
    await reopened.enqueueSpend(5);
    reopened.close();
  });

  it('cancels an unsent spend, but never spends unconfirmed task rewards', async () => {
    const initial = snapshot();
    initial.wallet.balance = 5;
    await repository.applySnapshot(initial);
    const spend = await repository.enqueueSpend(5);
    expect(await repository.cancelNeverSent(spend.id)).toBe(true);
    const created = await repository.createTask({ title: '未来奖励', recurrence: 'daily' });
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    await repository.enqueueCompletion(created.operation.task.id);
    await expect(repository.enqueueSpend(6)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    const accepted = await repository.enqueueSpend(5);
    expect((await repository.load()).outbox.map((row) => row.id)).toContain(accepted.id);
  });

  it('isolates a pending deduction across restored epochs without replay', async () => {
    const initial = snapshot();
    initial.wallet.balance = 5;
    await repository.applySnapshot(initial);
    const spend = await repository.enqueueSpend(5);
    await repository.acceptNewEpoch('new-epoch');
    await repository.applySnapshot({ ...initial, epoch: 'new-epoch' });
    expect((await repository.load()).outbox[0]).toMatchObject({ id: spend.id, status: 'isolated' });
    await repository.enqueueSpend(5);
    expect((await repository.load()).outbox).toHaveLength(2);
  });

  it('serializes concurrent offline deductions against confirmed funds', async () => {
    const initial = snapshot();
    initial.wallet.balance = 5;
    await repository.applySnapshot(initial);
    const results = await Promise.allSettled([
      repository.enqueueSpend(5),
      repository.enqueueSpend(5),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await repository.load()).outbox).toHaveLength(1);
    expect((await repository.load()).snapshot?.wallet.balance).toBe(5);
  });

  it('persists offline operations across a new repository instance without opening desktop DB', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '读书', recurrence: 'daily' });
    repository.close();
    const reopened = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'mobile-test',
    });
    expect((await reopened.load()).outbox).toEqual([created]);
    expect((await factory.databases()).map((db) => db.name)).toEqual(['mobile-test']);
    reopened.close();
  });

  it.each([{ status: ['pending'] }, { status: 1 }, { status: { value: 'pending' } }])(
    'rejects non-string persisted outbox status without coercion: $status',
    async ({ status }) => {
      await repository.applySnapshot(snapshot());
      const created = await repository.createTask({ title: '读书', recurrence: 'daily' });
      const database = await requestResult(factory.open('mobile-test', 3));
      const transaction = database.transaction('outbox', 'readwrite');
      const done = transactionComplete(transaction);
      transaction.objectStore('outbox').put({ ...created, status });
      await done;
      await expect(repository.load()).rejects.toMatchObject({ code: 'INVALID_DATA' });
      const read = database.transaction('outbox', 'readonly');
      const readDone = transactionComplete(read);
      expect(await requestResult(read.objectStore('outbox').get(created.id))).toMatchObject({
        status,
      });
      await readDone;
      database.close();
    },
  );

  it('uses the computer calendar and create operation revision for dependent completion', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '今天阅读', recurrence: 'specific_date' });
    expect(created.operation.kind).toBe('create-task');
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    expect(created.operation.task.scheduledDate).toBe('2026-10-14');
    const completed = await repository.enqueueCompletion(created.operation.task.id);
    expect(completed.operation).toMatchObject({
      kind: 'complete-task',
      date: '2026-10-14',
      timeZone: 'Asia/Shanghai',
      taskRevision: created.id,
      occurrenceRevision: null,
    });
    expect(await repository.enqueueCompletion(created.operation.task.id)).toEqual(completed);
    expect(
      mobileCompletionState(await repository.load(), created.operation.task.id, '2026-10-14'),
    ).toBe('pending');
    expect((await repository.load()).snapshot?.wallet.balance).toBe(0);
  });

  it('does not complete future or already confirmed tasks', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({
      title: '未来任务',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-15',
    });
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    await expect(repository.enqueueCompletion(created.operation.task.id)).rejects.toMatchObject({
      code: 'TASK_UNAVAILABLE',
    });
    const confirmed = snapshot();
    confirmed.sequence = 2;
    confirmed.tasks.push({
      task: { ...created.operation.task, scheduledDate: '2026-10-14' },
      revision: 'pc-edit',
    });
    confirmed.completions.push({
      id: 'completion-1',
      taskId: created.operation.task.id,
      localDate: '2026-10-14',
      completedAt: now.toISOString(),
    });
    await repository.applySnapshot(confirmed);
    await expect(repository.enqueueCompletion(created.operation.task.id)).rejects.toMatchObject({
      code: 'ALREADY_COMPLETED',
    });
  });

  it('cancels never-sent creates together with dependent completions', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '可取消', recurrence: 'daily' });
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    await repository.enqueueCompletion(created.operation.task.id);
    expect(await repository.cancelNeverSent(created.id)).toBe(true);
    expect((await repository.load()).outbox).toEqual([]);
  });

  it('never cancels a request once it may have reached the computer', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '未知回复', recurrence: 'daily' });
    await repository.markAttempted('epoch-1', [created.id]);
    await expect(repository.cancelNeverSent(created.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    expect((await repository.load()).outbox[0]).toMatchObject({
      id: created.id,
      attempted: true,
      status: 'pending',
    });
  });

  it('does not partially cancel a create whose dependent completion was attempted', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '依赖', recurrence: 'daily' });
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    const completion = await repository.enqueueCompletion(created.operation.task.id);
    await repository.markAttempted('epoch-1', [completion.id]);
    await expect(repository.cancelNeverSent(created.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    expect((await repository.load()).outbox).toHaveLength(2);
  });

  it('validates the entire receipt set before writing and accepts exact duplicate delivery', async () => {
    await repository.applySnapshot(snapshot());
    const one = await repository.createTask({ title: '一', recurrence: 'daily' });
    const two = await repository.createTask({ title: '二', recurrence: 'daily' });
    await repository.markAttempted('epoch-1', [one.id, two.id]);
    await expect(
      repository.recordReceipts('epoch-1', [one.id, two.id], [receipt(one.id), receipt(one.id)]),
    ).rejects.toThrow();
    expect((await repository.load()).outbox.every((row) => row.status === 'pending')).toBe(true);
    await repository.recordReceipts(
      'epoch-1',
      [one.id, two.id],
      [receipt(one.id), receipt(two.id)],
    );
    await repository.recordReceipts(
      'epoch-1',
      [one.id, two.id],
      [receipt(one.id), receipt(two.id)],
    );
    expect((await repository.load()).outbox.map((row) => row.status)).toEqual([
      'acknowledged',
      'acknowledged',
    ]);
    await expect(
      repository.recordReceipts('epoch-1', [one.id], [receipt(one.id, 'conflict')]),
    ).rejects.toThrow();
  });

  it('rejects unsolicited or reward-bearing creation receipts and retains all rows', async () => {
    await repository.applySnapshot(snapshot());
    const row = await repository.createTask({ title: '奖励校验', recurrence: 'daily' });
    await expect(
      repository.recordReceipts('epoch-1', [row.id], [receipt(row.id)]),
    ).rejects.toThrow();
    await repository.markAttempted('epoch-1', [row.id]);
    await expect(
      repository.recordReceipts('epoch-1', [row.id], [receipt(row.id, 'applied', 2)]),
    ).rejects.toThrow();
    expect((await repository.load()).outbox[0]?.receipt).toBeNull();
  });

  it('only removes fenced acknowledged rows when applying a valid same-epoch snapshot', async () => {
    await repository.applySnapshot(snapshot());
    const ack = await repository.createTask({ title: '已确认', recurrence: 'daily' });
    const conflict = await repository.createTask({ title: '冲突', recurrence: 'daily' });
    await repository.markAttempted('epoch-1', [ack.id, conflict.id]);
    await repository.recordReceipts(
      'epoch-1',
      [ack.id, conflict.id],
      [receipt(ack.id), receipt(conflict.id, 'conflict')],
    );
    const concurrent = await repository.createTask({ title: '拉取期间新增', recurrence: 'daily' });
    await repository.applySnapshot({ ...snapshot(), sequence: 2 }, [ack.id]);
    expect((await repository.load()).outbox.map((row) => row.id)).toEqual([
      conflict.id,
      concurrent.id,
    ]);
    expect(mobileVisibleTasks(await repository.load()).map((entry) => entry.task.title)).toEqual([
      '拉取期间新增',
    ]);
  });

  it('does not erase acknowledgements made after a pull fence was captured', async () => {
    await repository.applySnapshot(snapshot());
    const row = await repository.createTask({ title: '较晚回执', recurrence: 'daily' });
    const fence: string[] = [];
    await repository.markAttempted('epoch-1', [row.id]);
    await repository.recordReceipts('epoch-1', [row.id], [receipt(row.id)]);
    await repository.applySnapshot({ ...snapshot(), sequence: 2 }, fence);
    expect((await repository.load()).outbox[0]?.status).toBe('acknowledged');
  });

  it('retains snapshot and queue on invalid, older or wrong-epoch snapshots', async () => {
    await repository.applySnapshot(snapshot());
    await repository.createTask({ title: '保留', recurrence: 'daily' });
    const before = await repository.load();
    await expect(
      repository.applySnapshot({ ...snapshot(), wallet: { balance: -1 } }),
    ).rejects.toThrow();
    await expect(repository.applySnapshot(snapshot('other'))).rejects.toMatchObject({
      code: 'EPOCH_CHANGED',
    });
    await expect(repository.applySnapshot({ ...snapshot(), sequence: 0 })).rejects.toThrow();
    expect(await repository.load()).toEqual(before);
  });

  it('isolates every old outbox state and archives the snapshot only on explicit epoch acceptance', async () => {
    await repository.applySnapshot(snapshot());
    const ack = await repository.createTask({ title: '已到电脑', recurrence: 'daily' });
    const conflict = await repository.createTask({ title: '冲突', recurrence: 'daily' });
    await repository.markAttempted('epoch-1', [ack.id, conflict.id]);
    await repository.recordReceipts(
      'epoch-1',
      [ack.id, conflict.id],
      [receipt(ack.id), receipt(conflict.id, 'conflict')],
    );
    await repository.createTask({ title: '未发送', recurrence: 'daily' });
    await repository.acceptNewEpoch('epoch-2');
    const accepted = await repository.load();
    expect(accepted).toMatchObject({ epoch: 'epoch-2', snapshot: null });
    expect(accepted.archives[0]?.snapshot).toEqual(snapshot());
    expect(accepted.outbox).toHaveLength(3);
    expect(
      accepted.outbox.every((row) => row.status === 'isolated' && row.epoch === 'epoch-1'),
    ).toBe(true);
    expect(accepted.outbox[0]?.receipt).not.toBeNull();
    await expect(
      repository.createTask({ title: '还不能新增', recurrence: 'daily' }),
    ).rejects.toMatchObject({ code: 'INITIAL_SYNC_REQUIRED' });
    await repository.applySnapshot(snapshot('epoch-2'), [ack.id]);
    expect((await repository.load()).outbox).toHaveLength(3);
    await repository.acceptNewEpoch('epoch-2');
    expect((await repository.load()).archives).toHaveLength(1);
  });

  it('serializes concurrent completion requests across separate connections', async () => {
    await repository.applySnapshot(snapshot());
    const row = await repository.createTask({ title: '同时点', recurrence: 'daily' });
    if (row.operation.kind !== 'create-task') throw new Error('fixture');
    const other = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'mobile-test',
      clock: () => now,
      idGenerator: () => `other-${++sequence}`,
    });
    const [left, right] = await Promise.all([
      repository.enqueueCompletion(row.operation.task.id),
      other.enqueueCompletion(row.operation.task.id),
    ]);
    expect(left.id).toBe(right.id);
    expect((await repository.load()).outbox).toHaveLength(2);
    other.close();
  });
});
