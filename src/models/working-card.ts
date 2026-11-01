import { addLocalCalendarDays, isLocalDateKey, type TaskOccurrence } from './daily-task';
import type { HomeTaskOverview } from './task-overview';

/**
 * 工作中: the one task being worked on, kept apart from the task itself. A field on DailyTask
 * would change its revision on every switch, which conflicts with queued phone operations and
 * open edit forms. Reading this state never writes it back: an old list in another window must
 * not clear a card that window has not seen yet.
 */
export const WORKING_CARD_STORAGE_KEY = 'valrecall.workingCard';

export const WORKING_NOTE_MAX_LENGTH = 120;
const WORKING_NOTE_LIMIT = 30;
const WORKING_NOTE_DAYS = 30;
/** The last day of the 14-day trial, counted from the day it starts. */
export const WORKING_TRIAL_LAST_DAY_OFFSET = 13;

export interface WorkingNote {
  taskId: string;
  text: string;
  /** The day it was written; a recurring task only shows that day's note. */
  date: string;
}

export interface WorkingTrial {
  startedOn: string;
  openOneOffsAtStart: number;
  starts: number;
}

export interface WorkingCardState {
  version: 1;
  enabled: boolean;
  current: { taskId: string; startedOn: string } | null;
  notes: WorkingNote[];
  trial: WorkingTrial | null;
}

export const DEFAULT_WORKING_CARD: Readonly<WorkingCardState> = Object.freeze({
  version: 1,
  enabled: true,
  current: null,
  notes: [],
  trial: null,
});

function oldestNoteDate(today: string): string {
  return addLocalCalendarDays(today, -WORKING_NOTE_DAYS);
}

function withoutExpiredNotes(notes: readonly WorkingNote[], today: string): WorkingNote[] {
  const oldest = oldestNoteDate(today);
  return notes.filter((note) => note.date >= oldest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Anything that is not a valid version-1 value falls back to the defaults, field by field. */
export function normalizeWorkingCardState(value: unknown): WorkingCardState {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_WORKING_CARD, notes: [] };
  const current = value.current;
  const trial = value.trial;
  const seen = new Set<string>();
  const notes = (Array.isArray(value.notes) ? value.notes : [])
    .flatMap((note: unknown): WorkingNote[] => {
      if (
        !isRecord(note) ||
        !isTaskId(note.taskId) ||
        typeof note.text !== 'string' ||
        note.text === '' ||
        !isLocalDateKey(note.date) ||
        seen.has(note.taskId)
      )
        return [];
      seen.add(note.taskId);
      return [
        {
          taskId: note.taskId,
          text: note.text.slice(0, WORKING_NOTE_MAX_LENGTH),
          date: note.date,
        },
      ];
    })
    .slice(0, WORKING_NOTE_LIMIT);
  return {
    version: 1,
    enabled: value.enabled !== false,
    current:
      isRecord(current) && isTaskId(current.taskId) && isLocalDateKey(current.startedOn)
        ? { taskId: current.taskId, startedOn: current.startedOn }
        : null,
    notes,
    trial:
      isRecord(trial) &&
      isLocalDateKey(trial.startedOn) &&
      isCount(trial.openOneOffsAtStart) &&
      isCount(trial.starts)
        ? {
            startedOn: trial.startedOn,
            openOneOffsAtStart: trial.openOneOffsAtStart,
            starts: trial.starts,
          }
        : null,
  };
}

/**
 * The open row the card stands for, or null. A one-off keeps its card while it is overdue, and a
 * move to a later day ends it for good. A recurring task's card ends with the day. So completion,
 * skip, archive and delete, from either device, end the card, and undoing them brings it back.
 */
export function resolveWorkingRow(
  state: WorkingCardState,
  overview: Pick<HomeTaskOverview, 'today' | 'overdue'>,
): TaskOccurrence | null {
  const { current } = state;
  if (!state.enabled || !current) return null;
  return (
    [...overview.today, ...overview.overdue].find(
      (row) =>
        row.task.id === current.taskId &&
        (row.task.recurrence === 'specific_date'
          ? row.localDate <= current.startedOn
          : row.localDate === current.startedOn),
    ) ?? null
  );
}

/** Reading never writes, so an expired note is hidden here and removed by the next change. */
export function workingNoteFor(
  state: WorkingCardState,
  row: TaskOccurrence,
  today: string,
): string {
  const note = state.notes.find((entry) => entry.taskId === row.task.id);
  if (!note || note.date < oldestNoteDate(today)) return '';
  return row.task.recurrence === 'specific_date' || note.date === row.localDate ? note.text : '';
}

export function countOpenOneOffs(
  overview: Pick<HomeTaskOverview, 'today' | 'overdue' | 'upcoming'>,
): number {
  return [...overview.today, ...overview.overdue, ...overview.upcoming].filter(
    (row) => row.task.recurrence === 'specific_date',
  ).length;
}

/** The first start begins the trial; later starts are counted until its last day. */
export function startWork(
  state: WorkingCardState,
  taskId: string,
  today: string,
  openOneOffs: number,
): WorkingCardState {
  const trial: WorkingTrial = state.trial
    ? {
        ...state.trial,
        starts:
          today <= addLocalCalendarDays(state.trial.startedOn, WORKING_TRIAL_LAST_DAY_OFFSET)
            ? state.trial.starts + 1
            : state.trial.starts,
      }
    : { startedOn: today, openOneOffsAtStart: openOneOffs, starts: 1 };
  return {
    ...state,
    current: { taskId, startedOn: today },
    notes: withoutExpiredNotes(state.notes, today),
    trial,
  };
}

export function putDownWork(state: WorkingCardState, today: string): WorkingCardState {
  return state.current
    ? { ...state, current: null, notes: withoutExpiredNotes(state.notes, today) }
    : state;
}

/** Newest first, bounded in age and count. An empty text removes the task's note. */
export function saveWorkingNote(
  state: WorkingCardState,
  taskId: string,
  text: string,
  today: string,
): WorkingCardState {
  const trimmed = text.trim().slice(0, WORKING_NOTE_MAX_LENGTH);
  const others = withoutExpiredNotes(state.notes, today).filter((note) => note.taskId !== taskId);
  return {
    ...state,
    notes: (trimmed ? [{ taskId, text: trimmed, date: today }, ...others] : others).slice(
      0,
      WORKING_NOTE_LIMIT,
    ),
  };
}

/** After a task is deleted: no card and no leftover text. */
export function forgetWorkingTask(state: WorkingCardState, taskId: string): WorkingCardState {
  return {
    ...state,
    current: state.current?.taskId === taskId ? null : state.current,
    notes: state.notes.filter((note) => note.taskId !== taskId),
  };
}

/** Turning the card off removes what was written on it and keeps the trial's numbers. */
export function setWorkingEnabled(state: WorkingCardState, enabled: boolean): WorkingCardState {
  return enabled ? { ...state, enabled } : { ...state, enabled, current: null, notes: [] };
}
