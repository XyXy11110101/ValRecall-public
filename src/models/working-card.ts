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
/** Each of a plan's two text fields has the next step's limit. */
export const WORKING_PLAN_TEXT_MAX_LENGTH = WORKING_NOTE_MAX_LENGTH;
const WORKING_NOTE_LIMIT = 30;
const WORKING_NOTE_DAYS = 30;
/** 24-hour 'HH:MM', which is what `<input type="time">` gives. */
const WORKING_PLAN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The last day of the 14-day trial, counted from the day it starts. */
export const WORKING_TRIAL_LAST_DAY_OFFSET = 13;

export interface WorkingNote {
  taskId: string;
  text: string;
  /** The day it was written; a recurring task only shows that day's note. */
  date: string;
}

/** What a plan says. Every field can be empty; a time is 'HH:MM' or ''. */
export interface WorkingPlanFields {
  start: string;
  end: string;
  /** What exists at the end, e.g. 第九章的三条笔记. */
  deliverable: string;
  /** How to tell it is done, e.g. 看完第九章，并写下三条笔记. */
  criteria: string;
}

/** A task's plan, kept by the same rules as its next step. */
export interface WorkingPlan extends WorkingPlanFields {
  taskId: string;
  /** The day it was written; a recurring task only shows that day's plan. */
  date: string;
}

export const EMPTY_WORKING_PLAN: Readonly<WorkingPlanFields> = Object.freeze({
  start: '',
  end: '',
  deliverable: '',
  criteria: '',
});

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
  /** Added later inside version 1: a stored value without it reads as no plans. */
  plans: WorkingPlan[];
  trial: WorkingTrial | null;
}

export const DEFAULT_WORKING_CARD: Readonly<WorkingCardState> = Object.freeze({
  version: 1,
  enabled: true,
  current: null,
  notes: [],
  plans: [],
  trial: null,
});

function oldestNoteDate(today: string): string {
  return addLocalCalendarDays(today, -WORKING_NOTE_DAYS);
}

function withoutExpired<T extends { date: string }>(entries: readonly T[], today: string): T[] {
  const oldest = oldestNoteDate(today);
  return entries.filter((entry) => entry.date >= oldest);
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

function planTime(value: string): string {
  const trimmed = value.trim();
  return WORKING_PLAN_TIME.test(trimmed) ? trimmed : '';
}

/** Trimmed and bounded; a time that is not 'HH:MM' becomes ''. */
export function cleanWorkingPlan(fields: WorkingPlanFields): WorkingPlanFields {
  return {
    start: planTime(fields.start),
    end: planTime(fields.end),
    deliverable: fields.deliverable.trim().slice(0, WORKING_PLAN_TEXT_MAX_LENGTH),
    criteria: fields.criteria.trim().slice(0, WORKING_PLAN_TEXT_MAX_LENGTH),
  };
}

export function isEmptyWorkingPlan(fields: WorkingPlanFields): boolean {
  return !fields.start && !fields.end && !fields.deliverable && !fields.criteria;
}

/** Equal once both are cleaned, so a trailing space is not a change. */
export function sameWorkingPlan(a: WorkingPlanFields, b: WorkingPlanFields): boolean {
  const left = cleanWorkingPlan(a);
  const right = cleanWorkingPlan(b);
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.deliverable === right.deliverable &&
    left.criteria === right.criteria
  );
}

/** Anything that is not a valid version-1 value falls back to the defaults, field by field. */
export function normalizeWorkingCardState(value: unknown): WorkingCardState {
  if (!isRecord(value) || value.version !== 1)
    return { ...DEFAULT_WORKING_CARD, notes: [], plans: [] };
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
  const planned = new Set<string>();
  const plans = (Array.isArray(value.plans) ? value.plans : [])
    .flatMap((plan: unknown): WorkingPlan[] => {
      if (
        !isRecord(plan) ||
        !isTaskId(plan.taskId) ||
        !isLocalDateKey(plan.date) ||
        typeof plan.start !== 'string' ||
        typeof plan.end !== 'string' ||
        typeof plan.deliverable !== 'string' ||
        typeof plan.criteria !== 'string' ||
        planned.has(plan.taskId)
      )
        return [];
      const fields = cleanWorkingPlan({
        start: plan.start,
        end: plan.end,
        deliverable: plan.deliverable,
        criteria: plan.criteria,
      });
      if (isEmptyWorkingPlan(fields)) return [];
      planned.add(plan.taskId);
      return [{ taskId: plan.taskId, date: plan.date, ...fields }];
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
    plans,
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

/** A one-off shows its entry on any day, a recurring task only on the day it was written. */
function shownFor<T extends { taskId: string; date: string }>(
  entries: readonly T[],
  row: TaskOccurrence,
  today: string,
): T | null {
  const entry = entries.find((candidate) => candidate.taskId === row.task.id);
  if (!entry || entry.date < oldestNoteDate(today)) return null;
  return row.task.recurrence === 'specific_date' || entry.date === row.localDate ? entry : null;
}

/** Reading never writes, so an expired note is hidden here and removed by the next change. */
export function workingNoteFor(
  state: WorkingCardState,
  row: TaskOccurrence,
  today: string,
): string {
  return shownFor(state.notes, row, today)?.text ?? '';
}

/** The row's plan by the next step's rules, or empty fields when there is none. */
export function workingPlanFor(
  state: WorkingCardState,
  row: TaskOccurrence,
  today: string,
): WorkingPlanFields {
  const plan = shownFor(state.plans, row, today);
  return plan
    ? { start: plan.start, end: plan.end, deliverable: plan.deliverable, criteria: plan.criteria }
    : { ...EMPTY_WORKING_PLAN };
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
    notes: withoutExpired(state.notes, today),
    plans: withoutExpired(state.plans, today),
    trial,
  };
}

export function putDownWork(state: WorkingCardState, today: string): WorkingCardState {
  return state.current
    ? {
        ...state,
        current: null,
        notes: withoutExpired(state.notes, today),
        plans: withoutExpired(state.plans, today),
      }
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
  const others = withoutExpired(state.notes, today).filter((note) => note.taskId !== taskId);
  return {
    ...state,
    notes: (trimmed ? [{ taskId, text: trimmed, date: today }, ...others] : others).slice(
      0,
      WORKING_NOTE_LIMIT,
    ),
  };
}

/** Like the next step: newest first, one per task, bounded. A plan with nothing in it is removed. */
export function saveWorkingPlan(
  state: WorkingCardState,
  taskId: string,
  fields: WorkingPlanFields,
  today: string,
): WorkingCardState {
  const cleaned = cleanWorkingPlan(fields);
  const others = withoutExpired(state.plans, today).filter((plan) => plan.taskId !== taskId);
  return {
    ...state,
    plans: (isEmptyWorkingPlan(cleaned)
      ? others
      : [{ taskId, date: today, ...cleaned }, ...others]
    ).slice(0, WORKING_NOTE_LIMIT),
  };
}

/** After a task is deleted: no card and no leftover text. */
export function forgetWorkingTask(state: WorkingCardState, taskId: string): WorkingCardState {
  return {
    ...state,
    current: state.current?.taskId === taskId ? null : state.current,
    notes: state.notes.filter((note) => note.taskId !== taskId),
    plans: state.plans.filter((plan) => plan.taskId !== taskId),
  };
}

/** Turning the card off removes what was written on it and keeps the trial's numbers. */
export function setWorkingEnabled(state: WorkingCardState, enabled: boolean): WorkingCardState {
  return enabled
    ? { ...state, enabled }
    : { ...state, enabled, current: null, notes: [], plans: [] };
}
