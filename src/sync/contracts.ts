import {
  isDailyTaskKind,
  isLocalDateKey,
  isTaskPriority,
  isTaskRecurrence,
  taskValidationIssues,
  taskCompletionValidationIssues,
  type DailyTask,
  type TaskCompletion,
  type TaskSkip,
} from '../models/daily-task';
import {
  normalizeAllowance,
  type AllowanceState,
  type AllowanceLedgerEntry,
} from '../shared/allowance';
import { dateInTimeZone, isRecord, isSyncId, isTimeZone, SYNC_BATCH_LIMIT } from './protocol';

export type SyncOperation =
  | { id: string; kind: 'create-task'; at: string; task: DailyTask }
  | { id: string; kind: 'spend-allowance'; at: string; amount: number; note: string }
  | {
      id: string;
      kind: 'complete-task';
      at: string;
      date: string;
      timeZone: string;
      taskId: string;
      taskRevision: string;
      occurrenceRevision: string | null;
      /** Omitted only by operations queued before the v2 upgrade. */
      occurrenceDate?: string;
    }
  | {
      id: string;
      kind: 'undo-task' | 'skip-task' | 'restore-task' | 'archive-task';
      at: string;
      date: string;
      timeZone: string;
      taskId: string;
      taskRevision: string;
      occurrenceDate: string;
      occurrenceRevision: string | null;
    };

export interface SyncReceipt {
  operationId: string;
  status: 'applied' | 'duplicate' | 'conflict';
  reward: number;
  /** Missing only in durable pre-v2 receipts. */
  walletDelta?: number;
  message: string;
}

export interface SyncSnapshot {
  /** v1 is accepted only by the stored-cache reader, never over the network. */
  version: 1 | 2;
  sequence: number;
  /** Optional capability extension; accepted only with a fully persisted snapshot. */
  contentRevision?: string;
  epoch: string;
  generatedAt: string;
  timeZone: string;
  tasks: { task: DailyTask; revision: string }[];
  completions: TaskCompletion[];
  occurrences: { taskId: string; date: string; revision: string; rewardAmount?: number | null }[];
  taskSkips: TaskSkip[];
  wallet: AllowanceState;
}

export interface SyncChangeState {
  epoch: string;
  contentRevision: string;
  timeZone: string;
}

export type SyncRequest =
  | { version: 2; type: 'capabilities'; epoch: string }
  | { version: 2; type: 'change-state'; epoch: string }
  | { version: 2; type: 'push'; epoch: string; operations: SyncOperation[]; taskCreationReward?: 5 }
  | { version: 2; type: 'pull'; epoch: string; token: string | null; cursor: number };
export type SyncResponse =
  | {
      version: 2;
      type: 'capabilities';
      epoch: string;
      protocol: 2;
      wallet: 2;
      changeProbe?: 1;
      taskCreationReward?: 5;
    }
  | ({ version: 2; type: 'change-state' } & SyncChangeState)
  | { version: 2; type: 'receipts'; epoch: string; receipts: SyncReceipt[] }
  | {
      version: 2;
      type: 'page';
      epoch: string;
      token: string;
      cursor: number;
      chunk: string;
      nextCursor: number | null;
    }
  | {
      version: 1 | 2;
      type: 'error';
      code:
        | 'EPOCH_CHANGED'
        | 'INVALID_REQUEST'
        | 'INVALID_DATA'
        | 'SNAPSHOT_EXPIRED'
        | 'TOO_LARGE'
        | 'UNAVAILABLE'
        | 'UPGRADE_REQUIRED';
      message: string;
    };

