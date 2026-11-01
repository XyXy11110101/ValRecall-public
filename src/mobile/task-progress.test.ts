import { describe, expect, it } from 'vitest';
import { taskProgress } from './task-progress';
import type { MobileTaskRow } from './task-presentation';

function row(id: string, date: string, at = date + 'T12:00:00Z', pending = false): MobileTaskRow {
  return {
    task: {
      id,
      title: '读书',
      schemaVersion: 1,
      notes: null,
      kind: 'routine',
      recurrence: 'daily',
      scheduledDate: null,
      scheduledTime: null,
      selectedWeekdays: [],
      linkedLearningItemId: null,
      priority: 'normal',
      archived: false,
      createdAt: at,
      updatedAt: at,
    },
    date,
    state: 'completed',
    pending,
    completedAt: at,
    rewardAmount: 5,
  };
}
describe('read-only mobile task progress', () => {
  it('shows seven real zero days including today', () => {
    const result = taskProgress([], '2026-10-18', 'Europe/London');
    expect(result.days.map((day) => day.date)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
    expect(result.total).toBe(0);
    expect(result.history).toEqual([]);
  });
  it('groups repeated completions by identity, not title, preserving old and archived rows', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row('same', `2026-10-${11 + i}`));
    rows[0]!.task.archived = true;
    rows.push(row('different', '2026-10-18'));
    const before = structuredClone(rows);
    const result = taskProgress(rows, '2026-10-18', 'Europe/London');
    expect(result.total).toBe(8);
    expect(result.today).toHaveLength(2);
    expect(result.history).toHaveLength(2);
    expect(result.history.find((group) => group.taskId === 'same')?.rows).toHaveLength(8);
    expect(rows).toEqual(before);
  });
  it('counts overdue work at its actual completion time without changing its occurrence date', () => {
    const item = row('overdue', '2026-10-01', '2026-10-17T23:30:00Z');
    const result = taskProgress([item], '2026-10-18', 'Europe/London');
    expect(result.today).toEqual([item]);
    expect(result.days[6]?.count).toBe(1);
    expect(result.history[0]?.rows[0]?.date).toBe('2026-10-01');
    expect(taskProgress([item], '2026-10-18', 'UTC').today).toEqual([]);
  });
  it.each(['2026-03-29', '2026-10-25'])('uses calendar days through DST at %s', (today) => {
    const result = taskProgress(
      [row('one', today, today + 'T00:30:00Z'), row('two', today, today + 'T01:30:00Z')],
      today,
      'Europe/London',
    );
    expect(result.days).toHaveLength(7);
    expect(new Set(result.days.map((day) => day.date)).size).toBe(7);
    expect(result.today).toHaveLength(2);
    expect(result.days[6]).toMatchObject({ date: today, count: 2 });
  });
  it('separates pending status, confirmation adds no second completion, and undo removes it', () => {
    const pending = row('one', '2026-10-18', undefined, true);
    expect(taskProgress([pending], '2026-10-18', 'UTC')).toMatchObject({ total: 1, pending: 1 });
    expect(taskProgress([{ ...pending, pending: false }], '2026-10-18', 'UTC')).toMatchObject({
      total: 1,
      pending: 0,
    });
    expect(taskProgress([], '2026-10-18', 'UTC')).toMatchObject({ total: 0, pending: 0 });
  });
});
