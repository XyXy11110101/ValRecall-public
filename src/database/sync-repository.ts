import {
  isTaskScheduledOnDate,
  isLocalDateKey,
  localDateKey,
  type TaskCompletion,
  type DailyTask,
  type TaskSkip,
} from '../models/daily-task';
import {
  applyTaskCreationReward,
  applyTaskCompletionReward,
  applyTaskCompletionReversal,
  LEGACY_TASK_REWARD,
  spendAllowance,
  type TaskAllowanceResult,
} from '../shared/allowance';
import {
  readSyncOperation,
  readSyncSnapshot,
  readSyncTask,
  type SyncOperation,
  type SyncReceipt,
  type SyncSnapshot,
} from '../sync/contracts';
import {
  computerTimeZone,
  isRecord,
  isSyncId,
  isTimeZone,
  SyncDataError,
  SYNC_BATCH_LIMIT,
} from '../sync/protocol';
import { requestResult, transactionComplete } from './idb';
import { INDEX_NAMES, STORE_NAMES } from './migrations';
import { bumpContentRevision, contentRevision } from './sync-revision';
import {
  WalletRepository,
  putWallet,
  walletInTransaction,
  SYNC_EPOCH_KEY,
  SYNC_SEQUENCE_KEY,
  type DatabaseOpener,
  type LegacyWalletLoader,
} from './wallet';

export interface TaskRevision {
  taskId: string;
  revision: string;
  deleted: boolean;
}
export interface OccurrenceRevision {
  taskId: string;
  date: string;
  revision: string;
  rewarded: boolean | null;
  /** Missing only in backups/rows created before configurable task rewards. */
  rewardAmount?: number | null;
}
export interface StoredSyncReceipt {
  id: string;
  epoch: string;
  deviceId: string;
  fingerprint: string;
  receipt: SyncReceipt;
}
export interface AtomicTaskChange {
  changed: boolean;
  reward: TaskAllowanceResult | null;
  warning: string | null;
}
export const SYNC_TRANSACTION_STORES = [
  STORE_NAMES.dailyTasks,
  STORE_NAMES.taskCompletions,
  STORE_NAMES.wallet,
  STORE_NAMES.taskRevisions,
  STORE_NAMES.occurrenceRevisions,
  STORE_NAMES.syncReceipts,
  STORE_NAMES.taskSkips,
];

export function bumpTaskRevision(
  tx: IDBTransaction,
  taskId: string,
  deleted = false,
  revision: string = crypto.randomUUID(),
): void {
  tx.objectStore(STORE_NAMES.taskRevisions).put({
    taskId,
    revision,
    deleted,
  } satisfies TaskRevision);
  bumpContentRevision(tx);
}
export function bumpOccurrenceRevision(
  tx: IDBTransaction,
  taskId: string,
  date: string,
  rewarded: boolean | null,
  revision: string = crypto.randomUUID(),
  rewardAmount: number | null = rewarded === null ? null : rewarded ? LEGACY_TASK_REWARD : 0,
): void {
  tx.objectStore(STORE_NAMES.occurrenceRevisions).put({
    taskId,
    date,
    revision,
    rewarded,
    rewardAmount,
  } satisfies OccurrenceRevision);
  bumpContentRevision(tx);
}
export function occurrenceRewardAmount(row: OccurrenceRevision | undefined): number | null {
  if (row === undefined) return null;
  if (row.rewardAmount === undefined)
    return row.rewarded === null ? null : row.rewarded ? LEGACY_TASK_REWARD : 0;
  if (row.rewardAmount === null && row.rewarded === null) return null;
  if (
    typeof row.rewardAmount !== 'number' ||
    !Number.isSafeInteger(row.rewardAmount) ||
    row.rewardAmount < 0 ||
    row.rewarded !== row.rewardAmount > 0
  )
    throw new SyncDataError('任务奖励记录无效。');
  return row.rewardAmount;
}
export function rotateSyncEpoch(tx: IDBTransaction): void {
  tx.objectStore(STORE_NAMES.wallet).put({ key: SYNC_EPOCH_KEY, value: crypto.randomUUID() });
  tx.objectStore(STORE_NAMES.wallet).delete(SYNC_SEQUENCE_KEY);
  bumpContentRevision(tx);
}