export function validDateTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value))
    return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
  );
}
function text(value: unknown, limit = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Reconstruct an allowlisted task at the cross-device boundary. No extra fields survive. */
export function readSyncTask(value: unknown): DailyTask {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    value.schemaVersion !== 1 ||
    !text(value.title, 100_000) ||
    (value.notes !== null && typeof value.notes !== 'string') ||
    !isDailyTaskKind(value.kind) ||
    !isTaskRecurrence(value.recurrence) ||
    !isTaskPriority(value.priority) ||
    typeof value.archived !== 'boolean' ||
    !validDateTime(value.createdAt) ||
    !validDateTime(value.updatedAt) ||
    (value.scheduledDate !== null && !isLocalDateKey(value.scheduledDate)) ||
    (value.scheduledTime !== null && typeof value.scheduledTime !== 'string') ||
    (value.linkedLearningItemId !== null && !text(value.linkedLearningItemId)) ||
    !Array.isArray(value.selectedWeekdays) ||
    !value.selectedWeekdays.every(integer)
  ) {
    throw new Error('任务格式无效。');
  }
  const task: DailyTask = {
    id: value.id,
    schemaVersion: 1,
    title: value.title,
    notes: value.notes,
    kind: value.kind,
    recurrence: value.recurrence,
    scheduledDate: value.scheduledDate,
    scheduledTime: value.scheduledTime,
    selectedWeekdays: [...value.selectedWeekdays],
    linkedLearningItemId: value.linkedLearningItemId,
    priority: value.priority,
    archived: value.archived,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (taskValidationIssues(task).length > 0) throw new Error('任务规则无效。');
  return task;
}

export function readSyncOperation(value: unknown): SyncOperation {
  if (!isRecord(value) || !isSyncId(value.id) || !validDateTime(value.at))
    throw new Error('操作无效。');
  if (
    value.kind === 'spend-allowance' &&
    integer(value.amount) &&
    value.amount > 0 &&
    typeof value.note === 'string' &&
    value.note.length <= 500
  ) {
    return {
      id: value.id,
      kind: 'spend-allowance',
      at: value.at,
      amount: value.amount,
      note: value.note,
    };
  }
  if (value.kind === 'create-task') {
    const task = readSyncTask(value.task);
    if (
      task.kind === 'practice' ||
      task.archived ||
      task.linkedLearningItemId !== null ||
      task.title.length > 500 ||
      (task.notes?.length ?? 0) > 8_000 ||
      task.createdAt !== value.at ||
      task.updatedAt !== value.at ||
      !isSyncId(task.id)
    ) {
      throw new Error('手机新增任务超出允许范围。');
    }
    return { id: value.id, kind: 'create-task', at: value.at, task };
  }
  if (
    (value.kind === 'complete-task' ||
      value.kind === 'undo-task' ||
      value.kind === 'skip-task' ||
      value.kind === 'restore-task' ||
      value.kind === 'archive-task') &&
    text(value.taskId) &&
    isLocalDateKey(value.date) &&
    isTimeZone(value.timeZone) &&
    isSyncId(value.taskRevision) &&
    (value.occurrenceRevision === null || isSyncId(value.occurrenceRevision)) &&
    dateInTimeZone(new Date(value.at), value.timeZone) === value.date &&
    ((value.kind === 'complete-task' && value.occurrenceDate === undefined) ||
      isLocalDateKey(value.occurrenceDate))
  ) {
    const operation = {
      id: value.id,
      kind: value.kind,
      at: value.at,
      taskId: value.taskId,
      date: value.date,
      timeZone: value.timeZone,
      taskRevision: value.taskRevision,
      occurrenceRevision: value.occurrenceRevision,
      ...(typeof value.occurrenceDate === 'string' ? { occurrenceDate: value.occurrenceDate } : {}),
    };
    // Preserve the exact pre-v2 canonical shape, including key order, for fingerprints.
    return operation as SyncOperation;
  }
  throw new Error('操作类型、日期或版本无效。');
}

export function readSyncRequest(value: unknown): SyncRequest {
  if (!isRecord(value) || value.version !== 2 || !isSyncId(value.epoch))
    throw new Error('同步版本无效。');
  if (value.type === 'capabilities' || value.type === 'change-state')
    return { version: 2, type: value.type, epoch: value.epoch };
  if (
    value.type === 'push' &&
    Array.isArray(value.operations) &&
    value.operations.length <= SYNC_BATCH_LIMIT
  ) {
    const operations = value.operations.map(readSyncOperation);
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length)
      throw new Error('批次包含重复操作。');
    if (value.taskCreationReward !== undefined && value.taskCreationReward !== 5)
      throw new Error('待办创建奖励版本不兼容。');
    return {
      version: 2,
      type: 'push',
      epoch: value.epoch,
      operations,
      ...(value.taskCreationReward === 5 ? { taskCreationReward: 5 as const } : {}),
    };
  }
  if (
    value.type === 'pull' &&
    integer(value.cursor) &&
    (value.token === null || isSyncId(value.token)) &&
    (value.token !== null || value.cursor === 0)
  ) {
    return {
      version: 2,
      type: 'pull',
      epoch: value.epoch,
      token: value.token,
      cursor: value.cursor,
    };
  }
  throw new Error('同步请求无效。');
}

