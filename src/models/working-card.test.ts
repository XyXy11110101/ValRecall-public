import { describe, expect, it } from 'vitest';
import { buildHomeTaskOverview } from './task-overview';
import type { DailyTask, TaskCompletion } from './daily-task';
import {
  DEFAULT_WORKING_CARD,
  WORKING_NOTE_MAX_LENGTH,
  countOpenOneOffs,
  forgetWorkingTask,
  normalizeWorkingCardState,
  putDownWork,
  resolveWorkingRow,
  saveWorkingNote,
  setWorkingEnabled,
  startWork,
  workingNoteFor,
  type WorkingCardState,
} from './working-card';

const today = '2026-10-30';

function task(id: string, changes: Partial<DailyTask> = {}): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title: id,
    notes: null,
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: today,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...changes,
  };
}
const daily = (id: string) =>
  task(id, { kind: 'routine', recurrence: 'daily', scheduledDate: null });
const state = (taskId: string, startedOn = today): WorkingCardState => ({
  ...DEFAULT_WORKING_CARD,
  notes: [],
  current: { taskId, startedOn },
});
const done = (taskId: string, localDate = today): TaskCompletion => ({
  id: `${taskId}-${localDate}`,
  taskId,
  localDate,
  completedAt: new Date(2026, 9, 30, 10).toISOString(),
});
const resolve = (
  card: WorkingCardState,
  tasks: DailyTask[],
  on = today,
  completions: TaskCompletion[] = [],
) => resolveWorkingRow(card, buildHomeTaskOverview(tasks, completions, [], on));

describe('working card state', () => {
  it.each([
    [null],
    [[]],
    ['text'],
    [{ version: 2, enabled: false }],
    [{ version: 1, current: { taskId: '', startedOn: today } }],
    [{ version: 1, current: { taskId: 'a', startedOn: 'tomorrow' } }],
    [{ version: 1, trial: { startedOn: today, openOneOffsAtStart: -1, starts: 0 } }],
  ])('falls back to safe values for %j', (value) => {
    const result = normalizeWorkingCardState(value);
    expect(result.current).toBeNull();
    expect(result.trial).toBeNull();
    expect(result.notes).toEqual([]);
  });

  it('keeps valid fields, drops bad notes and bounds the rest', () => {
    const notes = [
      { taskId: 'a', text: 'x'.repeat(500), date: today },
      { taskId: 'a', text: 'duplicate', date: today },
      { taskId: 'b', text: '', date: today },
      { taskId: 'c', text: 'bad date', date: 'never' },
      ...Array.from({ length: 40 }, (_, index) => ({
        taskId: `n${index}`,
        text: 'note',
        date: today,
      })),
    ];
    const result = normalizeWorkingCardState({
      version: 1,
      enabled: false,
      current: { taskId: 'a', startedOn: today, extra: true },
      notes,
      trial: { startedOn: today, openOneOffsAtStart: 3, starts: 2 },
    });
    expect(result.enabled).toBe(false);
    expect(result.current).toEqual({ taskId: 'a', startedOn: today });
    expect(result.notes).toHaveLength(30);
    expect(result.notes[0]?.text).toHaveLength(WORKING_NOTE_MAX_LENGTH);
    expect(result.trial).toEqual({ startedOn: today, openOneOffsAtStart: 3, starts: 2 });
  });

  it('is enabled unless it was explicitly turned off', () => {
    expect(normalizeWorkingCardState({ version: 1 }).enabled).toBe(true);
  });
});

describe('resolving the working row', () => {
  it('matches an open row today, and a card that is off or empty matches nothing', () => {
    expect(resolve(state('a'), [task('a')])?.task.id).toBe('a');
    expect(resolve({ ...state('a'), enabled: false }, [task('a')])).toBeNull();
    expect(resolve({ ...state('a'), current: null }, [task('a')])).toBeNull();
    expect(resolve(state('gone'), [task('a')])).toBeNull();
  });

  it('keeps a one-off card once it is overdue, passing its own date through', () => {
    const row = resolve(state('a'), [task('a')], '2026-11-02');
    expect(row?.localDate).toBe(today);
  });

  it('ends a one-off card when it moves to a later day, and never revives it there', () => {
    const moved = task('a', { scheduledDate: '2026-10-31' });
    expect(resolve(state('a'), [moved])).toBeNull();
    expect(resolve(state('a'), [moved], '2026-10-31')).toBeNull();
    expect(resolve(state('a'), [moved], '2026-11-01')).toBeNull();
  });

  it('brings a one-off card back when the move is undone the same day', () => {
    expect(resolve(state('a'), [task('a', { scheduledDate: '2026-10-31' })])).toBeNull();
    expect(resolve(state('a'), [task('a')])?.task.id).toBe('a');
  });

  it('ends a recurring card with the day', () => {
    expect(resolve(state('a'), [daily('a')])?.localDate).toBe(today);
    expect(resolve(state('a'), [daily('a')], '2026-10-31')).toBeNull();
  });

  it('follows completion, archive and delete from either device, and their undo', () => {
    const card = state('a');
    expect(resolve(card, [task('a')], today, [done('a')])).toBeNull();
    expect(resolve(card, [task('a', { archived: true })])).toBeNull();
    expect(resolve(card, [])).toBeNull();
    expect(resolve(card, [task('a')])?.task.id).toBe('a');
  });

  it('accepts that a date edit to today on a later day needs one click to restart', () => {
    expect(
      resolve(state('a', today), [task('a', { scheduledDate: '2026-11-02' })], '2026-11-02'),
    ).toBeNull();
  });

  it('follows a skip of the recurring card and its restore', () => {
    const skips = [{ taskId: 'a', date: today, skippedAt: `${today}T10:00:00.000Z` }];
    const overview = (rows: typeof skips) => buildHomeTaskOverview([daily('a')], [], rows, today);
    expect(resolveWorkingRow(state('a'), overview(skips))).toBeNull();
    expect(resolveWorkingRow(state('a'), overview([]))?.task.id).toBe('a');
  });
});

