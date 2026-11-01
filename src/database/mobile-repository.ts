import { consumeDraft, type DraftToken } from './drafts';
import { editState } from './edit-commit';
export interface MobileDraftCommit {
  id: string;
  epoch: string;
  draft?: DraftToken;
}
import {
  isTaskScheduledOnDate,
  type DailyTask,
  type TaskPriority,
  type TaskRecurrence,
  type TaskCompletion,
  type TaskSkip,
} from '../models/daily-task';
import {
  isSyncReceipt,
  readSyncOperation,
  readSyncSnapshot,
  readStoredSyncSnapshot,
  type SyncOperation,
  type SyncReceipt,
  type SyncSnapshot,
} from '../sync/contracts';
import { dateInTimeZone, isRecord, isSyncId } from '../sync/protocol';
import { requestResult, transactionComplete } from './idb';
import { TASK_REWARD } from '../shared/allowance';

export interface MobileOutboxEntry {
  id: string;
  epoch: string;
  operation: SyncOperation;
  attempted: boolean;
  status: 'pending' | 'acknowledged' | 'conflict' | 'isolated';
  receipt: SyncReceipt | null;
  sequence: number;
  /** Local reservation only; never trusted or sent as an authoritative reward. */
  reservedAmount?: number | null;
}

export interface MobileArchive {
  id: string;
  epoch: string;
  archivedAt: string;
  snapshot: SyncSnapshot;
}

export interface MobileState {
  epoch: string | null;
  snapshot: SyncSnapshot | null;
  outbox: MobileOutboxEntry[];
  archives: MobileArchive[];
}

interface MobileMeta {
  id: 'current';
  epoch: string | null;
  snapshot: SyncSnapshot | null;
  nextSequence: number;
}

export interface MobileTaskDraft {
  title: string;
  notes?: string | null;
  recurrence: TaskRecurrence;
  selectedWeekdays?: number[];
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  priority?: TaskPriority;
}

export class MobileRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MobileRepositoryOptions {
  indexedDBFactory?: IDBFactory;
  databaseName?: string;
  clock?: () => Date;
  idGenerator?: () => string;
}

const STORES = ['state', 'outbox', 'archives', 'drafts'] as const;
const emptyMeta = (): MobileMeta => ({
  id: 'current',
  epoch: null,
  snapshot: null,
  nextSequence: 1,
});

function fail(message = '手机数据格式无效。'): never {
  throw new MobileRepositoryError('INVALID_DATA', message);
}

function readMeta(value: unknown): MobileMeta {
  if (value === undefined) return emptyMeta();
  if (
    !isRecord(value) ||
    value.id !== 'current' ||
    (value.epoch !== null && !isSyncId(value.epoch)) ||
    !Number.isSafeInteger(value.nextSequence) ||
    typeof value.nextSequence !== 'number' ||
    value.nextSequence < 1
  )
    fail();
  const snapshot = value.snapshot === null ? null : readStoredSyncSnapshot(value.snapshot);
  if (snapshot && snapshot.epoch !== value.epoch) fail();
  return { id: 'current', epoch: value.epoch, snapshot, nextSequence: value.nextSequence };
}

function readEntry(value: unknown): MobileOutboxEntry {
  if (
    !isRecord(value) ||
    !isSyncId(value.id) ||
    !isSyncId(value.epoch) ||
    typeof value.attempted !== 'boolean' ||
    typeof value.status !== 'string' ||
    !['pending', 'acknowledged', 'conflict', 'isolated'].includes(value.status) ||
    typeof value.sequence !== 'number' ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.reservedAmount !== undefined &&
      value.reservedAmount !== null &&
      (typeof value.reservedAmount !== 'number' ||
        !Number.isSafeInteger(value.reservedAmount) ||
        value.reservedAmount < 0)) ||
    (value.receipt !== null && !isSyncReceipt(value.receipt))
  )
    fail();
  const operation = readSyncOperation(value.operation);
  if (
    operation.id !== value.id ||
    (value.receipt !== null && value.receipt.operationId !== value.id) ||
    (value.status === 'pending' && value.receipt !== null) ||
    (value.status === 'acknowledged' &&
      (!value.attempted || value.receipt === null || value.receipt.status === 'conflict')) ||
    (value.status === 'conflict' && (!value.attempted || value.receipt?.status !== 'conflict'))
  )
    fail();
  return {
    id: value.id,
    epoch: value.epoch,
    operation,
    attempted: value.attempted,
    status: value.status as MobileOutboxEntry['status'],
    receipt: value.receipt,
    sequence: value.sequence,
    ...(value.reservedAmount !== undefined
      ? { reservedAmount: value.reservedAmount as number | null }
      : {}),
  };
}

