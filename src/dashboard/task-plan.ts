import {
  addLocalCalendarDays,
  localDateKey,
  type DailyTask,
  type TaskOccurrence,
} from '../models/daily-task';

/** Taking a task off today's plan without finishing it. No action here moves money. */
export type TaskPlanAction = 'skip-today' | 'move-tomorrow' | 'drop';

export const TASK_PLAN_LABELS: Record<TaskPlanAction, string> = {
  'skip-today': '今天不做',
  'move-tomorrow': '改到明天',
  drop: '不做了',
};

export const TASK_PLAN_DONE: Record<TaskPlanAction, string> = {
  'skip-today': '今天已跳过',
  'move-tomorrow': '已改到明天',
  drop: '已取消待办',
};

/** By recurrence, not kind: a practice task can be either. */
export function rowPlanActions(task: DailyTask): TaskPlanAction[] {
  return task.recurrence === 'specific_date' ? ['move-tomorrow', 'drop'] : ['skip-today'];
}

export interface TaskPlanPort {
  changeTaskSkipAtomic(
    kind: 'skip-task' | 'restore-task',
    taskId: string,
    date: string,
    now: Date,
  ): Promise<{ changed: boolean }>;
  updateTask(
    id: string,
    changes: { scheduledDate: string | null } | { notes: string | null },
  ): Promise<DailyTask>;
  archiveTask(id: string, archived: boolean): Promise<DailyTask>;
}

/** What one action did, so the same slot can offer 撤销. */
export interface TaskPlanReceipt {
  action: TaskPlanAction;
  taskId: string;
  title: string;
  localDate: string;
  previousDate: string | null;
}

export async function applyTaskPlan(
  port: TaskPlanPort,
  row: TaskOccurrence,
  action: TaskPlanAction,
  now: Date,
): Promise<TaskPlanReceipt> {
  const receipt: TaskPlanReceipt = {
    action,
    taskId: row.task.id,
    title: row.task.title,
    localDate: row.localDate,
    previousDate: row.task.scheduledDate,
  };
  if (action === 'skip-today') {
    await port.changeTaskSkipAtomic('skip-task', row.task.id, row.localDate, now);
  } else if (action === 'move-tomorrow') {
    await port.updateTask(row.task.id, {
      scheduledDate: addLocalCalendarDays(localDateKey(now), 1),
    });
  } else {
    await port.archiveTask(row.task.id, true);
  }
  return receipt;
}

export async function undoTaskPlan(
  port: TaskPlanPort,
  receipt: TaskPlanReceipt,
  now: Date,
): Promise<void> {
  if (receipt.action === 'skip-today') {
    await port.changeTaskSkipAtomic('restore-task', receipt.taskId, receipt.localDate, now);
  } else if (receipt.action === 'move-tomorrow') {
    await port.updateTask(receipt.taskId, { scheduledDate: receipt.previousDate });
  } else {
    await port.archiveTask(receipt.taskId, false);
  }
}
