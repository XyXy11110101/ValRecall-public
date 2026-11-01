import {
  isLocalDateKey,
  type DailyTask,
  type TaskCompletion,
  type TaskSkip,
} from '../models/daily-task';
import { DatabaseError } from './errors';

export function readTaskSkip(value: unknown): TaskSkip {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new DatabaseError('INVALID_DATA', '跳过记录无效。');
  const row = value as Record<string, unknown>;
  if (
    typeof row.taskId !== 'string' ||
    !row.taskId.trim() ||
    !isLocalDateKey(row.date) ||
    typeof row.skippedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.skippedAt))
  )
    throw new DatabaseError('INVALID_DATA', '跳过记录无效。');
  return { taskId: row.taskId, date: row.date, skippedAt: new Date(row.skippedAt).toISOString() };
}

export function validateTaskSkips(
  values: readonly unknown[],
  tasks: readonly DailyTask[],
  completions: readonly TaskCompletion[],
): TaskSkip[] {
  const rows = values.map(readTaskSkip);
  const ids = new Set(tasks.map((task) => task.id));
  const keys = new Set<string>();
  const completed = new Set(completions.map((row) => skipKey(row.taskId, row.localDate)));
  for (const row of rows) {
    const key = skipKey(row.taskId, row.date);
    if (!ids.has(row.taskId) || keys.has(key) || completed.has(key))
      throw new DatabaseError('INVALID_DATA', '跳过记录引用无效、重复或与完成记录冲突。');
    keys.add(key);
  }
  return rows;
}

export function mergeTaskSkips(
  existing: readonly TaskSkip[],
  incoming: readonly TaskSkip[],
  existingCompletions: readonly TaskCompletion[],
  incomingCompletions: readonly TaskCompletion[],
): TaskSkip[] {
  const existingSkipped = new Set(existing.map((row) => skipKey(row.taskId, row.date)));
  const existingDone = new Set(
    existingCompletions.map((row) => skipKey(row.taskId, row.localDate)),
  );
  if (
    incoming.some((row) => existingDone.has(skipKey(row.taskId, row.date))) ||
    incomingCompletions.some((row) => existingSkipped.has(skipKey(row.taskId, row.localDate)))
  )
    throw new DatabaseError('CONFLICT', '导入失败：完成与跳过状态冲突。');
  return [
    ...existing,
    ...incoming.filter((row) => !existingSkipped.has(skipKey(row.taskId, row.date))),
  ];
}

function skipKey(taskId: string, date: string): string {
  return JSON.stringify([taskId, date]);
}
