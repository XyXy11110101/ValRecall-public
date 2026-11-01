import type { TaskCompletionResult } from '../database';
import type { AtomicTaskChange } from '../database/sync-repository';
import { localDateKey } from '../models/daily-task';
import {
  recordRevertedTaskCompletion,
  recordSuccessfulTaskCompletion,
  type TaskAllowanceResult,
} from '../shared/allowance';
import { rewardsVisible } from '../edition/rewards';

export interface TaskCompletionPort {
  complete(taskId: string, localDate: string): Promise<TaskCompletionResult>;
  undo(taskId: string, localDate: string): Promise<boolean>;
  atomic?:
    | ((taskId: string, date: string, completed: boolean, now: Date) => Promise<AtomicTaskChange>)
    | undefined;
}

const defaultRewards = {
  complete: recordSuccessfulTaskCompletion,
  undo: recordRevertedTaskCompletion,
};
let queue: Promise<unknown> = Promise.resolve();

/** Lock the content change AND reward; allowance's own lock is always acquired second. */
export async function changeTaskCompletion(
  port: TaskCompletionPort,
  taskId: string,
  date: string,
  completed: boolean,
  now: Date,
  rewards = defaultRewards,
): Promise<{ changed: boolean; reward: TaskAllowanceResult | null; warning: string | null }> {
  if (port.atomic) return port.atomic(taskId, date, completed, now);
  const operation = async () => {
    const changed = completed
      ? (await port.complete(taskId, date)).created
      : await port.undo(taskId, date);
    if (!changed || date !== localDateKey(now)) return { changed, reward: null, warning: null };
    try {
      const reward = await (completed ? rewards.complete(now) : rewards.undo(now));
      return { changed, reward, warning: null };
    } catch {
      return {
        changed,
        reward: null,
        warning:
          __VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()
            ? null
            : '已完成，零花钱没更新，请到零花钱页核对。',
      };
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request('valrecall-task-completion', operation);
  const next = queue.then(operation, operation);
  queue = next.catch(() => undefined);
  return next;
}