function readArchive(value: unknown): MobileArchive {
  if (
    !isRecord(value) ||
    !isSyncId(value.id) ||
    !isSyncId(value.epoch) ||
    typeof value.archivedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.archivedAt))
  )
    fail();
  const snapshot = readStoredSyncSnapshot(value.snapshot);
  if (snapshot.epoch !== value.epoch) fail();
  return { id: value.id, epoch: value.epoch, archivedAt: value.archivedAt, snapshot };
}

function active(entry: MobileOutboxEntry, epoch: string | null): boolean {
  return entry.epoch === epoch && (entry.status === 'pending' || entry.status === 'acknowledged');
}

/** Pending creates remain visible while a coherent confirmed snapshot is being downloaded. */
export function mobileVisibleTasks(
  state: Pick<MobileState, 'epoch' | 'snapshot' | 'outbox'>,
): SyncSnapshot['tasks'] {
  const tasks = new Map(
    state.snapshot?.tasks.map((entry) => [entry.task.id, structuredClone(entry)]) ?? [],
  );
  for (const entry of state.outbox) {
    if (active(entry, state.epoch) && entry.operation.kind === 'archive-task') {
      const current = tasks.get(entry.operation.taskId);
      if (current)
        tasks.set(current.task.id, {
          task: { ...current.task, archived: true },
          revision: entry.id,
        });
      continue;
    }
    if (
      !active(entry, state.epoch) ||
      entry.operation.kind !== 'create-task' ||
      tasks.has(entry.operation.task.id)
    )
      continue;
    tasks.set(entry.operation.task.id, {
      task: structuredClone(entry.operation.task),
      revision: entry.id,
    });
  }
  return [...tasks.values()];
}

export function mobileCompletionState(
  state: Pick<MobileState, 'epoch' | 'snapshot' | 'outbox'>,
  taskId: string,
  date: string,
): 'confirmed' | 'pending' | 'open' {
  const row = mobileTaskProjection(state).completions.find(
    (entry) => entry.taskId === taskId && entry.localDate === date,
  );
  if (!row) return 'open';
  return row.pending ? 'pending' : 'confirmed';
}

export function mobileTaskProjection(state: Pick<MobileState, 'epoch' | 'snapshot' | 'outbox'>) {
  const key = (taskId: string, date: string) => JSON.stringify([taskId, date]);
  const completions = new Map<string, TaskCompletion & { pending: boolean }>(
    (state.snapshot?.completions ?? []).map((row) => [
      key(row.taskId, row.localDate),
      { ...row, pending: false },
    ]),
  );
  const skips = new Map<string, TaskSkip & { pending: boolean }>(
    (state.snapshot?.taskSkips ?? []).map((row) => [
      key(row.taskId, row.date),
      { ...row, pending: false },
    ]),
  );
  const occurrences = new Map(
    (state.snapshot?.occurrences ?? []).map((row) => [
      key(row.taskId, row.date),
      { ...row, rewardAmount: row.rewardAmount ?? null },
    ]),
  );
  for (const entry of state.outbox) {
    const op = entry.operation;
    if (
      !active(entry, state.epoch) ||
      op.kind === 'create-task' ||
      op.kind === 'spend-allowance' ||
      op.kind === 'archive-task'
    )
      continue;
    const date = op.occurrenceDate ?? op.date;
    const id = key(op.taskId, date);
    let amount = occurrences.get(id)?.rewardAmount ?? null;
    if (op.kind === 'complete-task') {
      if (!completions.has(id)) {
        completions.set(id, {
          id: op.id,
          taskId: op.taskId,
          localDate: date,
          completedAt: op.at,
          pending: true,
        });
        amount = entry.receipt
          ? entry.receipt.reward
          : occurrences.has(id)
            ? amount === 0
              ? TASK_REWARD
              : amount
            : TASK_REWARD;
      }
    } else if (op.kind === 'undo-task') {
      completions.delete(id);
      amount = amount === null ? null : 0;
    } else if (op.kind === 'skip-task') {
      skips.set(id, { taskId: op.taskId, date, skippedAt: op.at, pending: true });
    } else skips.delete(id);
    occurrences.set(id, { taskId: op.taskId, date, revision: op.id, rewardAmount: amount });
  }
  return {
    completions: [...completions.values()],
    skips: [...skips.values()],
    occurrences: [...occurrences.values()],
  };
}