export async function reviseImportedCompletion(
  tx: IDBTransaction,
  completion: TaskCompletion,
  alreadyCompleted: boolean,
): Promise<void> {
  const old = (await requestResult(
    tx.objectStore(STORE_NAMES.occurrenceRevisions).get([completion.taskId, completion.localDate]),
  )) as OccurrenceRevision | undefined;
  // A legacy completion has no proof of a grant. Keep that uncertainty rather than
  // converting historical data imported without rewards into a durable grant.
  const amount = old ? occurrenceRewardAmount(old) : alreadyCompleted ? null : 0;
  bumpOccurrenceRevision(
    tx,
    completion.taskId,
    completion.localDate,
    amount === null ? null : amount > 0,
    crypto.randomUUID(),
    amount,
  );
}

/** Wallet-retaining replacement/deletion must not erase what that wallet already paid. */
export async function preserveTaskProvenance(
  tx: IDBTransaction,
  completions: TaskCompletion[],
): Promise<void> {
  const taskKeys = await requestResult(tx.objectStore(STORE_NAMES.dailyTasks).getAllKeys());
  for (const key of taskKeys) {
    if (typeof key !== 'string') throw new Error('本机任务身份无效。');
    bumpTaskRevision(tx, key, true);
  }
  // Seed explicit unknown tombstones for old completions before their rows disappear.
  for (const completion of completions) await reviseImportedCompletion(tx, completion, true);
}

export class SyncRepository {
  readonly wallet: WalletRepository;
  private readonly clock: () => Date;
  constructor(
    private readonly database: DatabaseOpener,
    options: { clock?: () => Date; legacyLoader?: LegacyWalletLoader } = {},
  ) {
    this.wallet = new WalletRepository(database, options.legacyLoader);
    this.clock = options.clock ?? (() => new Date());
  }

  ensureWallet(): Promise<void> {
    return this.wallet.ensureWallet();
  }

  async getEpoch(): Promise<string> {
    await this.ensureWallet();
    const tx = (await this.database.open()).transaction(STORE_NAMES.wallet, 'readwrite');
    const done = transactionComplete(tx);
    const row: unknown = await requestResult(
      tx.objectStore(STORE_NAMES.wallet).get(SYNC_EPOCH_KEY),
    );
    if (row !== undefined && (!isRecord(row) || !isSyncId(row.value)))
      throw new SyncDataError('同步身份无效，请检查本机数据。');
    const epoch = isRecord(row) && typeof row.value === 'string' ? row.value : crypto.randomUUID();
    if (row === undefined)
      tx.objectStore(STORE_NAMES.wallet).put({ key: SYNC_EPOCH_KEY, value: epoch });
    await done;
    return epoch;
  }

