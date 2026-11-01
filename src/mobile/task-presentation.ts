import {
  mobileTaskProjection,
  mobileVisibleTasks,
  type MobileState,
} from '../database/mobile-repository';
import { isTaskScheduledOnDate, sortTaskOccurrences, type DailyTask } from '../models/daily-task';
import { TASK_CREATION_REWARD, TASK_REWARD } from '../shared/allowance';
import type { MobileAppliedReceipt } from './sync-client';

export interface MobileTaskRow {
  task: DailyTask;
  date: string;
  state: 'open' | 'future' | 'completed' | 'skipped';
  pending: boolean;
  completedAt?: string;
  rewardAmount?: number | null;
}

/** Display projection only; never removes historical or pending records. */
export function groupMobileTasks(state: MobileState, today: string) {
  const tasks = mobileVisibleTasks(state);
  const byId = new Map(tasks.map(({ task }) => [task.id, task]));
  const projection = mobileTaskProjection(state);
  const key = (id: string, date: string) => JSON.stringify([id, date]);
  const completedKeys = new Set(
    projection.completions.map((row) => key(row.taskId, row.localDate)),
  );
  const completedIds = new Set(projection.completions.map((row) => row.taskId));
  const skippedKeys = new Set(projection.skips.map((row) => key(row.taskId, row.date)));
  const amounts = new Map(
    projection.occurrences.map((row) => [key(row.taskId, row.date), row.rewardAmount]),
  );
  const pendingTasks = new Set(
    state.outbox
      .filter(
        (row) =>
          row.epoch === state.epoch && (row.status === 'pending' || row.status === 'acknowledged'),
      )
      .map((row) =>
        row.operation.kind === 'create-task'
          ? row.operation.task.id
          : 'taskId' in row.operation
            ? row.operation.taskId
            : '',
      ),
  );
  const open: MobileTaskRow[] = [];
  const future: MobileTaskRow[] = [];
  for (const { task } of tasks) {
    if (task.archived) continue;
    const once = task.recurrence === 'specific_date';
    const date = once ? task.scheduledDate! : today;
    if (
      (once && completedIds.has(task.id)) ||
      completedKeys.has(key(task.id, date)) ||
      skippedKeys.has(key(task.id, date))
    )
      continue;
    if (!once && !isTaskScheduledOnDate(task, today)) continue;
    const later = once && date > today;
    (later ? future : open).push({
      task,
      date,
      state: later ? 'future' : 'open',
      pending: pendingTasks.has(task.id),
    });
  }
  // Today's tasks come first; overdue ones follow, oldest first (as on the desktop Home).
  const overdue = (row: MobileTaskRow) => (row.date < today ? 1 : 0);
  const sort = (rows: MobileTaskRow[]) => {
    const indexes = new Map(
      sortTaskOccurrences(
        rows.map((row) => ({ task: row.task, localDate: row.date, completion: null })),
      ).map((row, index) => [row.task.id, index]),
    );
    return rows.sort(
      (a, b) =>
        overdue(a) - overdue(b) ||
        a.date.localeCompare(b.date) ||
        indexes.get(a.task.id)! - indexes.get(b.task.id)!,
    );
  };
  const completed: MobileTaskRow[] = projection.completions
    .flatMap((row) => {
      const task = byId.get(row.taskId);
      return task
        ? [
            {
              task,
              date: row.localDate,
              state: 'completed' as const,
              pending: row.pending,
              completedAt: row.completedAt,
              rewardAmount: amounts.get(key(row.taskId, row.localDate)) ?? null,
            },
          ]
        : [];
    })
    .sort(
      (a, b) =>
        Date.parse(b.completedAt!) - Date.parse(a.completedAt!) ||
        a.task.id.localeCompare(b.task.id),
    );
  const skipped: MobileTaskRow[] = projection.skips.flatMap((row) => {
    const task = byId.get(row.taskId);
    return task && !task.archived && row.date === today && isTaskScheduledOnDate(task, today)
      ? [{ task, date: row.date, state: 'skipped' as const, pending: row.pending }]
      : [];
  });
  return { open: sort(open), future: sort(future), completed, skipped: sort(skipped) };
}

