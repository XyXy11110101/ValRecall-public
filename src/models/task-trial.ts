import {
  addLocalCalendarDays,
  localDateKey,
  type DailyTask,
  type TaskCompletion,
} from './daily-task';
import { WORKING_TRIAL_LAST_DAY_OFFSET, type WorkingTrial } from './working-card';

export interface TaskTrialWindow {
  oneOff: number;
  highPriority: number;
  all: number;
}

export type TaskTrialSummary =
  | { locked: true; day: number; unlocksOn: string }
  | {
      locked: false;
      before: TaskTrialWindow;
      after: TaskTrialWindow;
      openOneOffsAtStart: number;
      openOneOffsNow: number;
      starts: number;
    };

const TRIAL_DAYS = WORKING_TRIAL_LAST_DAY_OFFSET + 1;

function trialDay(startedOn: string, today: string): number {
  for (let offset = 0; offset < TRIAL_DAYS; offset += 1) {
    if (addLocalCalendarDays(startedOn, offset) === today) return offset + 1;
  }
  return today < startedOn ? 1 : TRIAL_DAYS;
}

/**
 * Two 14-day windows that span the same weekdays, counted by the day the work was done.
 * Numbers only, and none until the second window has closed, so a part-way figure never reads
 * as a verdict. Completions of deleted tasks are gone, and the phone's are included.
 */
export function buildTaskTrialSummary(
  trial: WorkingTrial,
  tasks: readonly DailyTask[],
  completions: readonly TaskCompletion[],
  today: string,
): TaskTrialSummary {
  const unlocksOn = addLocalCalendarDays(trial.startedOn, TRIAL_DAYS);
  if (today < unlocksOn) {
    return { locked: true, day: trialDay(trial.startedOn, today), unlocksOn };
  }
  const beforeStart = addLocalCalendarDays(trial.startedOn, -TRIAL_DAYS);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const before: TaskTrialWindow = { oneOff: 0, highPriority: 0, all: 0 };
  const after: TaskTrialWindow = { oneOff: 0, highPriority: 0, all: 0 };
  const completedTasks = new Set<string>();
  for (const completion of completions) {
    completedTasks.add(completion.taskId);
    const day = localDateKey(new Date(completion.completedAt));
    const window =
      day >= beforeStart && day < trial.startedOn
        ? before
        : day >= trial.startedOn && day < unlocksOn
          ? after
          : null;
    if (!window) continue;
    window.all += 1;
    const task = taskById.get(completion.taskId);
    if (task?.recurrence === 'specific_date') window.oneOff += 1;
    if (task?.priority === 'high') window.highPriority += 1;
  }
  return {
    locked: false,
    before,
    after,
    openOneOffsAtStart: trial.openOneOffsAtStart,
    openOneOffsNow: tasks.filter(
      (task) =>
        !task.archived && task.recurrence === 'specific_date' && !completedTasks.has(task.id),
    ).length,
    starts: trial.starts,
  };
}
