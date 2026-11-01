import { describe, expect, it } from 'vitest';
import type { DailyTask, TaskCompletion } from './daily-task';
import { buildTaskTrialSummary } from './task-trial';

const startedOn = '2026-10-30';
const trial = { startedOn, openOneOffsAtStart: 9, starts: 12 };

function task(id: string, changes: Partial<DailyTask> = {}): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title: id,
    notes: null,
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: '2026-10-01',
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...changes,
  };
}
/** Local noon on the given date, so the local day is exact in any time zone. */
function completion(taskId: string, year: number, month: number, day: number): TaskCompletion {
  return {
    id: `${taskId}-${month}-${day}`,
    taskId,
    localDate: '2026-10-01',
    completedAt: new Date(year, month - 1, day, 12).toISOString(),
  };
}

describe('two-week trial summary', () => {
  it('stays locked through day 14 and names the day it opens', () => {
    expect(buildTaskTrialSummary(trial, [], [], startedOn)).toEqual({
      locked: true,
      day: 1,
      unlocksOn: '2026-11-13',
    });
    expect(buildTaskTrialSummary(trial, [], [], '2026-11-12')).toEqual({
      locked: true,
      day: 14,
      unlocksOn: '2026-11-13',
    });
    expect(buildTaskTrialSummary(trial, [], [], '2026-11-13').locked).toBe(false);
  });

  it('counts by the day the work was done, with exact window edges', () => {
    const tasks = [
      task('one'),
      task('high', { priority: 'high' }),
      task('daily', { recurrence: 'daily', scheduledDate: null }),
    ];
    const summary = buildTaskTrialSummary(
      trial,
      tasks,
      [
        completion('one', 2026, 10, 15), // the day before the first window: not counted
        completion('one', 2026, 10, 16), // first day of "before"
        completion('high', 2026, 10, 29), // last day of "before"
        completion('daily', 2026, 10, 30), // first day of "after"
        completion('one', 2026, 11, 12), // last day of "after"
        completion('high', 2026, 11, 13), // the day it opens: not counted
      ],
      '2026-11-20',
    );
    expect(summary).toMatchObject({
      locked: false,
      before: { oneOff: 2, highPriority: 1, all: 2 },
      after: { oneOff: 1, highPriority: 0, all: 2 },
    });
  });

  it('reports open one-offs at the start and now, and counts unknown tasks only in all', () => {
    const tasks = [
      task('open'),
      task('finished'),
      task('dropped', { archived: true }),
      task('routine', { recurrence: 'daily', scheduledDate: null }),
    ];
    const summary = buildTaskTrialSummary(
      trial,
      tasks,
      [completion('finished', 2026, 11, 1), completion('deleted-task', 2026, 11, 2)],
      '2026-11-13',
    );
    expect(summary).toMatchObject({
      openOneOffsAtStart: 9,
      openOneOffsNow: 1,
      starts: 12,
      after: { oneOff: 1, highPriority: 0, all: 2 },
    });
  });
});
