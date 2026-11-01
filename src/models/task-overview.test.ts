import { describe, expect, it } from 'vitest';
import { buildHomeTaskOverview, skippedTodayOccurrences } from './task-overview';
import { addLocalCalendarDays, type DailyTask, type TaskCompletion } from './daily-task';

const today = '2026-10-20';
function task(id: string, changes: Partial<DailyTask> = {}): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title: '同名任务',
    kind: 'routine',
    recurrence: 'daily',
    scheduledDate: null,
    scheduledTime: null,
    selectedWeekdays: [],
    notes: null,
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: new Date(2026, 9, 1).toISOString(),
    updatedAt: new Date(2026, 9, 1).toISOString(),
    ...changes,
  };
}
function done(taskId: string, date = today, at = new Date(2026, 9, 20, 12)): TaskCompletion {
  return { id: `${taskId}-${date}`, taskId, localDate: date, completedAt: at.toISOString() };
}

describe('home task overview', () => {
  it('keeps every unfinished task once, including overdue practice and future tasks', () => {
    const tasks = [
      task('daily'),
      task('same-title'),
      task('overdue', {
        kind: 'practice',
        recurrence: 'specific_date',
        scheduledDate: '2026-10-18',
      }),
      task('future', { kind: 'one_off', recurrence: 'specific_date', scheduledDate: '2026-10-25' }),
      task('finished', { kind: 'one_off', recurrence: 'specific_date', scheduledDate: today }),
      task('archived', { archived: true }),
    ];
    const result = buildHomeTaskOverview(tasks, [done('finished', '2026-10-19')], [], today);
    expect(result.overdue.map((r) => r.task.id)).toEqual(['overdue']);
    expect(result.today.map((r) => r.task.id)).toEqual(['daily', 'same-title']);
    expect(result.upcoming.map((r) => r.task.id)).toEqual(['future']);
    expect(result.completed.map((r) => r.task.id)).toEqual(['finished']);
  });

  it('projects only the next valid recurring occurrence after completions and skips', () => {
    const result = buildHomeTaskOverview(
      [task('daily'), task('weekly', { recurrence: 'selected_weekdays', selectedWeekdays: [1] })],
      [done('daily')],
      [{ taskId: 'daily', date: '2026-10-21', skippedAt: new Date().toISOString() }],
      today,
    );
    expect(result.today).toEqual([]);
    expect(result.upcoming.map((r) => [r.task.id, r.localDate])).toEqual([
      ['daily', '2026-10-22'],
      ['weekly', '2026-10-26'],
    ]);
    expect(result.completed).toHaveLength(1);
  });

  it('uses actual completion day while retaining the original settlement date', () => {
    const t = task('overdue', {
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-10',
    });
    const rows = [done(t.id, '2026-10-10', new Date(2026, 9, 20, 0, 0))];
    expect(buildHomeTaskOverview([t], rows, [], today).completed[0]?.localDate).toBe('2026-10-10');
    expect(buildHomeTaskOverview([t], rows, [], '2026-10-21').completed).toEqual([]);
    expect(buildHomeTaskOverview([t], [], [], today).overdue).toHaveLength(1);
  });

  it.each(['2026-03-29', '2026-10-25', '2026-12-31'])(
    'advances calendar days at %s without fixed-duration arithmetic',
    (date) => {
      const result = buildHomeTaskOverview([task('daily')], [done('daily', date)], [], date);
      expect(result.upcoming[0]?.localDate).toBe(addLocalCalendarDays(date, 1));
    },
  );

  it('sorts by date, priority, time and stable creation order without truncating long lists', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => task(String(i).padStart(3, '0')));
    tasks.push(task('important', { priority: 'high', scheduledTime: '20:00' }));
    tasks.push(task('early', { scheduledTime: '08:00' }));
    const result = buildHomeTaskOverview(tasks, [], [], today);
    expect(result.today).toHaveLength(102);
    expect(result.today.slice(0, 3).map((r) => r.task.id)).toEqual(['important', 'early', '000']);
    expect(tasks[0]?.id).toBe('000');
    expect(buildHomeTaskOverview([], [], [], today)).toEqual({
      localDate: today,
      today: [],
      overdue: [],
      upcoming: [],
      completed: [],
    });
  });

  it('lists only the skips of live tasks for this day, in title order', () => {
    const b = task('b', { recurrence: 'daily', scheduledDate: null });
    const a = task('a', { recurrence: 'daily', scheduledDate: null });
    const archived = task('z', { recurrence: 'daily', scheduledDate: null, archived: true });
    const skip = (taskId: string, date = today) => ({
      taskId,
      date,
      skippedAt: `${date}T10:00:00.000Z`,
    });
    const rows = skippedTodayOccurrences(
      [b, a, archived],
      [skip('b'), skip('a'), skip('z'), skip('a', '2020-01-01'), skip('deleted')],
      today,
    );
    expect(rows.map((row) => row.task.id)).toEqual(['a', 'b']);
    expect(rows[0]).toEqual({ task: a, localDate: today, completion: null });
  });
});
