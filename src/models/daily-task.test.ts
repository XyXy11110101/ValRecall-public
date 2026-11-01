import { describe, expect, it } from 'vitest';

import {
  DAILY_TASK_SCHEMA_VERSION,
  addLocalCalendarDays,
  isLocalDateKey,
  isTaskScheduledOnDate,
  localDateKey,
  nextScheduledDate,
  sortTaskOccurrences,
  taskValidationIssues,
  weekdayForLocalDate,
  type DailyTask,
  type TaskOccurrence,
} from './daily-task';

const createdAt = '2026-07-20T12:00:00.000Z';

function task(overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    id: 'task-1',
    schemaVersion: DAILY_TASK_SCHEMA_VERSION,
    title: 'Practise one angle',
    notes: null,
    kind: 'routine',
    recurrence: 'daily',
    scheduledDate: null,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe('daily task calendar domain', () => {
  it('uses strict Gregorian local-date keys without parsing them as UTC instants', () => {
    expect(isLocalDateKey('2026-02-28')).toBe(true);
    expect(isLocalDateKey('2026-02-29')).toBe(false);
    expect(isLocalDateKey('2024-02-29')).toBe(true);
    expect(isLocalDateKey('2026-13-01')).toBe(false);
    expect(localDateKey(new Date(2026, 6, 21, 23, 59))).toBe('2026-07-21');
  });

  it('advances calendar dates across DST boundaries without adding fixed hours', () => {
    expect(addLocalCalendarDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addLocalCalendarDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addLocalCalendarDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('matches daily, selected-weekday and specific-date recurrence', () => {
    const monday = '2026-07-20';
    const tuesday = '2026-07-21';
    expect(weekdayForLocalDate(monday)).toBe(1);
    expect(isTaskScheduledOnDate(task(), monday)).toBe(true);
    expect(
      isTaskScheduledOnDate(
        task({ recurrence: 'selected_weekdays', selectedWeekdays: [1, 3] }),
        monday,
      ),
    ).toBe(true);
    expect(
      isTaskScheduledOnDate(
        task({ recurrence: 'selected_weekdays', selectedWeekdays: [1, 3] }),
        tuesday,
      ),
    ).toBe(false);
    expect(
      isTaskScheduledOnDate(
        task({
          kind: 'one_off',
          recurrence: 'specific_date',
          scheduledDate: tuesday,
        }),
        tuesday,
      ),
    ).toBe(true);
  });

  it('excludes archived tasks and finds the next recurring calendar day', () => {
    expect(isTaskScheduledOnDate(task({ archived: true }), '2026-07-21')).toBe(false);
    const weekdays = task({ recurrence: 'selected_weekdays', selectedWeekdays: [1, 3] });
    expect(nextScheduledDate(weekdays, '2026-07-21')).toBe('2026-07-22');
    expect(nextScheduledDate(task({ archived: true }), '2026-07-21')).toBeNull();
  });

  it('reports recurrence, weekday, time, kind and link validation issues', () => {
    expect(
      taskValidationIssues(
        task({
          title: '',
          kind: 'one_off',
          recurrence: 'selected_weekdays',
          selectedWeekdays: [],
          scheduledTime: '24:10',
          linkedLearningItemId: 'learning-item',
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'Task title is required.',
        'Task time must use HH:mm local time.',
        'Selected-weekday tasks require at least one weekday.',
        'One-off tasks require a specific-date recurrence.',
        'Only practice tasks can link to a learning item.',
      ]),
    );
  });

  it('orders planned times first, then priority and title without mutating input', () => {
    const source: TaskOccurrence[] = [
      {
        task: task({ id: 'later', scheduledTime: null, priority: 'high' }),
        localDate: '2026-07-21',
        completion: null,
      },
      {
        task: task({ id: 'low', scheduledTime: '09:00', priority: 'low' }),
        localDate: '2026-07-21',
        completion: null,
      },
      {
        task: task({ id: 'high', scheduledTime: '09:00', priority: 'high' }),
        localDate: '2026-07-21',
        completion: null,
      },
    ];

    expect(sortTaskOccurrences(source).map((entry) => entry.task.id)).toEqual([
      'high',
      'low',
      'later',
    ]);
    expect(source.map((entry) => entry.task.id)).toEqual(['later', 'low', 'high']);
  });
});