/**
 * Estimated rewards still waiting for the computer: pending completions plus pending
 * creations. An estimate, never a credit. A creation already present in the confirmed
 * snapshot (its reply was lost) is already in the confirmed balance, so it adds nothing.
 */
export function pendingEstimate(state: MobileState): number {
  const projection = mobileTaskProjection(state);
  const pendingIds = new Set(
    projection.completions.filter((row) => row.pending).map((row) => row.id),
  );
  let total = 0;
  const seen = new Set<string>();
  const created = new Set<string>();
  for (const row of state.outbox) {
    if (row.operation.kind === 'create-task') {
      const taskId = row.operation.task.id;
      if (
        row.epoch !== state.epoch ||
        row.status !== 'pending' ||
        created.has(taskId) ||
        state.snapshot?.tasks.some(({ task }) => task.id === taskId)
      )
        continue;
      created.add(taskId);
      total += TASK_CREATION_REWARD;
      continue;
    }
    if (
      row.epoch !== state.epoch ||
      row.status !== 'pending' ||
      row.operation.kind !== 'complete-task' ||
      !pendingIds.has(row.id)
    )
      continue;
    const op = row.operation;
    const date = op.occurrenceDate ?? op.date;
    const task = mobileVisibleTasks(state).find(({ task }) => task.id === op.taskId)?.task;
    const id = JSON.stringify([op.taskId, task?.recurrence === 'specific_date' ? 'once' : date]);
    if (seen.has(id)) continue;
    seen.add(id);
    const old = state.snapshot?.occurrences.find(
      (entry) => entry.taskId === op.taskId && entry.date === date,
    );
    const precedingUndo = state.outbox.some(
      (entry) =>
        entry.epoch === state.epoch &&
        entry.sequence < row.sequence &&
        (entry.status === 'pending' || entry.status === 'acknowledged') &&
        entry.operation.kind === 'undo-task' &&
        entry.operation.taskId === op.taskId &&
        entry.operation.occurrenceDate === date,
    );
    if (!old || old.rewardAmount === 0 || (precedingUndo && old.rewardAmount !== null))
      total += TASK_REWARD;
  }
  return total;
}

export function pendingReversal(state: MobileState): number | null {
  let sum = 0;
  for (const row of state.outbox) {
    if (
      row.epoch !== state.epoch ||
      row.operation.kind !== 'undo-task' ||
      (row.status !== 'pending' && row.status !== 'acknowledged')
    )
      continue;
    const value =
      row.receipt?.walletDelta === undefined
        ? row.reservedAmount
        : Math.max(0, -row.receipt.walletDelta);
    if (value === null || value === undefined) return null;
    sum += value;
  }
  return sum;
}

/**
 * The reward estimate one saved completion adds; an estimate, never a credit. It compares
 * the stored state with and without that entry, so a sync landing meanwhile cannot skew it.
 */
export function completionEstimate(after: MobileState, entryId: string): number {
  const without = { ...after, outbox: after.outbox.filter((entry) => entry.id !== entryId) };
  return Math.max(0, pendingEstimate(after) - pendingEstimate(without));
}

/**
 * The creation reward one saved task adds; an estimate, never a credit. Only a pending
 * create in the current epoch counts: a replayed save that was already sent and confirmed,
 * a conflict, an isolated or an old-epoch entry is 0.
 */
export function creationEstimate(after: MobileState, entryId: string): number {
  const entry = after.outbox.find((row) => row.id === entryId);
  if (
    !entry ||
    entry.operation.kind !== 'create-task' ||
    entry.epoch !== after.epoch ||
    entry.status !== 'pending'
  )
    return 0;
  const without = { ...after, outbox: after.outbox.filter((row) => row.id !== entryId) };
  return Math.min(
    TASK_CREATION_REWARD,
    Math.max(0, pendingEstimate(after) - pendingEstimate(without)),
  );
}