export function isSyncReceipt(value: unknown): value is SyncReceipt {
  return (
    isRecord(value) &&
    isSyncId(value.operationId) &&
    typeof value.status === 'string' &&
    ['applied', 'duplicate', 'conflict'].includes(value.status) &&
    (value.reward === 0 || value.reward === 2 || value.reward === 5) &&
    (value.walletDelta === undefined ||
      (typeof value.walletDelta === 'number' && Number.isSafeInteger(value.walletDelta))) &&
    typeof value.message === 'string' &&
    value.message.length <= 2_000
  );
}

function isLedgerEntry(value: unknown): value is AllowanceLedgerEntry {
  return (
    isRecord(value) &&
    text(value.id) &&
    typeof value.at === 'string' &&
    typeof value.date === 'string' &&
    (value.date === '' || isLocalDateKey(value.date)) &&
    typeof value.kind === 'string' &&
    ['earn', 'spend'].includes(value.kind) &&
    typeof value.source === 'string' &&
    ['capture', 'manual', 'add', 'check-in', 'milestone', 'task', 'spend'].includes(value.source) &&
    integer(value.amount) &&
    typeof value.balanceAfter === 'number' &&
    Number.isSafeInteger(value.balanceAfter) &&
    typeof value.note === 'string'
  );
}

export function isSyncWallet(value: unknown): value is AllowanceState {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    typeof value.balance === 'number' &&
    Number.isSafeInteger(value.balance) &&
    [
      'currentStreak',
      'reviewStreak',
      'totalEarned',
      'totalSpent',
      'lastCapturePraiseIndex',
      'ledgerSeq',
    ].every((key) => integer(value[key])) &&
    [value.lastCheckInDate, value.lastReviewSessionDate].every(
      (date) => date === null || isLocalDateKey(date),
    ) &&
    Array.isArray(value.ledger) &&
    value.ledger.length <= 200 &&
    value.ledger.every(isLedgerEntry)
  );
}