  async getSnapshot(timeZone: string): Promise<SyncSnapshot> {
    if (!isTimeZone(timeZone)) throw new SyncDataError('电脑时区无效。');
    await this.getEpoch();
    const tx = (await this.database.open()).transaction(SYNC_TRANSACTION_STORES, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const revision = await contentRevision(tx);
      const [tasks, completions, revisions, occurrences, wallet, epoch, sequenceRow, taskSkips] =
        await Promise.all([
          requestResult(tx.objectStore(STORE_NAMES.dailyTasks).getAll()) as Promise<unknown[]>,
          requestResult(tx.objectStore(STORE_NAMES.taskCompletions).getAll()) as Promise<
            TaskCompletion[]
          >,
          requestResult(tx.objectStore(STORE_NAMES.taskRevisions).getAll()) as Promise<
            TaskRevision[]
          >,
          requestResult(tx.objectStore(STORE_NAMES.occurrenceRevisions).getAll()) as Promise<
            OccurrenceRevision[]
          >,
          walletInTransaction(tx),
          requestResult(tx.objectStore(STORE_NAMES.wallet).get(SYNC_EPOCH_KEY)) as Promise<{
            value: string;
          }>,
          requestResult<unknown>(tx.objectStore(STORE_NAMES.wallet).get(SYNC_SEQUENCE_KEY)),
          requestResult(tx.objectStore(STORE_NAMES.taskSkips).getAll()),
        ]);
      let sequence = 1;
      if (sequenceRow !== undefined) {
        if (
          typeof sequenceRow !== 'object' ||
          sequenceRow === null ||
          !('epoch' in sequenceRow) ||
          sequenceRow.epoch !== epoch.value ||
          !('value' in sequenceRow) ||
          typeof sequenceRow.value !== 'number' ||
          !Number.isSafeInteger(sequenceRow.value) ||
          sequenceRow.value < 1 ||
          sequenceRow.value === Number.MAX_SAFE_INTEGER
        )
          throw new SyncDataError('同步序号无效，请检查电脑数据。');
        sequence = sequenceRow.value + 1;
      }
      tx.objectStore(STORE_NAMES.wallet).put({
        key: SYNC_SEQUENCE_KEY,
        epoch: epoch.value,
        value: sequence,
      });
      await done;
      const byTask = new Map(revisions.map((row) => [row.taskId, row.revision]));
      const byOccurrence = new Map(
        occurrences.map((row) => [JSON.stringify([row.taskId, row.date]), row]),
      );
      for (const entry of completions) {
        const key = JSON.stringify([entry.taskId, entry.localDate]);
        if (!byOccurrence.has(key))
          byOccurrence.set(key, {
            taskId: entry.taskId,
            date: entry.localDate,
            revision: 'legacy',
            rewarded: null,
          });
      }
      try {
        return readSyncSnapshot({
          version: 2,
          contentRevision: revision,
          sequence,
          epoch: epoch.value,
          generatedAt: this.clock().toISOString(),
          timeZone,
          tasks: tasks.map((value) => {
            const task = readSyncTask(value);
            return { task, revision: byTask.get(task.id) ?? 'legacy' };
          }),
          completions,
          occurrences: [...byOccurrence.values()].map((row) => ({
            taskId: row.taskId,
            date: row.date,
            revision: row.revision,
            rewardAmount: occurrenceRewardAmount(row),
          })),
          taskSkips,
          wallet,
        });
      } catch {
        throw new SyncDataError('电脑任务快照无效，请检查数据。');
      }
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  /** Only two small metadata rows; no initialization, snapshot, wallet or task reads. */
  async getChangeState(timeZone: string) {
    if (!isTimeZone(timeZone)) throw new SyncDataError('电脑时区无效。');
    const tx = (await this.database.open()).transaction(STORE_NAMES.wallet, 'readonly');
    const done = transactionComplete(tx);
    try {
      const [epoch, revision] = await Promise.all([
        requestResult<unknown>(tx.objectStore(STORE_NAMES.wallet).get(SYNC_EPOCH_KEY)),
        contentRevision(tx),
      ]);
      await done;
      if (!isRecord(epoch) || !isSyncId(epoch.value)) throw new SyncDataError('同步身份无效。');
      return { epoch: epoch.value, contentRevision: revision, timeZone };
    } catch (error) {
      await done.catch(() => undefined);
      throw error;
    }
  }

  async applyOperations(
    epoch: string,
    deviceId: string,
    operations: SyncOperation[],
    creationRewards = false,
  ): Promise<SyncReceipt[]> {
    if (
      !isSyncId(epoch) ||
      !isSyncId(deviceId) ||
      !Array.isArray(operations) ||
      operations.length > SYNC_BATCH_LIMIT
    )
      throw new Error('同步操作批次无效。');
    const valid = operations.map(readSyncOperation);
    if (new Set(valid.map((op) => op.id)).size !== valid.length)
      throw new Error('同步批次含重复操作。');
    await this.getEpoch();
    const receipts: SyncReceipt[] = [];
    for (const operation of valid) {
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(operation)),
      );
      const fingerprint = [...new Uint8Array(hash)]
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('');
      const saved = await this.applyOperation(
        epoch,
        deviceId,
        operation,
        fingerprint,
        creationRewards,
      );
      receipts.push({
        ...saved,
        walletDelta:
          saved.walletDelta ??
          (saved.status !== 'applied'
            ? 0
            : operation.kind === 'spend-allowance'
              ? -operation.amount
              : saved.reward),
      });
    }
    return receipts;
  }

