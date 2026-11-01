// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { MobileOutboxEntry, MobileState } from '../database/mobile-repository';
import { addLocalCalendarDays, type DailyTask } from '../models/daily-task';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncOperation } from '../sync/contracts';
import {
  buildWidgetProjection,
  fitWidgetProjection,
  unavailableWidgetProjection,
  WIDGET_BYTE_BUDGET,
  WIDGET_LATER_ROW_LIMIT,
  WIDGET_TODAY_ROW_LIMIT,
  widgetPayloadBytes,
  type WidgetDay,
  type WidgetProjection,
} from './widget-projection';

const now = new Date('2026-10-26T08:00:00Z');
const today = '2026-10-26';
const epoch = 'widget-test-epoch';

function task(id: string, overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title: id,
    notes: null,
    kind: 'routine',
    recurrence: 'daily',
    scheduledDate: null,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function once(id: string, date: string, overrides: Partial<DailyTask> = {}): DailyTask {
  return task(id, {
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: date,
    ...overrides,
  });
}

function state(tasks: DailyTask[] = []): MobileState {
  return {
    epoch,
    snapshot: {
      version: 2,
      sequence: 1,
      epoch,
      generatedAt: '2026-10-26T07:00:00Z',
      timeZone: 'Europe/London',
      tasks: tasks.map((value) => ({ task: value, revision: 'revision-' + value.id })),
      completions: [],
      occurrences: [],
      taskSkips: [],
      wallet: structuredClone(DEFAULT_ALLOWANCE),
    },
    outbox: [],
    archives: [],
  };
}

type TaskAction = Exclude<SyncOperation, { kind: 'create-task' | 'spend-allowance' }>['kind'];
function action(
  kind: TaskAction,
  taskId: string,
  date = today,
  sequence = 1,
  overrides: Partial<MobileOutboxEntry> = {},
): MobileOutboxEntry {
  const id = kind + '-' + taskId + '-' + sequence;
  return {
    id,
    epoch,
    operation: {
      id,
      kind,
      at: now.toISOString(),
      date: today,
      timeZone: 'Europe/London',
      taskId,
      taskRevision: 'revision-' + taskId,
      occurrenceDate: date,
      occurrenceRevision: null,
    },
    attempted: false,
    status: 'pending',
    receipt: null,
    sequence,
    ...overrides,
  };
}

function ready(projection: WidgetProjection) {
  expect(projection.status).toBe('ready');
  if (projection.status !== 'ready') throw new Error('Expected a ready widget projection');
  return projection;
}

function day(source: MobileState, offset = 0): WidgetDay {
  const result = ready(buildWidgetProjection(source, now)).days[offset];
  if (!result) throw new Error('Missing widget day');
  return result;
}

describe('Android widget display projection', () => {
  it("counts every open task and lists today's first, overdue after", () => {
    const source = state([
      task('last'),
      task('normal-early', { scheduledTime: '08:00' }),
      once('old-overdue', '2026-10-23'),
      once('recent-overdue', '2026-10-25'),
      task('high-later', { priority: 'high', scheduledTime: '09:00' }),
      task('third', { scheduledTime: '10:00' }),
      task('fourth', { scheduledTime: '11:00' }),
      once('future', '2027-01-01'),
      task('archived', { archived: true }),
    ]);
    expect(day(source)).toMatchObject({
      date: today,
      total: 7,
      overdue: 2,
      next: null,
    });
    expect(day(source).rows.map((row) => row.taskId)).toEqual([
      'normal-early',
      'high-later',
      'third',
      'fourth',
      'last',
      'old-overdue',
      'recent-overdue',
    ]);
    expect(day(source).rows.find((row) => row.taskId === 'high-later')?.priority).toBe('high');
  });

  it('lists up to 50 rows today and 20 on later days, keeping every count', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      task('t' + String(index).padStart(2, '0')),
    );
    const projection = ready(buildWidgetProjection(state(many), now));
    expect(projection.version).toBe(2);
    expect(projection.days[0]).toMatchObject({ total: 60, completed: 0 });
    expect(projection.days[0]!.rows).toHaveLength(WIDGET_TODAY_ROW_LIMIT);
    expect(projection.days[1]!.rows).toHaveLength(WIDGET_LATER_ROW_LIMIT);
    expect(projection.days[1]!.total).toBe(60);
  });

  it('counts completions made on each date for the progress, including late ones', () => {
    const source = state([task('daily'), once('late', '2026-10-24'), task('other')]);
    source.snapshot!.completions.push(
      { id: 'c1', taskId: 'daily', localDate: today, completedAt: now.toISOString() },
      { id: 'c2', taskId: 'late', localDate: '2026-10-24', completedAt: now.toISOString() },
      {
        id: 'c3',
        taskId: 'other',
        localDate: '2026-10-25',
        completedAt: '2026-10-25T09:00:00Z',
      },
    );
    expect(day(source)).toMatchObject({ total: 1, completed: 2 });
    expect(day(source, 1).completed).toBe(0);
  });

  it('trims preview rows to stay within the byte budget without changing counts', () => {
    // Long identities and titles push 14 days of previews past the budget.
    const long = (id: string) => task(id, { title: '长'.repeat(150) + '/…' });
    const source = state(
      Array.from({ length: 60 }, (_, index) => long('task-' + index + '-' + 'x'.repeat(380))),
    );
    expect(
      widgetPayloadBytes({
        ...ready(buildWidgetProjection(state(), now)),
        days: Array.from({ length: 14 }, () => ({ rows: source.snapshot!.tasks.slice(0, 20) })),
      }),
    ).toBeGreaterThan(WIDGET_BYTE_BUDGET);
    const projection = ready(buildWidgetProjection(source, now));
    expect(widgetPayloadBytes(projection)).toBeLessThanOrEqual(WIDGET_BYTE_BUDGET);
    expect(projection.days[0]!.total).toBe(60);
    expect(projection.days[0]!.rows.length).toBeGreaterThan(0);
    expect(projection.days[1]!.rows.length).toBeLessThan(WIDGET_LATER_ROW_LIMIT);
    const tight = fitWidgetProjection(projection, 4096);
    expect(tight.status === 'ready' && tight.days[0]!.rows).toHaveLength(1);
    expect(
      tight.status === 'ready' &&
        tight.days.every((entry, index) => entry.total === projection.days[index]!.total),
    ).toBe(true);
  });

  it('measures the payload as Kotlin re-serialises it', () => {
    expect(widgetPayloadBytes({ a: 'x' })).toBe(9);
    expect(widgetPayloadBytes({ a: '/' })).toBe(10);
    expect(widgetPayloadBytes({ a: '…' })).toBe(9 - 1 + 3 + 3);
    expect(widgetPayloadBytes({ a: '\u0085' })).toBe(9 - 1 + 2 + 4);
  });

  it('creates 14 consecutive calendar days in the workspace timezone across DST', () => {
    const source = state([task('daily')]);
    const projection = ready(buildWidgetProjection(source, new Date('2026-10-24T23:30:00Z')));
    expect(projection.days).toHaveLength(14);
    expect(projection.days.map((entry) => entry.date)).toEqual(
      Array.from({ length: 14 }, (_, offset) => addLocalCalendarDays('2026-10-25', offset)),
    );
    for (const entry of projection.days) {
      expect(entry.rows).toHaveLength(1);
      expect(entry.rows[0]?.occurrenceDate).toBe(entry.date);
      expect(entry.overdue).toBe(0);
    }
    source.snapshot!.timeZone = 'Asia/Shanghai';
    expect(
      ready(buildWidgetProjection(source, new Date('2026-10-26T17:00:00Z'))).days[0]?.date,
    ).toBe('2026-10-27');
  });

  it('reopens a repeating task on the next day and never accumulates missed repeats', () => {
    const source = state([task('daily')]);
    source.snapshot!.completions.push({
      id: 'done',
      taskId: 'daily',
      localDate: today,
      completedAt: now.toISOString(),
    });
    expect(day(source)).toMatchObject({
      total: 0,
      rows: [],
      next: { occurrenceDate: '2026-10-27' },
    });
    expect(day(source, 1)).toMatchObject({ total: 1, overdue: 0 });
    expect(day(source, 13).rows.map((row) => row.occurrenceDate)).toEqual(['2026-11-08']);
  });

  it('shows selected weekdays only and finds the next weekly occurrence after a skip', () => {
    const source = state([
      task('weekly', { recurrence: 'selected_weekdays', selectedWeekdays: [1] }),
    ]);
    source.outbox.push(action('skip-task', 'weekly'));
    expect(day(source)).toMatchObject({
      total: 0,
      next: { taskId: 'weekly', occurrenceDate: '2026-11-02', pending: true },
    });
    expect(day(source, 1).rows).toEqual([]);
    expect(day(source, 7).rows.map((row) => row.taskId)).toEqual(['weekly']);
  });

  it('uses local completion and undo before the computer acknowledges them', () => {
    const source = state([once('once', today)]);
    source.outbox.push(action('complete-task', 'once'));
    expect(day(source)).toMatchObject({ total: 0, rows: [], next: null });
    source.outbox.push(action('undo-task', 'once', today, 2));
    expect(day(source)).toMatchObject({ total: 1, rows: [{ taskId: 'once', pending: true }] });
    expect(day(source, 1)).toMatchObject({ total: 1, overdue: 1 });
  });

  it('uses skip, restore and archive projections without changing saved tasks', () => {
    const source = state([task('daily')]);
    source.outbox.push(action('skip-task', 'daily'));
    expect(day(source).rows).toEqual([]);
    source.outbox.push(action('restore-task', 'daily', today, 2));
    expect(day(source).rows.map((row) => row.taskId)).toEqual(['daily']);
    source.outbox.push(action('archive-task', 'daily', today, 3));
    expect(day(source)).toMatchObject({ total: 0, next: null });
    expect(source.snapshot!.tasks[0]?.task.archived).toBe(false);
  });

  it('includes active local creates and ignores unrelated epochs, conflicts and isolated actions', () => {
    const source = state([task('existing')]);
    source.outbox.push({
      id: 'create',
      epoch,
      operation: { id: 'create', kind: 'create-task', at: now.toISOString(), task: task('new') },
      attempted: false,
      status: 'pending',
      receipt: null,
      sequence: 1,
    });
    source.outbox.push(action('complete-task', 'existing', today, 2, { epoch: 'old-epoch' }));
    source.outbox.push(action('archive-task', 'existing', today, 3, { status: 'conflict' }));
    source.outbox.push(action('complete-task', 'new', today, 4, { status: 'isolated' }));
    expect(day(source).rows).toMatchObject([
      { taskId: 'existing', pending: false },
      { taskId: 'new', pending: true },
    ]);
  });

  it('finds future single tasks beyond the cache horizon without marking them due', () => {
    const source = state([
      once('late', '2027-03-01'),
      once('next-later-time', '2027-01-01', { scheduledTime: '10:00', priority: 'high' }),
      once('next', '2027-01-01', { scheduledTime: '08:00' }),
    ]);
    for (const entry of ready(buildWidgetProjection(source, now)).days) {
      expect(entry).toMatchObject({
        total: 0,
        rows: [],
        next: { taskId: 'next', occurrenceDate: '2027-01-01' },
      });
    }
  });

  it('finds the first unblocked repeat beyond 14 days and prefers it to a later single task', () => {
    const source = state([task('daily'), once('later', '2027-01-01')]);
    source.snapshot!.taskSkips = Array.from({ length: 25 }, (_, index) => ({
      taskId: 'daily',
      date: addLocalCalendarDays(today, index),
      skippedAt: now.toISOString(),
    }));
    expect(day(source)).toMatchObject({
      total: 0,
      next: { taskId: 'daily', occurrenceDate: '2026-11-20' },
    });
  });

  it('removes completed single tasks and represents a genuinely empty schedule', () => {
    const source = state([once('done-once', '2027-01-01')]);
    source.snapshot!.completions.push({
      id: 'done',
      taskId: 'done-once',
      localDate: '2027-01-01',
      completedAt: now.toISOString(),
    });
    // Finishing a later one-off task today still counts towards today's progress.
    expect(day(source)).toEqual({
      date: today,
      total: 0,
      overdue: 0,
      completed: 1,
      rows: [],
      next: null,
    });
  });

  it('keeps missing, legacy, mismatched and unreadable data distinct from an empty schedule', () => {
    expect(buildWidgetProjection(null, now)).toEqual(unavailableWidgetProjection('not-ready', now));
    expect(buildWidgetProjection({ ...state(), snapshot: null, epoch: null }, now)).toEqual(
      unavailableWidgetProjection('not-ready', now),
    );
    const legacy = state();
    legacy.snapshot!.version = 1;
    expect(buildWidgetProjection(legacy, now)).toMatchObject({
      status: 'unavailable',
      reason: 'not-ready',
    });
    expect(buildWidgetProjection({ ...state(), epoch: 'different' }, now)).toEqual(
      unavailableWidgetProjection('workspace-changed', now),
    );
    const invalidZone = state();
    invalidZone.snapshot!.timeZone = 'Not/AZone';
    expect(buildWidgetProjection(invalidZone, now)).toEqual(
      unavailableWidgetProjection('read-error', now),
    );
  });

  it('exports only display fields and truncates titles without splitting emoji or mutating input', () => {
    const source = state([
      task('emoji', { title: '测'.repeat(158) + '🌿更多文字', notes: 'private-note' }),
      task('plain', { title: 'x'.repeat(161), linkedLearningItemId: 'private-learning-id' }),
      task('fit', { title: 'a'.repeat(158) + '🌿' }),
    ]);
    source.snapshot!.wallet.balance = 12345;
    const before = structuredClone(source);
    const projection = ready(buildWidgetProjection(source, now));
    const byId = new Map(projection.days[0]!.rows.map((row) => [row.taskId, row]));
    expect(byId.get('emoji')?.title).toBe('测'.repeat(158) + '…');
    expect(byId.get('plain')?.title).toBe('x'.repeat(159) + '…');
    expect(byId.get('fit')?.title).toBe('a'.repeat(158) + '🌿');
    expect(Object.keys(byId.get('emoji')!).sort()).toEqual(
      ['taskId', 'occurrenceDate', 'title', 'scheduledTime', 'pending', 'priority'].sort(),
    );
    expect(projection.sourceSnapshotAt).toBe('2026-10-26T07:00:00Z');
    expect(projection.generatedAt).toBe(now.toISOString());
    const json = JSON.stringify(projection);
    expect(json).not.toContain('private-note');
    expect(json).not.toContain('private-learning-id');
    expect(json).not.toContain('wallet');
    expect(source).toEqual(before);
  });
});