export function mobileAvailableBalance(
  state: Pick<MobileState, 'epoch' | 'snapshot' | 'outbox'>,
): number {
  let balance = state.snapshot?.wallet.balance ?? 0;
  for (const row of state.outbox) {
    if (!active(row, state.epoch)) continue;
    if (row.operation.kind === 'spend-allowance') balance -= row.operation.amount;
    if (row.operation.kind === 'undo-task') {
      const amount =
        row.receipt?.walletDelta !== undefined
          ? Math.max(0, -row.receipt.walletDelta)
          : row.reservedAmount;
      if (amount === undefined || amount === null) return 0;
      balance -= amount;
    }
  }
  return Math.max(0, balance);
}

/** A separate database: never opens or upgrades the desktop learning database. */
export class MobileRepository {
  readonly databaseName: string;
  private readonly factory: IDBFactory;
  private readonly clock: () => Date;
  private readonly id: () => string;
  private pending: Promise<IDBDatabase> | undefined;
  private generation = 0;

  constructor(options: MobileRepositoryOptions = {}) {
    this.factory = options.indexedDBFactory ?? indexedDB;
    this.databaseName = options.databaseName ?? 'valrecall-mobile';
    this.clock = options.clock ?? (() => new Date());
    this.id = options.idGenerator ?? (() => crypto.randomUUID());
  }

  close(): void {
    const connection = this.pending;
    this.pending = undefined;
    this.generation++;
    void connection?.then((database) => database.close()).catch(() => undefined);
  }

  async load(): Promise<MobileState> {
    const database = await this.open();
    const transaction = database.transaction([...STORES], 'readonly');
    const done = transactionComplete(transaction);
    const [metaValue, rows, archiveRows] = await Promise.all([
      requestResult<unknown>(transaction.objectStore('state').get('current')),
      requestResult<unknown[]>(transaction.objectStore('outbox').getAll()),
      requestResult<unknown[]>(transaction.objectStore('archives').getAll()),
    ]);
    await done;
    const meta = readMeta(metaValue);
    return {
      epoch: meta.epoch,
      snapshot: meta.snapshot,
      outbox: rows.map(readEntry).sort((left, right) => left.sequence - right.sequence),
      archives: archiveRows.map(readArchive),
    };
  }

