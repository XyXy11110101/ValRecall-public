// @vitest-environment node
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { WalletRepository } from './wallet';
import { DraftRepository } from './drafts';
import { SyncRepository } from './sync-repository';
import { MobileRepository, mobileAvailableBalance } from './mobile-repository';
import { STORE_NAMES } from './migrations';
import { saveTaskDraft, saveTaskDraftWithReward } from '../dashboard/task-save';
import { SyncClient } from '../mobile/sync-client';
import { DesktopSyncService } from '../sync/service';
import type { SyncOperation, SyncRequest } from '../sync/contracts';
import { readSyncRequest } from '../sync/contracts';
import { seedHistoricalTask } from '../testing/historical-task';

// Noon on the computer's own calendar: the reward takes its date from local time.
const now = new Date(2026, 9, 22, 12);
const values = {
  title: 'Synthetic todo',
  notes: null,
  kind: 'routine' as const,
  recurrence: 'daily' as const,
  scheduledDate: null,
  scheduledTime: null,
  selectedWeekdays: [],
  linkedLearningItemId: null,
  priority: 'normal' as const,
};
const connections: { close(): void }[] = [];
function fixture() {
  const factory = new IDBFactory();
  const repository = new ValRecallRepository({
    indexedDBFactory: factory,
    databaseName: 'creation-reward',
    clock: () => now,
  });
  const sync = new SyncRepository(repository, { clock: () => now });
  connections.push(repository);
  return {
    repository,
    sync,
    wallet: new WalletRepository(repository),
    drafts: new DraftRepository(repository, () => now),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) connection.close();
});

