import {
  addLocalCalendarDays,
  isTaskScheduledOnDate,
  localDateKey,
  nextScheduledDate,
  type DailyTask,
  type TaskCompletion,
  type TaskOccurrence,
  type TaskSkip,
} from './daily-task';

/** A read model, not a new stored task or schedule. */
export interface HomeTaskOverview {
  localDate: string;
  overdue: TaskOccurrence[];
  today: TaskOccurrence[];
  upcoming: TaskOccurrence[];
  completed: TaskOccurrence[];
  /** Today's skipped occurrences, for 恢复今天. Only the desktop's repository read fills it. */
  skipped?: TaskOccurrence[];
}

export function buildHomeTaskOverview(
  tasks: readonly DailyTask[],
  completions: readonly TaskCompletion[],
  skips: readonly TaskSkip[],
  today: string,
): HomeTaskOverview {
  const result: HomeTaskOverview = {
    localDate: today,
    overdue: [],
    today: [],
    upcoming: [],
    completed: [],
  };
  const completedTasks = new Set(completions.map((row) => row.taskId));
  const unavailable = new Map<string, Set<string>>();
  for (const row of [
    ...completions.map((c) => ({ taskId: c.taskId, date: c.localDate })),
    ...skips,
  ]) {
    const dates = unavailable.get(row.taskId) ?? new Set<string>();
    dates.add(row.date);
    unavailable.set(row.taskId, dates);
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const completion of completions) {
    const task = taskById.get(completion.taskId);
    if (task && localDateKey(new Date(completion.completedAt)) === today) {
      result.completed.push({ task, localDate: completion.localDate, completion });
    }
  }
  for (const task of tasks) {
    if (task.archived) continue;
    const blocked = unavailable.get(task.id) ?? new Set<string>();
    let date: string | null;
    if (task.recurrence === 'specific_date') {
      date = task.scheduledDate;
      if (!date || completedTasks.has(task.id) || blocked.has(date)) continue;
    } else {
      date = nextScheduledDate(task, today);
      // Every rejected occurrence consumes one distinct stored completion/skip.
      // This bound cannot turn a long history into an unbounded retry loop.
      for (let attempt = 0; date && blocked.has(date) && attempt < blocked.size; attempt++) {
        date = nextScheduledDate(task, addLocalCalendarDays(date, 1));
      }
      if (!date || blocked.has(date)) continue;
    }
    const group = date < today ? result.overdue : date === today ? result.today : result.upcoming;
    group.push({ task, localDate: date, completion: null });
  }
  const priority = { high: 0, normal: 1, low: 2 };
  const compare = (a: TaskOccurrence, b: TaskOccurrence) =>
    a.localDate.localeCompare(b.localDate) ||
    priority[a.task.priority] - priority[b.task.priority] ||
    (a.task.scheduledTime ?? '99:99').localeCompare(b.task.scheduledTime ?? '99:99') ||
    a.task.createdAt.localeCompare(b.task.createdAt) ||
    a.task.id.localeCompare(b.task.id);
  result.overdue.sort(compare);
  result.today.sort(compare);
  result.upcoming.sort(compare);
  result.completed.sort((a, b) =>
    (b.completion?.completedAt ?? '').localeCompare(a.completion?.completedAt ?? ''),
  );
  return result;
}

/** Occurrences skipped for `today`, whichever device skipped them, in title order. */
export function skippedTodayOccurrences(
  tasks: readonly DailyTask[],
  skips: readonly TaskSkip[],
  today: string,
): TaskOccurrence[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  return skips
    .flatMap((skip): TaskOccurrence[] => {
      const task = taskById.get(skip.taskId);
      return task && !task.archived && skip.date === today && isTaskScheduledOnDate(task, today)
        ? [{ task, localDate: skip.date, completion: null }]
        : [];
    })
    .sort((a, b) => a.task.title.localeCompare(b.task.title) || a.task.id.localeCompare(b.task.id));
}