  async createTask(
    draft: MobileTaskDraft,
    now = this.clock(),
    commit?: MobileDraftCommit,
  ): Promise<MobileOutboxEntry> {
    return this.mutate((meta, rows, transaction) =>
      this.draftOperation(commit, editState(['create-task', draft]), meta, transaction, () => {
        const snapshot = this.requireSnapshot(meta);
        const at = now.toISOString();
        const task: DailyTask = {
          id: commit ? 'task-' + commit.id : this.id(),
          schemaVersion: 1,
          title: draft.title.trim(),
          notes: draft.notes?.trim() || null,
          kind: draft.recurrence === 'specific_date' ? 'one_off' : 'routine',
          recurrence: draft.recurrence,
          scheduledDate:
            draft.recurrence === 'specific_date'
              ? (draft.scheduledDate ?? dateInTimeZone(now, snapshot.timeZone))
              : null,
          scheduledTime: draft.scheduledTime ?? null,
          selectedWeekdays:
            draft.recurrence === 'selected_weekdays' ? [...(draft.selectedWeekdays ?? [])] : [],
          linkedLearningItemId: null,
          priority: draft.priority ?? 'normal',
          archived: false,
          createdAt: at,
          updatedAt: at,
        };
        return this.addCreate(meta, rows, transaction, task, commit?.id);
      }),
    );
  }

  async enqueueCreate(task: DailyTask): Promise<MobileOutboxEntry> {
    return this.mutate((meta, rows, transaction) => this.addCreate(meta, rows, transaction, task));
  }

  async enqueueCompletion(taskId: string, now = this.clock()): Promise<MobileOutboxEntry> {
    return this.mutate((meta, rows, transaction) => {
      const snapshot = this.requireSnapshot(meta);
      const date = dateInTimeZone(now, snapshot.timeZone);
      const state = { epoch: meta.epoch, snapshot, outbox: rows };
      const entry = mobileVisibleTasks(state).find((value) => value.task.id === taskId);
      const occurrenceDate =
        entry?.task.recurrence === 'specific_date' ? entry.task.scheduledDate! : date;
      const projection = mobileTaskProjection(state);
      const done = projection.completions.find(
        (row) =>
          row.taskId === taskId &&
          (entry?.task.recurrence === 'specific_date' || row.localDate === occurrenceDate),
      );
      if (done) {
        const pending = rows.find((row) => active(row, meta.epoch) && row.id === done.id);
        if (pending) return pending;
        throw new MobileRepositoryError('ALREADY_COMPLETED', '该任务已经完成。');
      }
      const eligible =
        entry &&
        !entry.task.archived &&
        (entry.task.recurrence === 'specific_date'
          ? occurrenceDate <= date
          : isTaskScheduledOnDate(entry.task, date));
      if (
        !eligible ||
        projection.skips.some((row) => row.taskId === taskId && row.date === occurrenceDate)
      )
        throw new MobileRepositoryError('TASK_UNAVAILABLE', '该任务今天不可完成，请先同步检查。');
      const operation = readSyncOperation({
        id: this.id(),
        kind: 'complete-task',
        at: now.toISOString(),
        taskId,
        date,
        timeZone: snapshot.timeZone,
        taskRevision: entry.revision,
        occurrenceDate,
        occurrenceRevision:
          projection.occurrences.find((row) => row.taskId === taskId && row.date === occurrenceDate)
            ?.revision ??
          (snapshot.completions.some(
            (row) => row.taskId === taskId && row.localDate === occurrenceDate,
          )
            ? 'legacy'
            : null),
      });
      return this.addOperation(meta, transaction, operation);
    });
  }