  private async applyOperation(
    epoch: string,
    deviceId: string,
    operation: SyncOperation,
    fingerprint: string,
    creationRewards: boolean,
  ): Promise<SyncReceipt> {
    const tx = (await this.database.open()).transaction(SYNC_TRANSACTION_STORES, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const receiptStore = tx.objectStore(STORE_NAMES.syncReceipts);
      const [currentEpoch, saved] = await Promise.all([
        requestResult(tx.objectStore(STORE_NAMES.wallet).get(SYNC_EPOCH_KEY)) as Promise<{
          value: string;
        }>,
        requestResult(receiptStore.get(operation.id)) as Promise<StoredSyncReceipt | undefined>,
      ]);
      if (currentEpoch?.value !== epoch) throw new Error('EPOCH_CHANGED');
      if (saved) {
        await done;
        return saved.epoch === epoch &&
          saved.deviceId === deviceId &&
          saved.fingerprint === fingerprint
          ? saved.receipt
          : receipt(operation.id, 'conflict', 0, '相同操作标识对应不同内容或设备。');
      }
      let result: SyncReceipt;
      if (operation.kind === 'spend-allowance') {
        const spent = spendAllowance(await walletInTransaction(tx), operation.amount, {
          note: operation.note,
          at: operation.at,
          date: localDateKey(new Date(operation.at)),
        });
        if (spent.ok) {
          putWallet(tx, spent.value);
          result = {
            ...receipt(operation.id, 'applied', 0, '扣款已记录。'),
            walletDelta: -operation.amount,
          };
        } else result = receipt(operation.id, 'conflict', 0, spent.error.message);
      } else {
        const taskId = operation.kind === 'create-task' ? operation.task.id : operation.taskId;
        const [rawTask, taskRevision] = await Promise.all([
          requestResult(tx.objectStore(STORE_NAMES.dailyTasks).get(taskId)) as Promise<unknown>,
          requestResult(tx.objectStore(STORE_NAMES.taskRevisions).get(taskId)) as Promise<
            TaskRevision | undefined
          >,
        ]);
        if (operation.kind === 'create-task') {
          if (rawTask !== undefined || taskRevision !== undefined)
            result = receipt(operation.id, 'conflict', 0, '任务标识已被使用。');
          else {
            const awarded = creationRewards
              ? applyTaskCreationReward(
                  await walletInTransaction(tx),
                  localDateKey(new Date(operation.at)),
                  operation.at,
                )
              : null;
            if (awarded) putWallet(tx, awarded.state);
            tx.objectStore(STORE_NAMES.dailyTasks).add(operation.task);
            bumpTaskRevision(tx, taskId, false, operation.id);
            result = receipt(
              operation.id,
              'applied',
              awarded?.reward ?? 0,
              awarded
                ? __VALRECALL_PUBLIC_RELEASE__
                  ? '待办已创建。'
                  : '待办已创建，+5 元零花钱。'
                : '任务已保存。',
            );
          }
        } else if (
          rawTask === undefined ||
          taskRevision?.deleted ||
          (taskRevision?.revision ?? 'legacy') !== operation.taskRevision
        ) {
          result = receipt(operation.id, 'conflict', 0, '任务已修改或删除，请同步后重新确认。');
        } else {
          result = await this.applyTaskOperation(tx, readStoredTask(rawTask), operation);
        }
      }
      receiptStore.add({
        id: operation.id,
        epoch,
        deviceId,
        fingerprint,
        receipt: result,
      } satisfies StoredSyncReceipt);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  private async applyTaskOperation(
    tx: IDBTransaction,
    task: DailyTask,
    operation: Exclude<SyncOperation, { kind: 'create-task' | 'spend-allowance' }>,
    desktopUnrewardedDate = false,
  ): Promise<SyncReceipt> {
    const date = operation.occurrenceDate ?? operation.date;
    const completions = tx.objectStore(STORE_NAMES.taskCompletions);
    const skips = tx.objectStore(STORE_NAMES.taskSkips);
    const [existing, occurrence, skipped, taskCompletions] = await Promise.all([
      requestResult(
        completions.index(INDEX_NAMES.completionTaskAndDate).get([task.id, date]),
      ) as Promise<TaskCompletion | undefined>,
      requestResult(
        tx.objectStore(STORE_NAMES.occurrenceRevisions).get([task.id, date]),
      ) as Promise<OccurrenceRevision | undefined>,
      requestResult(skips.get([task.id, date])) as Promise<TaskSkip | undefined>,
      task.recurrence === 'specific_date'
        ? (requestResult(completions.index(INDEX_NAMES.completionTask).getAll(task.id)) as Promise<
            TaskCompletion[]
          >)
        : Promise.resolve([]),
    ]);
    const revision = occurrence?.revision ?? (existing ? 'legacy' : null);
    const result = (status: SyncReceipt['status'], message: string, walletDelta = 0) => ({
      ...receipt(operation.id, status, Math.max(0, walletDelta), message),
      walletDelta,
    });
    // A completed one-off stays completed even if its scheduled date is later edited.
    if (operation.kind === 'complete-task' && (existing || taskCompletions.length > 0))
      return result('duplicate', '已完成。');
    if (operation.kind === 'complete-task' && task.recurrence === 'specific_date') {
      const history = await requestResult<OccurrenceRevision[]>(
        tx
          .objectStore(STORE_NAMES.occurrenceRevisions)
          .getAll(IDBKeyRange.bound([task.id], [task.id, []])),
      );
      if (history.some((row) => row.date !== date && occurrenceRewardAmount(row) !== 0))
        return result('conflict', '这项一次性待办已有历史结算，请在电脑核对。');
    }
    if (revision !== operation.occurrenceRevision)
      return result('conflict', '这项待办已变更，请同步后核对。');
    if (operation.kind === 'archive-task') {
      if (task.recurrence !== 'specific_date' || taskCompletions.length > 0)
        return result('conflict', '请先撤销完成；重复待办只能跳过本次。');
      if (task.archived) return result('duplicate', '已取消待办。');
      tx.objectStore(STORE_NAMES.dailyTasks).put({
        ...task,
        archived: true,
        updatedAt: operation.at,
      });
      bumpTaskRevision(tx, task.id, false, operation.id);
      return result('applied', '已取消待办。');
    }
    const originalReward = occurrenceRewardAmount(occurrence);
    if (operation.kind === 'undo-task') {
      if (!existing) return result('duplicate', '已经是未完成状态。');
      const unknown = originalReward === null;
      if (originalReward !== null && originalReward > 0) {
        const reversal = applyTaskCompletionReversal(
          await walletInTransaction(tx),
          operation.date,
          operation.at,
          originalReward,
        );
        putWallet(tx, reversal.state);
      }
      completions.delete(existing.id);
      bumpOccurrenceRevision(
        tx,
        task.id,
        date,
        unknown ? null : false,
        operation.id,
        unknown ? null : 0,
      );
      return result(
        'applied',
        unknown ? '历史奖励金额无法确认。' : '已撤销完成。',
        -(originalReward ?? 0),
      );
    }
    if (operation.kind === 'skip-task' || operation.kind === 'restore-task') {
      if (
        task.recurrence === 'specific_date' ||
        date !== operation.date ||
        !isTaskScheduledOnDate(task, date) ||
        existing
      )
        return result('conflict', '该次待办已变更，请同步后核对。');
      if (operation.kind === 'skip-task') {
        if (skipped) return result('duplicate', '今天已跳过。');
        skips.put({ taskId: task.id, date, skippedAt: operation.at } satisfies TaskSkip);
      } else {
        if (!skipped) return result('duplicate', '已经恢复。');
        skips.delete([task.id, date]);
      }
      const amount = occurrence ? originalReward : 0;
      bumpOccurrenceRevision(
        tx,
        task.id,
        date,
        amount === null ? null : amount > 0,
        operation.id,
        amount,
      );
      return result(
        'applied',
        operation.kind === 'skip-task' ? '今天已跳过。' : '已恢复今天的待办。',
      );
    }
    const eligible =
      task.recurrence === 'specific_date'
        ? !task.archived && task.scheduledDate === date && date <= operation.date
        : (date === operation.date || desktopUnrewardedDate) && isTaskScheduledOnDate(task, date);
    if (!eligible || skipped) return result('conflict', '该次待办已变更，请同步后核对。');
    const preservedGrant = occurrence !== undefined && originalReward !== 0;
    const reward =
      preservedGrant || desktopUnrewardedDate
        ? null
        : applyTaskCompletionReward(await walletInTransaction(tx), operation.date, operation.at);
    if (reward) putWallet(tx, reward.state);
    completions.add({
      id: crypto.randomUUID(),
      taskId: task.id,
      localDate: date,
      completedAt: operation.at,
    } satisfies TaskCompletion);
    const amount = reward ? reward.reward : occurrence ? originalReward : 0;
    bumpOccurrenceRevision(
      tx,
      task.id,
      date,
      amount === null ? null : amount > 0,
      operation.id,
      amount,
    );
    return result(
      'applied',
      amount === null ? '历史奖励金额无法确认。' : '已完成。',
      reward?.reward ?? 0,
    );
  }

  async changeTaskCompletionAtomic(
    taskId: string,
    date: string,
    completed: boolean,
    now: Date,
  ): Promise<AtomicTaskChange> {
    if (!isLocalDateKey(date) || !Number.isFinite(now.getTime())) throw new Error('任务日期无效。');
    await this.ensureWallet();
    const tx = (await this.database.open()).transaction(SYNC_TRANSACTION_STORES, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const rawTask: unknown = await requestResult(
        tx.objectStore(STORE_NAMES.dailyTasks).get(taskId),
      );
      if (rawTask === undefined) throw new Error('任务不存在。');
      const task = readSyncTask(rawTask);
      const operationDate = localDateKey(now);
      const occurrence = (await requestResult(
        tx.objectStore(STORE_NAMES.occurrenceRevisions).get([taskId, date]),
      )) as OccurrenceRevision | undefined;
      const existing = (await requestResult(
        tx
          .objectStore(STORE_NAMES.taskCompletions)
          .index(INDEX_NAMES.completionTaskAndDate)
          .get([taskId, date]),
      )) as TaskCompletion | undefined;
      if (completed === Boolean(existing)) {
        await done;
        return { changed: false, reward: null, warning: null };
      }
      const result = await this.applyTaskOperation(
        tx,
        task,
        {
          id: crypto.randomUUID(),
          kind: completed ? 'complete-task' : 'undo-task',
          at: now.toISOString(),
          date: operationDate,
          timeZone: computerTimeZone(),
          taskId,
          taskRevision: 'desktop',
          occurrenceDate: date,
          occurrenceRevision: occurrence?.revision ?? (existing ? 'legacy' : null),
        },
        completed && task.recurrence !== 'specific_date' && date !== operationDate,
      );
      if (result.status === 'conflict') throw new Error(result.message);
      const delta = result.walletDelta ?? 0;
      const reward =
        delta === 0 ? null : { state: await walletInTransaction(tx), reward: Math.abs(delta) };
      await done;
      return {
        changed: result.status === 'applied',
        reward,
        warning: result.message.startsWith('历史奖励') ? result.message : null,
      };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  /**
   * The desktop's 今天不做 and 恢复今天. Runs the same rules as the phone's operations, so a
   * skip writes no task row, keeps the occurrence's reward state and moves no money.
   */
  async changeTaskSkipAtomic(
    kind: 'skip-task' | 'restore-task',
    taskId: string,
    date: string,
    now: Date,
  ): Promise<{ changed: boolean }> {
    if (!isLocalDateKey(date) || !Number.isFinite(now.getTime())) throw new Error('任务日期无效。');
    await this.ensureWallet();
    const tx = (await this.database.open()).transaction(SYNC_TRANSACTION_STORES, 'readwrite');
    const done = transactionComplete(tx);
    try {
      const rawTask: unknown = await requestResult(
        tx.objectStore(STORE_NAMES.dailyTasks).get(taskId),
      );
      if (rawTask === undefined) throw new Error('任务不存在。');
      const task = readSyncTask(rawTask);
      const occurrence = (await requestResult(
        tx.objectStore(STORE_NAMES.occurrenceRevisions).get([taskId, date]),
      )) as OccurrenceRevision | undefined;
      const existing = (await requestResult(
        tx
          .objectStore(STORE_NAMES.taskCompletions)
          .index(INDEX_NAMES.completionTaskAndDate)
          .get([taskId, date]),
      )) as TaskCompletion | undefined;
      const result = await this.applyTaskOperation(tx, task, {
        id: crypto.randomUUID(),
        kind,
        at: now.toISOString(),
        date: localDateKey(now),
        timeZone: computerTimeZone(),
        taskId,
        taskRevision: 'desktop',
        occurrenceDate: date,
        occurrenceRevision: occurrence?.revision ?? (existing ? 'legacy' : null),
      });
      if (result.status === 'conflict') throw new Error(result.message);
      await done;
      return { changed: result.status === 'applied' };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }
}

function receipt(
  operationId: string,
  status: SyncReceipt['status'],
  reward: number,
  message: string,
): SyncReceipt {
  return { operationId, status, reward, message };
}

function readStoredTask(value: unknown): DailyTask {
  try {
    return readSyncTask(value);
  } catch {
    throw new SyncDataError('本地任务数据无效。');
  }
}
