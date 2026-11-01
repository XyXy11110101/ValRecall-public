import type { MobileTaskRow } from './task-presentation';
import { dateInTimeZone } from '../sync/protocol';

export interface TaskHistoryGroup {
  taskId: string;
  title: string;
  latestAt: string;
  rows: MobileTaskRow[];
}
export interface TaskProgressDay {
  date: string;
  count: number;
  pending: number;
}
export interface TaskProgress {
  today: MobileTaskRow[];
  days: TaskProgressDay[];
  total: number;
  pending: number;
  history: TaskHistoryGroup[];
}

/** Local read model: completion time drives progress; occurrence identity still drives settlement. */
export function taskProgress(rows: MobileTaskRow[], today: string, timeZone: string): TaskProgress {
  // Calendar arithmetic on date keys, not 24-hour offsets across DST boundaries.
  const anchor = new Date(today + 'T12:00:00Z');
  const days: TaskProgressDay[] = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - 6 + index);
    return { date: date.toISOString().slice(0, 10), count: 0, pending: 0 };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  const history = new Map<string, TaskHistoryGroup>();
  const todayRows: MobileTaskRow[] = [];
  const ordered = [...rows].sort(
    (a, b) =>
      Date.parse(b.completedAt!) - Date.parse(a.completedAt!) || a.task.id.localeCompare(b.task.id),
  );
  for (const row of ordered) {
    const date = dateInTimeZone(new Date(row.completedAt!), timeZone);
    if (date === today) todayRows.push(row);
    const day = byDate.get(date);
    if (day) {
      day.count++;
      if (row.pending) day.pending++;
    }
    let group = history.get(row.task.id);
    if (!group) {
      group = { taskId: row.task.id, title: row.task.title, latestAt: row.completedAt!, rows: [] };
      history.set(row.task.id, group);
    }
    group.rows.push(row);
  }
  return {
    today: todayRows,
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    pending: days.reduce((sum, day) => sum + day.pending, 0),
    history: [...history.values()],
  };
}