describe('working card changes', () => {
  it('starts the trial on the first start and counts starts until its last day', () => {
    let card: WorkingCardState = { ...DEFAULT_WORKING_CARD, notes: [] };
    card = startWork(card, 'a', today, 7);
    expect(card.current).toEqual({ taskId: 'a', startedOn: today });
    expect(card.trial).toEqual({ startedOn: today, openOneOffsAtStart: 7, starts: 1 });
    card = startWork(card, 'b', '2026-11-12', 99);
    expect(card.trial).toEqual({ startedOn: today, openOneOffsAtStart: 7, starts: 2 });
    card = startWork(card, 'c', '2026-11-13', 99);
    expect(card.trial?.starts).toBe(2);
    expect(card.current?.taskId).toBe('c');
  });

  it('puts down without touching notes, and is a no-op with nothing current', () => {
    const card = saveWorkingNote(state('a'), 'a', '写小标题', today);
    expect(putDownWork(card, today).current).toBeNull();
    expect(putDownWork(card, today).notes).toEqual(card.notes);
    const empty = putDownWork(card, today);
    expect(putDownWork(empty, today)).toBe(empty);
  });

  it('shows a one-off note on any day and a recurring note only on its own day', () => {
    const card = saveWorkingNote(state('a'), 'a', ' 写小标题 ', today);
    const row = (t: DailyTask, localDate: string) => ({ task: t, localDate, completion: null });
    expect(workingNoteFor(card, row(task('a'), today), today)).toBe('写小标题');
    expect(workingNoteFor(card, row(task('a'), '2026-10-20'), today)).toBe('写小标题');
    expect(workingNoteFor(card, row(daily('a'), today), today)).toBe('写小标题');
    expect(workingNoteFor(card, row(daily('a'), '2026-10-31'), '2026-10-31')).toBe('');
    expect(workingNoteFor(card, row(task('other'), today), today)).toBe('');
  });

  it('keeps the newest note per task, removes on empty, and bounds age and count', () => {
    let card = saveWorkingNote(state('a'), 'a', 'one', today);
    card = saveWorkingNote(card, 'b', 'two', today);
    card = saveWorkingNote(card, 'a', 'three', today);
    expect(card.notes.map((note) => note.text)).toEqual(['three', 'two']);
    expect(saveWorkingNote(card, 'a', '   ', today).notes.map((n) => n.taskId)).toEqual(['b']);
    expect(saveWorkingNote(card, 'c', 'x', '2026-12-30').notes.map((n) => n.taskId)).toEqual(['c']);
    for (let index = 0; index < 40; index += 1) {
      card = saveWorkingNote(card, `t${index}`, 'x', today);
    }
    expect(card.notes).toHaveLength(30);
    expect(saveWorkingNote(state('a'), 'a', 'y'.repeat(300), today).notes[0]?.text).toHaveLength(
      WORKING_NOTE_MAX_LENGTH,
    );
  });

  it('hides a note past 30 days at once and removes it with the next change', () => {
    const card = saveWorkingNote(state('a'), 'a', 'old', today);
    const row = { task: task('a'), localDate: today, completion: null };
    expect(workingNoteFor(card, row, '2026-11-29')).toBe('old');
    expect(workingNoteFor(card, row, '2026-11-30')).toBe('');
    expect(putDownWork(card, '2026-11-30').notes).toEqual([]);
    expect(startWork(card, 'b', '2026-11-30', 0).notes).toEqual([]);
    expect(startWork(card, 'b', '2026-11-29', 0).notes).toHaveLength(1);
  });

  it('forgets a deleted task entirely and leaves others alone', () => {
    let card = saveWorkingNote(state('a'), 'a', 'one', today);
    card = saveWorkingNote(card, 'b', 'two', today);
    const forgotten = forgetWorkingTask(card, 'a');
    expect(forgotten.current).toBeNull();
    expect(forgotten.notes.map((n) => n.taskId)).toEqual(['b']);
    expect(forgetWorkingTask(card, 'b').current?.taskId).toBe('a');
  });

  it('turning off clears the card and notes and keeps the trial numbers', () => {
    const card = saveWorkingNote(startWork(state('a'), 'a', today, 2), 'a', 'one', today);
    const off = setWorkingEnabled(card, false);
    expect(off).toMatchObject({ enabled: false, current: null, notes: [] });
    expect(off.trial).toEqual(card.trial);
    expect(setWorkingEnabled(off, true).enabled).toBe(true);
  });

  it('counts open one-offs across every group and no recurring task', () => {
    expect(
      countOpenOneOffs(
        buildHomeTaskOverview(
          [
            task('today'),
            task('late', { scheduledDate: '2026-10-01' }),
            task('later', { scheduledDate: '2026-12-01' }),
            daily('routine'),
          ],
          [],
          [],
          today,
        ),
      ),
    ).toBe(3);
  });
});