  async enqueueTaskAction(
    action: 'undo-task' | 'cancel-task' | 'restore-task',
    taskId: string,
    occurrenceDate?: string,
    now = this.clock(),
  ): Promise<MobileOutboxEntry | null> {
    return this.mutate((meta, rows, transaction) => {
      const snapshot = this.requireSnapshot(meta);
      const state = { epoch: meta.epoch, snapshot, outbox: rows };
      const task = mobileVisibleTasks(state).find((row) => row.task.id === taskId);
      if (!task || (task.task.archived && action !== 'undo-task'))
        throw new MobileRepositoryError('TASK_UNAVAILABLE', '待办已变更，请先同步。');
      const date = dateInTimeZone(now, snapshot.timeZone);
      const targetDate =
        occurrenceDate ??
        (task.task.recurrence === 'specific_date' ? task.task.scheduledDate! : date);
      const projection = mobileTaskProjection(state);
      const completion = projection.completions.find(
        (row) => row.taskId === taskId && row.localDate === targetDate,
      );
      const skipped = projection.skips.find(
        (row) => row.taskId === taskId && row.date === targetDate,
      );
      const occurrence = projection.occurrences.find(
        (row) => row.taskId === taskId && row.date === targetDate,
      );
      const kind =
        action === 'cancel-task'
          ? task.task.recurrence === 'specific_date'
            ? 'archive-task'
            : 'skip-task'
          : action;
      if ((kind === 'undo-task' && !completion) || (kind === 'restore-task' && !skipped))
        return null;
      if (kind === 'skip-task' && skipped) return null;
      if ((kind === 'archive-task' || kind === 'skip-task') && completion)
        throw new MobileRepositoryError('TASK_COMPLETED', '请先撤销完成。');
      if (
        (kind === 'skip-task' || kind === 'restore-task') &&
        (task.task.recurrence === 'specific_date' ||
          targetDate !== date ||
          !isTaskScheduledOnDate(task.task, date))
      )
        throw new MobileRepositoryError('TASK_UNAVAILABLE', '只能调整今天的重复待办。');
      const inverse = [...rows]
        .reverse()
        .find(
          (row) =>
            active(row, meta.epoch) &&
            ((kind === 'undo-task' && row.operation.kind === 'complete-task') ||
              (kind === 'restore-task' && row.operation.kind === 'skip-task')) &&
            'taskId' in row.operation &&
            row.operation.taskId === taskId &&
            (row.operation.occurrenceDate ?? row.operation.date) === targetDate,
        );
      if (inverse && !inverse.attempted && inverse.status === 'pending') {
        transaction.objectStore('outbox').delete(inverse.id);
        return null;
      }
      if (kind === 'archive-task') {
        const create = rows.find(
          (row) =>
            active(row, meta.epoch) &&
            row.operation.kind === 'create-task' &&
            row.operation.task.id === taskId,
        );
        const related = rows.filter(
          (row) =>
            row.epoch === meta.epoch &&
            (row.id === create?.id ||
              ('taskId' in row.operation && row.operation.taskId === taskId)),
        );
        if (create && related.every((row) => !row.attempted && row.status === 'pending')) {
          for (const row of related) transaction.objectStore('outbox').delete(row.id);
          return null;
        }
      }
      const operation = readSyncOperation({
        id: this.id(),
        kind,
        at: now.toISOString(),
        date,
        timeZone: snapshot.timeZone,
        taskId,
        taskRevision: task.revision,
        occurrenceDate: targetDate,
        occurrenceRevision: occurrence?.revision ?? (completion ? 'legacy' : null),
      });
      const entry = this.addOperation(meta, transaction, operation);
      if (kind === 'undo-task') {
        entry.reservedAmount = occurrence?.rewardAmount ?? null;
        transaction.objectStore('outbox').put(entry);
      }
      return entry;
    });
  }

  async cancelNeverSent(operationId: string): Promise<boolean> {
    return this.mutate((meta, rows, transaction) => {
      const target = rows.find((entry) => entry.id === operationId && entry.epoch === meta.epoch);
      if (!target) return false;
      if (target.attempted || target.status !== 'pending')
        throw new MobileRepositoryError(
          'CANCEL_UNSAFE',
          '这个操作已发给电脑，不能在手机取消，请先同步。',
        );
      const createdTaskId =
        target.operation.kind === 'create-task' ? target.operation.task.id : null;
      const removed =
        createdTaskId !== null
          ? rows.filter(
              (entry) =>
                entry.epoch === meta.epoch &&
                (entry.id === operationId ||
                  ('taskId' in entry.operation && entry.operation.taskId === createdTaskId)),
            )
          : [target];
      if (
        createdTaskId === null &&
        rows.some(
          (row) =>
            active(row, meta.epoch) &&
            'occurrenceRevision' in row.operation &&
            row.operation.occurrenceRevision === target.id,
        )
      )
        throw new MobileRepositoryError('CANCEL_UNSAFE', '后续操作依赖此记录，请先同步。');
      if (removed.some((entry) => entry.attempted || entry.status !== 'pending'))
        throw new MobileRepositoryError('CANCEL_UNSAFE', '关联的完成已发给电脑，不能取消。');
      for (const entry of removed) transaction.objectStore('outbox').delete(entry.id);
      return true;
    });
  }