describe('desktop todo creation earns once atomically', () => {
  it.each(['daily', 'selected_weekdays', 'specific_date'] as const)(
    'awards exactly5 for %s, independently of check-in and completion',
    async (recurrence) => {
      const { repository, wallet, sync } = fixture();
      await repository.createTask({
        ...values,
        id: 'new',
        recurrence,
        kind: recurrence === 'specific_date' ? 'one_off' : 'routine',
        scheduledDate: recurrence === 'specific_date' ? '2026-10-22' : null,
        selectedWeekdays: recurrence === 'selected_weekdays' ? [4] : [],
      });
      expect(await wallet.load()).toMatchObject({
        balance: 5,
        totalEarned: 5,
        lastCheckInDate: null,
        currentStreak: 0,
      });
      expect((await wallet.load()).ledger).toEqual([
        expect.objectContaining({
          source: 'task',
          note: '创建待办',
          amount: 5,
          date: '2026-10-22',
        }),
      ]);
      await sync.changeTaskCompletionAtomic('new', '2026-10-22', true, now);
      expect((await wallet.load()).balance).toBe(10);
      await sync.changeTaskCompletionAtomic('new', '2026-10-22', false, now);
      await repository.updateTask('new', { title: 'Edited' });
      await repository.archiveTask('new');
      await repository.archiveTask('new', false);
      expect((await wallet.load()).balance).toBe(5);
      await repository.deleteTask('new');
      await expect(repository.createTask({ ...values, id: 'new' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect((await wallet.load()).balance).toBe(5);
      expect(await repository.getTask('new')).toBeUndefined();
    },
  );

  it('reconciles concurrent clicks and a lost response using the same saved identity', async () => {
    const { repository, wallet } = fixture();
    const [one, two] = await Promise.all([
      saveTaskDraft(repository, 'same', values),
      saveTaskDraft(repository, 'same', values),
    ]);
    expect(one).toEqual(two);
    expect((await wallet.load()).balance).toBe(5);
    const port = {
      getTask: repository.getTask.bind(repository),
      createTask: vi.fn(async (input: Parameters<ValRecallRepository['createTask']>[0]) => {
        await repository.createTask(input);
        throw new Error('response lost after commit');
      }),
    };
    expect((await saveTaskDraft(port, 'lost', values)).id).toBe('lost');
    expect((await saveTaskDraft(port, 'lost', values)).id).toBe('lost');
    expect(port.createTask).toHaveBeenCalledOnce();
    expect((await wallet.load()).balance).toBe(10);
    await expect(
      saveTaskDraft(repository, 'same', { ...values, title: 'Other tab' }),
    ).rejects.toThrow('已经保存过了');
    expect((await wallet.load()).balance).toBe(10);
  });

  it('returns the committed grant with the task, while createTask still returns the task', async () => {
    const { repository, wallet } = fixture();
    const created = await repository.createTaskWithReward({ ...values, id: 'with-reward' });
    expect(created.task).toEqual(await repository.getTask('with-reward'));
    expect(created.reward.reward).toBe(5);
    expect(created.reward.state.balance).toBe(5);
    expect(created.reward.state.ledger[0]).toMatchObject({
      note: '创建待办',
      amount: 5,
      balanceAfter: 5,
    });
    expect(created.reward.state.ledger[0]?.id).toBe((await wallet.load()).ledger[0]?.id);
    const plain = await repository.createTask({ ...values, id: 'plain' });
    expect(plain).toEqual(await repository.getTask('plain'));
    expect(plain).not.toHaveProperty('reward');
    expect((await wallet.load()).balance).toBe(10);
    await expect(
      repository.createTaskWithReward({ ...values, id: 'with-reward' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await wallet.load()).balance).toBe(10);
  });

  it('reports exactly one grant across concurrent saves and lost-response recovery', async () => {
    const { repository, wallet } = fixture();
    const results = await Promise.all([
      saveTaskDraftWithReward(repository, 'same', values),
      saveTaskDraftWithReward(repository, 'same', values),
    ]);
    expect(results.filter((result) => result.reward !== null)).toHaveLength(1);
    expect((await wallet.load()).ledger).toHaveLength(1);
    const port = {
      getTask: repository.getTask.bind(repository),
      createTask: repository.createTask.bind(repository),
      createTaskWithReward: vi.fn(
        async (input: Parameters<ValRecallRepository['createTask']>[0]) => {
          await repository.createTaskWithReward(input);
          throw new Error('response lost after commit');
        },
      ),
    };
    // The grant committed, but this call never received its receipt: no coin for it.
    expect(await saveTaskDraftWithReward(port, 'lost', values)).toMatchObject({
      task: { id: 'lost' },
      reward: null,
    });
    expect((await wallet.load()).balance).toBe(10);
  });

  it.each(['wallet', 'task', 'draft'] as const)(
    'retains the whole draft and rolls back task, revision and money on %s write failure',
    async (target) => {
      const { repository, wallet, drafts } = fixture();
      await wallet.ensureWallet();
      const draft = await drafts.save(
        { id: 'draft', scope: 'task', summary: 'Todo', payload: values },
        0,
      );
      const originalPut = IDBObjectStore.prototype.put;
      const originalAdd = IDBObjectStore.prototype.add;
      const originalDelete = IDBObjectStore.prototype.delete;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (target === 'wallet' && this.name === STORE_NAMES.wallet)
          throw new DOMException('Synthetic disk full', 'QuotaExceededError');
        return originalPut.apply(this, args);
      });
      vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (target === 'task' && this.name === STORE_NAMES.dailyTasks)
          throw new DOMException('Synthetic disk full', 'QuotaExceededError');
        return originalAdd.apply(this, args);
      });
      vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
        this: IDBObjectStore,
        ...args
      ) {
        if (target === 'draft' && this.name === STORE_NAMES.drafts)
          throw new DOMException('Synthetic disk full', 'QuotaExceededError');
        return originalDelete.apply(this, args);
      });
      await expect(repository.createTask({ ...values, id: 'todo' }, draft)).rejects.toThrow();
      // The receipt-returning form rolls back the same way and returns no grant.
      await expect(
        repository.createTaskWithReward({ ...values, id: 'todo' }, draft),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(await repository.getTask('todo')).toBeUndefined();
      expect((await wallet.load()).balance).toBe(0);
      expect(await drafts.list('task')).toEqual([draft]);
      await repository.createTask({ ...values, id: 'todo' }, draft);
      expect((await wallet.load()).balance).toBe(5);
      expect(await drafts.list('task')).toEqual([]);
    },
  );

  it('does not commit a stale draft or a missing linked item', async () => {
    const { repository, wallet, drafts } = fixture();
    const old = await drafts.save(
      { id: 'draft', scope: 'task', summary: 'Todo', payload: values },
      0,
    );
    const latest = await drafts.save(
      { ...old, payload: { ...values, title: 'Newer' } },
      old.revision,
    );
    await expect(repository.createTask({ ...values, id: 'stale' }, old)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      repository.createTask({
        ...values,
        kind: 'practice',
        id: 'missing',
        linkedLearningItemId: 'gone',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await drafts.list('task')).toEqual([latest]);
    expect(await repository.listTasks()).toEqual([]);
    expect((await wallet.load()).balance).toBe(0);
  });

  it.each(['tasks', 'all', 'clear'] as const)(
    'retains anti-replay evidence after wallet-preserving %s replacement',
    async (mode) => {
      const { repository, wallet } = fixture();
      await repository.createTask({ ...values, id: 'paid' });
      const backup = await repository.exportData();
      if (mode === 'tasks')
        await repository.importTasks({ ...(await repository.exportTasks()), tasks: [] }, 'replace');
      else if (mode === 'all')
        await repository.importData({ ...backup, tasks: [] }, 'replace', { restoreWallet: false });
      else await repository.clearAll();
      await expect(repository.createTask({ ...values, id: 'paid' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect((await wallet.load()).balance).toBe(5);
      await repository.importData(backup, 'merge');
      expect((await wallet.load()).balance).toBe(5);
      await repository.importData(backup, 'replace', { restoreWallet: true });
      expect((await wallet.load()).balance).toBe(5);
      await expect(repository.createTask({ ...values, id: 'paid' })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    },
  );

  it('never backfills existing historical or imported todos', async () => {
    const { repository, wallet } = fixture();
    await seedHistoricalTask(repository, now, 'old', values.title);
    await saveTaskDraft(repository, 'old', values);
    await repository.updateTask('old', { title: 'Edited old todo' });
    const backup = await repository.exportTasks();
    await repository.importTasks(
      { ...backup, tasks: backup.tasks.map((task) => ({ ...task, id: 'imported' })) },
      'merge',
    );
    expect((await wallet.load()).balance).toBe(0);
    await expect(repository.createTask({ ...values, id: 'imported' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await wallet.load()).balance).toBe(0);
  });
});

async function mobileFixture() {
  const desktop = fixture();
  const mobile = new MobileRepository({
    indexedDBFactory: new IDBFactory(),
    databaseName: 'phone',
    clock: () => now,
  });
  connections.push(mobile);
  const epoch = await desktop.sync.getEpoch();
  const service = new DesktopSyncService(
    desktop.sync,
    () => now.getTime(),
    () => 'Europe/London',
  );
  const options = {
    pairStatus: async () => ({ paired: true, deviceId: 'phone', epoch }),
    request: (request: SyncRequest) => service.handle('phone', request),
  };
  const client = new SyncClient(mobile, options);
  await client.sync();
  return { ...desktop, mobile, epoch, service, options, client };
}

describe('negotiated mobile creation rewards', () => {
  it('earns5 exactly once across offline creation, lost reply, restart and repeated push', async () => {
    const f = await mobileFixture();
    const created = await f.mobile.createTask({ title: 'Offline todo', recurrence: 'daily' });
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(0);
    await expect(f.mobile.enqueueSpend(1)).rejects.toThrow();
    const lossy = new SyncClient(f.mobile, {
      ...f.options,
      request: async (request) => {
        const response = await f.service.handle('phone', request);
        if (request.type === 'push') throw new Error('Lost response');
        return response;
      },
    });
    await expect(lossy.sync()).rejects.toThrow();
    expect((await f.wallet.load()).balance).toBe(5);
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(0);
    f.repository.close();
    f.mobile.close();
    await new SyncClient(f.mobile, f.options).sync();
    expect((await f.mobile.load()).outbox).toEqual([]);
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(5);
    const replay = await f.sync.applyOperations(f.epoch, 'phone', [created.operation], true);
    expect(replay[0]).toMatchObject({ status: 'applied', reward: 5, walletDelta: 5 });
    expect((await f.wallet.load()).ledger).toHaveLength(1);
    expect(
      (
        await f.sync.applyOperations(
          f.epoch,
          'phone',
          [{ ...created.operation, id: 'different-op' }],
          true,
        )
      )[0]?.status,
    ).toBe('conflict');
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    await f.mobile.enqueueCompletion(created.operation.task.id);
    await f.client.sync();
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(10);
    await f.mobile.enqueueTaskAction('undo-task', created.operation.task.id);
    await f.client.sync();
    expect(mobileAvailableBalance(await f.mobile.load())).toBe(5);
  });

  it('rolls back phone creation, wallet and receipt on a wallet write fault', async () => {
    const f = await mobileFixture();
    const row = await f.mobile.createTask({ title: 'Atomic todo', recurrence: 'daily' });
    const original = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === STORE_NAMES.wallet)
        throw new DOMException('Synthetic disk full', 'QuotaExceededError');
      return original.apply(this, args);
    });
    await expect(f.sync.applyOperations(f.epoch, 'phone', [row.operation], true)).rejects.toThrow();
    fault.mockRestore();
    expect(await f.repository.listTasks()).toEqual([]);
    expect((await f.wallet.load()).balance).toBe(0);
    expect((await f.repository.exportData()).sync?.receipts).toEqual([]);
    await f.client.sync();
    expect((await f.wallet.load()).balance).toBe(5);
  });

  it('keeps older phone requests at0 and never backfills an old confirmed create on retry', async () => {
    const f = await mobileFixture();
    const row = await f.mobile.createTask({ title: 'Legacy request', recurrence: 'daily' });
    const oldRequest = { version: 2, type: 'push', epoch: f.epoch, operations: [row.operation] };
    const first = await f.service.handle('phone', oldRequest);
    expect(first).toMatchObject({ receipts: [{ reward: 0, walletDelta: 0 }] });
    await f.client.sync();
    expect((await f.mobile.load()).outbox).toEqual([]);
    expect((await f.wallet.load()).balance).toBe(0);
    expect(await f.service.handle('phone', { ...oldRequest, taskCreationReward: 5 })).toEqual(
      first,
    );
  });

  it('accepts an older computer without advertising new rewards in its push', async () => {
    const f = await mobileFixture();
    await f.mobile.createTask({ title: 'Old computer', recurrence: 'daily' });
    const requests: SyncRequest[] = [];
    const client = new SyncClient(f.mobile, {
      ...f.options,
      request: async (request) => {
        requests.push(request);
        if (request.type === 'capabilities')
          return { version: 2, type: 'capabilities', epoch: f.epoch, protocol: 2, wallet: 2 };
        return f.service.handle('phone', request);
      },
    });
    await client.sync();
    expect(requests.find((request) => request.type === 'push')).not.toHaveProperty(
      'taskCreationReward',
    );
    expect((await f.mobile.load()).outbox).toEqual([]);
    expect((await f.wallet.load()).balance).toBe(0);
  });

  it.each([
    { reward: 2, walletDelta: 2 },
    { reward: 5, walletDelta: 0 },
    { reward: 0, walletDelta: 5 },
    { reward: 5 },
  ])('rejects mismatched create receipts %j without consuming pending input', async (amounts) => {
    const f = await mobileFixture();
    const row = await f.mobile.createTask({ title: 'Receipt validation', recurrence: 'daily' });
    await f.mobile.markAttempted(f.epoch, [row.id]);
    await expect(
      f.mobile.recordReceipts(
        f.epoch,
        [row.id],
        [{ operationId: row.id, status: 'applied', message: 'test', ...amounts }],
      ),
    ).rejects.toThrow();
    expect((await f.mobile.load()).outbox[0]?.status).toBe('pending');
  });

  it('rejects unknown negotiation values before writes and preserves operation fingerprints', () => {
    expect(() =>
      readSyncRequest({
        version: 2,
        type: 'push',
        epoch: 'epoch',
        operations: [],
        taskCreationReward: 10,
      }),
    ).toThrow();
    const operations: SyncOperation[] = [];
    expect(readSyncRequest({ version: 2, type: 'push', epoch: 'epoch', operations })).toEqual({
      version: 2,
      type: 'push',
      epoch: 'epoch',
      operations,
    });
  });
});