export interface ConfirmedCompletion {
  operationId: string;
  taskId: string;
  /** Actual amount from the computer; null when an older record does not say. */
  amount: number | null;
  /** Absent for a completion; a confirmed creation says so. */
  kind?: 'create-task';
}

/**
 * Completions the computer confirmed between two stored states. A first load, an epoch
 * change, a conflict or an isolated entry never counts, so nothing is announced twice.
 */
export function confirmedCompletions(
  previous: MobileState | null,
  next: MobileState,
): ConfirmedCompletion[] {
  if (!previous || previous.epoch === null || previous.epoch !== next.epoch) return [];
  const after = new Map(next.outbox.map((entry) => [entry.id, entry]));
  const confirmed: ConfirmedCompletion[] = [];
  for (const entry of previous.outbox) {
    const operation = entry.operation;
    if (
      entry.epoch === previous.epoch &&
      entry.status === 'pending' &&
      operation.kind === 'create-task'
    ) {
      // A creation is confirmed only by its receipt; a snapshot does not say what it paid.
      const current = after.get(entry.id);
      if (
        current?.status === 'acknowledged' &&
        current.receipt &&
        current.receipt.status !== 'conflict'
      )
        confirmed.push({
          operationId: entry.id,
          taskId: operation.task.id,
          amount: current.receipt.reward,
          kind: 'create-task',
        });
      continue;
    }
    if (
      entry.epoch !== previous.epoch ||
      entry.status !== 'pending' ||
      operation.kind !== 'complete-task'
    )
      continue;
    const current = after.get(entry.id);
    if (current) {
      if (
        current.status === 'acknowledged' &&
        current.receipt &&
        current.receipt.status !== 'conflict'
      )
        confirmed.push({
          operationId: entry.id,
          taskId: operation.taskId,
          amount: current.receipt.reward,
        });
      continue;
    }
    // A vanished entry counts only if it was sent and a newer snapshot shows the completion;
    // a never-sent completion that was undone on the phone also vanishes.
    if (!entry.attempted || next.snapshot?.sequence === previous.snapshot?.sequence) continue;
    const date = operation.occurrenceDate ?? operation.date;
    const completed = next.snapshot?.completions.some(
      (row) => row.taskId === operation.taskId && row.localDate === date,
    );
    if (!completed) continue;
    const occurrence = next.snapshot?.occurrences.find(
      (row) => row.taskId === operation.taskId && row.date === date,
    );
    confirmed.push({
      operationId: entry.id,
      taskId: operation.taskId,
      amount: occurrence?.rewardAmount ?? null,
    });
  }
  return confirmed;
}

export function confirmationMessage(confirmed: readonly ConfirmedCompletion[]): string {
  const total = confirmed.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  if (confirmed.length === 1) {
    const { amount, kind } = confirmed[0]!;
    const what = kind === 'create-task' ? '新增待办' : '完成';
    // An unknown historical amount stays unknown; it is never shown as zero.
    return amount === null
      ? `电脑已确认${what}`
      : !__VALRECALL_PUBLIC_RELEASE__ && amount > 0
        ? `+${amount} 元已到账`
        : `电脑已确认${what}`;
  }
  if (!__VALRECALL_PUBLIC_RELEASE__ && total > 0) return `+${total} 元已到账`;
  return confirmed.every((row) => row.kind !== 'create-task')
    ? `电脑已确认 ${confirmed.length} 项完成`
    : `电脑已确认 ${confirmed.length} 项`;
}

/** The sync summary's applied receipts in the shape the confirmation line speaks. */
export function confirmedFromReceipts(
  applied: readonly MobileAppliedReceipt[],
): ConfirmedCompletion[] {
  return applied.map((row) => ({
    operationId: row.operationId,
    taskId: row.taskId,
    amount: row.reward,
    ...(row.kind === 'create-task' ? { kind: 'create-task' as const } : {}),
  }));
}