  /** Reserve only confirmed money. Queued rewards never fund an offline spend. */
  async enqueueSpend(
    amount: number,
    note = '',
    now = this.clock(),
    commit?: MobileDraftCommit,
  ): Promise<MobileOutboxEntry> {
    const operation = readSyncOperation({
      id: commit?.id ?? this.id(),
      kind: 'spend-allowance',
      at: now.toISOString(),
      amount,
      note: note.trim(),
    });
    return this.mutate((meta, rows, transaction) =>
      this.draftOperation(
        commit,
        editState(['spend', amount, note.trim()]),
        meta,
        transaction,
        () => {
          const snapshot = this.requireSnapshot(meta);
          const available = mobileAvailableBalance({ epoch: meta.epoch, snapshot, outbox: rows });
          if (amount > available)
            throw new MobileRepositoryError('INSUFFICIENT_BALANCE', '可用余额不足，请同步后重试。');
          return this.addOperation(meta, transaction, operation);
        },
      ),
    );
  }

  async markAttempted(epoch: string, expectedIds: readonly string[]): Promise<void> {
    await this.mutate((meta, rows, transaction) => {
      this.requireEpoch(meta, epoch);
      const entries = this.expectedEntries(rows, epoch, expectedIds);
      if (entries.some((entry) => entry.status !== 'pending'))
        fail('同步批次已经变化，请重新同步。');
      for (const entry of entries)
        transaction.objectStore('outbox').put({ ...entry, attempted: true });
    });
  }

  async recordReceipts(
    epoch: string,
    expectedIds: readonly string[],
    incoming: unknown,
  ): Promise<void> {
    if (
      !Array.isArray(incoming) ||
      incoming.length !== expectedIds.length ||
      !incoming.every(isSyncReceipt) ||
      new Set(incoming.map((receipt) => receipt.operationId)).size !== incoming.length ||
      incoming.some((receipt) => !expectedIds.includes(receipt.operationId))
    )
      fail('同步确认不一致，请重试。');
    await this.mutate((meta, rows, transaction) => {
      this.requireEpoch(meta, epoch);
      const entries = this.expectedEntries(rows, epoch, expectedIds);
      const byId = new Map(incoming.map((receipt) => [receipt.operationId, receipt]));
      for (const entry of entries) {
        const receipt = byId.get(entry.id);
        if (
          !receipt ||
          !entry.attempted ||
          entry.status === 'isolated' ||
          (receipt.status === 'conflict' && receipt.reward !== 0) ||
          (receipt.walletDelta !== undefined &&
            ((receipt.status !== 'applied' && receipt.walletDelta !== 0) ||
              (receipt.status === 'applied' &&
                (entry.operation.kind === 'spend-allowance'
                  ? receipt.walletDelta !== -entry.operation.amount
                  : entry.operation.kind === 'complete-task' ||
                      entry.operation.kind === 'create-task'
                    ? receipt.walletDelta !== receipt.reward
                    : entry.operation.kind === 'undo-task'
                      ? ![0, -2, -5].includes(receipt.walletDelta)
                      : receipt.walletDelta !== 0)))) ||
          (entry.operation.kind === 'create-task'
            ? ![0, 5].includes(receipt.reward) ||
              (receipt.reward === 5 && receipt.walletDelta !== 5) ||
              (receipt.status !== 'applied' && receipt.reward !== 0)
            : entry.operation.kind !== 'complete-task' && receipt.reward !== 0) ||
          (entry.receipt !== null && JSON.stringify(entry.receipt) !== JSON.stringify(receipt))
        )
          fail('同步确认无效，请重试。');
      }
      for (const entry of entries) {
        const receipt = byId.get(entry.id)!;
        transaction.objectStore('outbox').put({
          ...entry,
          receipt: structuredClone(receipt),
          status: receipt.status === 'conflict' ? 'conflict' : 'acknowledged',
        });
      }
    });
  }