export function readSyncSnapshot(value: unknown): SyncSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !integer(value.sequence) ||
    (value.contentRevision !== undefined && !isSyncId(value.contentRevision)) ||
    value.sequence < 1 ||
    !isSyncId(value.epoch) ||
    !validDateTime(value.generatedAt) ||
    !isTimeZone(value.timeZone) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.completions) ||
    !Array.isArray(value.occurrences) ||
    !Array.isArray(value.taskSkips) ||
    !isSyncWallet(value.wallet)
  )
    throw new Error('电脑快照无效。');
  const tasks = value.tasks.map((entry) => {
    if (!isRecord(entry) || !isSyncId(entry.revision)) throw new Error('任务版本无效。');
    return { task: readSyncTask(entry.task), revision: entry.revision };
  });
  const completions = value.completions.map((entry): TaskCompletion => {
    if (
      !isRecord(entry) ||
      !text(entry.id) ||
      !text(entry.taskId) ||
      !isLocalDateKey(entry.localDate) ||
      !validDateTime(entry.completedAt)
    )
      throw new Error('完成记录无效。');
    const completion = {
      id: entry.id,
      taskId: entry.taskId,
      localDate: entry.localDate,
      completedAt: entry.completedAt,
    };
    if (taskCompletionValidationIssues(completion).length) throw new Error('完成记录无效。');
    return completion;
  });
  const occurrences = value.occurrences.map((entry) => {
    if (
      !isRecord(entry) ||
      !text(entry.taskId) ||
      !isLocalDateKey(entry.date) ||
      !isSyncId(entry.revision) ||
      !(entry.rewardAmount === null || integer(entry.rewardAmount))
    )
      throw new Error('完成版本无效。');
    return {
      taskId: entry.taskId,
      date: entry.date,
      revision: entry.revision,
      rewardAmount: entry.rewardAmount,
    };
  });
  const taskSkips = value.taskSkips.map((entry): TaskSkip => {
    if (
      !isRecord(entry) ||
      !text(entry.taskId) ||
      !isLocalDateKey(entry.date) ||
      !validDateTime(entry.skippedAt)
    )
      throw new Error('跳过记录无效。');
    return { taskId: entry.taskId, date: entry.date, skippedAt: entry.skippedAt };
  });
  const taskIds = new Set(tasks.map((row) => row.task.id));
  if (
    taskSkips.some(
      (row) =>
        !taskIds.has(row.taskId) ||
        completions.some((done) => done.taskId === row.taskId && done.localDate === row.date),
    ) ||
    new Set(taskSkips.map((row) => JSON.stringify([row.taskId, row.date]))).size !==
      taskSkips.length
  )
    throw new Error('跳过状态冲突。');
  if (
    new Set(tasks.map((entry) => entry.task.id)).size !== tasks.length ||
    new Set(completions.map((entry) => JSON.stringify([entry.taskId, entry.localDate]))).size !==
      completions.length ||
    new Set(occurrences.map((entry) => JSON.stringify([entry.taskId, entry.date]))).size !==
      occurrences.length
  )
    throw new Error('快照含重复记录。');
  return {
    version: 2,
    sequence: value.sequence,
    ...(value.contentRevision !== undefined ? { contentRevision: value.contentRevision } : {}),
    epoch: value.epoch,
    generatedAt: value.generatedAt,
    timeZone: value.timeZone,
    tasks,
    completions,
    occurrences,
    taskSkips,
    wallet: structuredClone(value.wallet),
  };
}

/** Read-only legacy-cache adaptation. Never use this at the network boundary. */
export function readStoredSyncSnapshot(value: unknown): SyncSnapshot {
  if (!isRecord(value) || value.version !== 1) return readSyncSnapshot(value);
  if (!isRecord(value.wallet) || ![1, 2].includes(Number(value.wallet.schemaVersion)))
    throw new Error('旧钱包格式无效。');
  const wallet = value.wallet;
  // Validate legacy numbers before normalization, which is deliberately forgiving for UI.
  const candidate = { ...wallet, schemaVersion: 2 };
  if (
    !isSyncWallet(candidate) ||
    (wallet.schemaVersion === 1 &&
      (candidate.balance < 0 || candidate.ledger.some((row) => row.balanceAfter < 0)))
  )
    throw new Error('旧钱包金额无效。');
  const parsed = readSyncSnapshot({
    ...value,
    version: 2,
    sequence: 1,
    taskSkips: [],
    wallet: normalizeAllowance(candidate),
    occurrences: Array.isArray(value.occurrences)
      ? value.occurrences.map((row: unknown) =>
          isRecord(row) ? { ...row, rewardAmount: null } : row,
        )
      : value.occurrences,
  });
  return { ...parsed, version: 1, sequence: 0 };
}
