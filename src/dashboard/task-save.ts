import type { DraftToken } from '../database/drafts';
import type { DailyTask, NewDailyTask } from '../models/daily-task';
import type { TaskAllowanceResult } from '../shared/allowance';
import type { TaskFormValues } from './TaskForm';

export interface TaskCreationPort {
  createTask(input: NewDailyTask, draft?: DraftToken): Promise<DailyTask>;
  /** The same atomic create, also returning the grant it committed; preferred when present. */
  createTaskWithReward?(
    input: NewDailyTask,
    draft?: DraftToken,
  ): Promise<{ task: DailyTask; reward: TaskAllowanceResult }>;
  getTask?(id: string): Promise<DailyTask | undefined>;
}

/** A saved task and the creation grant this call committed; null when none is certain. */
export interface TaskCreationResult {
  task: DailyTask;
  reward: TaskAllowanceResult | null;
}

/** A retry keeps its original identity, including an uncertain post-commit response. */
export async function saveTaskDraft(
  port: TaskCreationPort,
  id: string,
  values: TaskFormValues,
  draft?: DraftToken,
): Promise<DailyTask> {
  return (await saveTaskDraftWithReward(port, id, values, draft)).task;
}

/**
 * Like saveTaskDraft, and also reports the grant. The reward is null whenever this call did
 * not itself receive a committed receipt: the task already existed, or it was recovered after
 * a lost response. A coin is therefore never shown twice, nor for an uncertain grant.
 */
export async function saveTaskDraftWithReward(
  port: TaskCreationPort,
  id: string,
  values: TaskFormValues,
  draft?: DraftToken,
): Promise<TaskCreationResult> {
  const confirmSaved = (saved: DailyTask) => {
    const matches = (Object.keys(values) as (keyof TaskFormValues)[]).every(
      (key) => JSON.stringify(saved[key]) === JSON.stringify(values[key]),
    );
    if (!matches) throw new Error('这条待办已经保存过了，请在列表里编辑它。');
    return saved;
  };
  const existing = await port.getTask?.(id);
  if (existing) return { task: confirmSaved(existing), reward: null };
  try {
    if (port.createTaskWithReward) {
      const created = await (draft
        ? port.createTaskWithReward({ ...values, id }, draft)
        : port.createTaskWithReward({ ...values, id }));
      return { task: created.task, reward: created.reward };
    }
    const task = await (draft
      ? port.createTask({ ...values, id }, draft)
      : port.createTask({ ...values, id }));
    return { task, reward: null };
  } catch (error) {
    const saved = await port.getTask?.(id).catch(() => undefined);
    if (saved) return { task: confirmSaved(saved), reward: null };
    throw error;
  }
}