  /** Acknowledgement IDs are fenced BEFORE pull, so later acknowledgements cannot be erased by an older snapshot. */
  async applySnapshot(input: unknown, acknowledgedIds: readonly string[] = []): Promise<void> {
    const snapshot = readSyncSnapshot(input);
    await this.mutate((meta, rows, transaction) => {
      if (meta.epoch !== null) this.requireEpoch(meta, snapshot.epoch);
      if (meta.snapshot?.version === 2) {
        if (snapshot.sequence < meta.snapshot.sequence) fail('收到较旧的数据，请重新同步。');
        if (snapshot.sequence === meta.snapshot.sequence) return;
      }
      for (const entry of rows) {
        if (
          entry.epoch === snapshot.epoch &&
          entry.status === 'acknowledged' &&
          acknowledgedIds.includes(entry.id)
        )
          transaction.objectStore('outbox').delete(entry.id);
      }
      transaction.objectStore('state').put({ ...meta, epoch: snapshot.epoch, snapshot });
    });
  }

  /** Only call after the user explicitly accepts a changed computer epoch. Old work stays recoverable. */
  async acceptNewEpoch(epoch: string): Promise<void> {
    if (!isSyncId(epoch)) fail('电脑数据版本无效。');
    await this.mutate((meta, rows, transaction) => {
      if (meta.epoch === epoch) return;
      if (meta.snapshot) {
        const archive: MobileArchive = {
          id: this.id(),
          epoch: meta.snapshot.epoch,
          archivedAt: this.clock().toISOString(),
          snapshot: meta.snapshot,
        };
        transaction.objectStore('archives').add(archive);
      }
      for (const entry of rows)
        if (entry.status !== 'isolated')
          transaction.objectStore('outbox').put({ ...entry, status: 'isolated' });
      transaction.objectStore('state').put({ ...meta, epoch, snapshot: null });
    });
  }

  private requireSnapshot(meta: MobileMeta): SyncSnapshot {
    if (!meta.snapshot || meta.epoch !== meta.snapshot.epoch)
      throw new MobileRepositoryError(
        'INITIAL_SYNC_REQUIRED',
        '请先连接电脑完成首次同步，再添加或完成待办。',
      );
    if (meta.snapshot.version !== 2)
      throw new MobileRepositoryError('UPGRADE_REQUIRED', '请先与新版电脑同步一次。');
    return meta.snapshot;
  }

  private requireEpoch(meta: MobileMeta, epoch: string): void {
    if (meta.epoch !== epoch) throw new MobileRepositoryError('EPOCH_CHANGED', '电脑数据已更换。');
  }

  private expectedEntries(
    rows: MobileOutboxEntry[],
    epoch: string,
    ids: readonly string[],
  ): MobileOutboxEntry[] {
    if (new Set(ids).size !== ids.length || ids.length === 0 || ids.some((id) => !isSyncId(id)))
      fail('同步批次无效。');
    return ids.map((id) => {
      const entry = rows.find((row) => row.id === id && row.epoch === epoch);
      if (!entry) fail('同步批次已不存在。');
      return entry;
    });
  }

  private addCreate(
    meta: MobileMeta,
    rows: MobileOutboxEntry[],
    transaction: IDBTransaction,
    task: DailyTask,
    operationId?: string,
  ): MobileOutboxEntry {
    this.requireSnapshot(meta);
    const operation = readSyncOperation({
      id: operationId ?? this.id(),
      kind: 'create-task',
      at: task.createdAt,
      task,
    });
    if (
      mobileVisibleTasks({ epoch: meta.epoch, snapshot: meta.snapshot, outbox: rows }).some(
        (entry) => entry.task.id === task.id,
      )
    )
      throw new MobileRepositoryError('DUPLICATE_TASK', '该任务已经存在。');
    return this.addOperation(meta, transaction, operation);
  }

  private addOperation(
    meta: MobileMeta,
    transaction: IDBTransaction,
    operation: SyncOperation,
  ): MobileOutboxEntry {
    const snapshot = this.requireSnapshot(meta);
    if (meta.nextSequence >= Number.MAX_SAFE_INTEGER) fail('手机记录序号已达上限。');
    const entry: MobileOutboxEntry = {
      id: operation.id,
      epoch: snapshot.epoch,
      operation,
      attempted: false,
      status: 'pending',
      receipt: null,
      sequence: meta.nextSequence,
    };
    transaction.objectStore('outbox').add(entry);
    transaction.objectStore('state').put({ ...meta, nextSequence: meta.nextSequence + 1 });
    return structuredClone(entry);
  }

  private async draftOperation(
    commit: MobileDraftCommit | undefined,
    fingerprint: string,
    meta: MobileMeta,
    transaction: IDBTransaction,
    action: () => MobileOutboxEntry,
  ): Promise<MobileOutboxEntry> {
    if (!commit) return action();
    if (!isSyncId(commit.id) || !isSyncId(commit.epoch)) fail('草稿操作身份无效。');
    this.requireEpoch(meta, commit.epoch);
    const store = transaction.objectStore('state');
    const id = 'draft-commit:' + commit.id;
    const previous: unknown = await requestResult(store.get(id));
    if (previous !== undefined) {
      if (
        !isRecord(previous) ||
        previous.schemaVersion !== 1 ||
        previous.fingerprint !== fingerprint ||
        previous.epoch !== commit.epoch
      )
        fail('这份草稿已提交，内容发生变化，请在记录中核对。');
      return readEntry(previous.entry);
    }
    const entry = action();
    await consumeDraft(transaction, commit.draft);
    store.add({ id, schemaVersion: 1, epoch: commit.epoch, fingerprint, entry });
    return entry;
  }

  private async mutate<T>(
    action: (
      meta: MobileMeta,
      entries: MobileOutboxEntry[],
      transaction: IDBTransaction,
    ) => T | Promise<T>,
  ): Promise<T> {
    const database = await this.open();
    const transaction = database.transaction([...STORES], 'readwrite');
    const done = transactionComplete(transaction);
    try {
      const [metaValue, values] = await Promise.all([
        requestResult<unknown>(transaction.objectStore('state').get('current')),
        requestResult<unknown[]>(transaction.objectStore('outbox').getAll()),
      ]);
      const value = await action(
        readMeta(metaValue),
        values.map(readEntry).sort((left, right) => left.sequence - right.sequence),
        transaction,
      );
      await done;
      return value;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* It may have already aborted. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  open(): Promise<IDBDatabase> {
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    const connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.databaseName, 3);
      let failed = false;
      request.addEventListener('upgradeneeded', () => {
        for (const name of STORES)
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name, { keyPath: 'id' });
        const drafts = request.transaction!.objectStore('drafts');
        if (!drafts.indexNames.contains('by-scope')) drafts.createIndex('by-scope', 'scope');
      });
      request.addEventListener('blocked', () => {
        failed = true;
        reject(new MobileRepositoryError('OPEN_BLOCKED', '请关闭旧的手机版窗口后重试。'));
      });
      request.addEventListener('error', () => {
        failed = true;
        reject(request.error ?? new Error('手机数据库无法打开。'));
      });
      request.addEventListener('success', () => {
        const database = request.result;
        if (failed || generation !== this.generation) {
          database.close();
          reject(new MobileRepositoryError('OPEN_CANCELLED', '手机数据库连接已关闭。'));
          return;
        }
        const invalidate = () => {
          database.close();
          if (generation === this.generation) this.pending = undefined;
        };
        database.addEventListener('versionchange', invalidate, { once: true });
        database.addEventListener('close', invalidate, { once: true });
        resolve(database);
      });
    });
    this.pending = connection;
    void connection.catch(() => {
      if (this.pending === connection) this.pending = undefined;
    });
    return connection;
  }
}
