import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { DailyTask, LearningItem, TaskOccurrence } from '../database';
import type { HomeTaskOverview } from '../models/task-overview';
import { Notice } from '../shared/components';
import { ActionIcon } from '../shared/ActionIcon';
import { displayError } from '../shared/extension';
import {
  DISCARD_AND_LEAVE_QUESTION,
  requestEditorLeave,
  useEditProtection,
} from '../shared/edit-protection';
import { useOperation } from '../shared/use-operation';
import { TaskForm, createDefaultTaskDraft } from './TaskForm';
import type { TaskFormValues, TaskFormCommit } from './TaskForm';
import { saveTaskDraftWithReward, type TaskCreationPort } from './task-save';
import { TASK_CELEBRATION_MS, type TaskCelebration } from '../shared/task-celebration';
import type { TaskAllowanceResult } from '../shared/allowance';
import { useReducedMotion } from '../ui/motion';
import {
  HomeWorkingCard,
  StrandedNotes,
  useAfterPress,
  useTaskNotes,
  type TaskNotesFlush,
} from './HomeWorkingCard';
import {
  TASK_PLAN_DONE,
  TASK_PLAN_LABELS,
  rowPlanActions,
  type TaskPlanAction,
  type TaskPlanReceipt,
} from './task-plan';
import './task-feedback.css';

export interface HomeTaskWriter extends TaskCreationPort {
  listItems?(options: { includeReviewHistory: false }): Promise<LearningItem[]>;
}

type ActiveGroup = 'today' | 'overdue' | 'working';

/** The 工作中 card's state and writes. A rejected write keeps the state and shows a save error. */
export interface HomeWorkingControls {
  row: TaskOccurrence | null;
  note: string;
  onStart(row: TaskOccurrence): Promise<void>;
  onPutDown(): Promise<void>;
  onSaveNote(row: TaskOccurrence, text: string): Promise<void>;
  /** The task's own 备注. No lock and no reward: saving a thought is not an action on the task. */
  onSaveTaskNotes(taskId: string, notes: string | null): Promise<DailyTask>;
}

/** Taking a task off today's plan. Each settles to null or false when nothing changed. */
export interface HomePlanControls {
  onApply(row: TaskOccurrence, action: TaskPlanAction): Promise<TaskPlanReceipt | null>;
  onUndo(receipt: TaskPlanReceipt): Promise<boolean>;
  onRestore(row: TaskOccurrence): Promise<boolean>;
}

/** The latest plan change stays undoable in its own slot until the next action. */
interface PlanUndo {
  receipt: TaskPlanReceipt;
  group: ActiveGroup;
  index: number;
  today: string;
}

/** A row the user just finished, kept so it completes in place before folding away. */
interface DepartingRow {
  key: string;
  group: ActiveGroup;
  index: number;
  occurrence: TaskOccurrence;
  height: number;
  /** The card's next step at that moment, so a finished card looks exactly as it did. */
  note: string;
}

/** Each finished row folds on its own clock, so quick successive completions never jump. */
interface Departure extends DepartingRow {
  /** When the refreshed list stopped containing the row; the hold starts here. */
  shownAt: number | null;
  collapsing: boolean;
  createdAt: number;
}

/** A refresh that never removes the row must not leave it looking finished forever. */
const DEPARTURE_WAIT_MS = 5000;
const NOTE_SAVE_ERROR = '下一步没保存，请重试。';

export function HomeTasks({
  overview,
  unavailable,
  loading = false,
  feedback,
  readBlocked = false,
  busy,
  writer,
  celebration = null,
  balance,
  onToggle,
  onCreated,
  onEdit,
  onManage,
  working,
  plan,
  layoutFlipping = false,
}: {
  overview: HomeTaskOverview;
  unavailable: boolean;
  loading?: boolean;
  feedback?: ReactNode;
  readBlocked?: boolean;
  busy: boolean;
  writer: HomeTaskWriter;
  /** A committed completion or creation grant being shown; presentation only. */
  celebration?: TaskCelebration | null;
  /** Pocket-money balance for the narrow-layout landing chip. */
  balance?: number;
  onToggle(occurrence: TaskOccurrence): Promise<boolean>;
  /** The saved task and the grant this save committed; null when none is certain. */
  onCreated(task: DailyTask, reward: TaskAllowanceResult | null): void;
  onEdit(task: DailyTask): void;
  onManage(): void;
  /** Absent while the card is off or not read yet: no 开始 and no card. */
  working?: HomeWorkingControls | undefined;
  plan?: HomePlanControls | undefined;
  /** The list can be newer than the layout on screen, and the commit may move its rows. */
  layoutFlipping?: boolean;
}) {
  const [draft, setDraft] = useState<{ id: string; values: TaskFormValues } | null>(null);
  const [items, setItems] = useState<LearningItem[]>([]);
  const [itemError, setItemError] = useState<string | null>(null);
  // Only a failed save is shown here; a success is announced by Home's hidden status line.
  const [saveError, setSaveError] = useState<string | null>(null);
  const operation = useOperation();
  const alive = useRef(true);
  const loadingItems = useRef(false);
  const itemsLoaded = useRef(false);
  const root = useRef<HTMLElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const pendingTask = useRef<string | null>(null);
  const pendingNext = useRef<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  // Presentation only: marks the row a confirmed create just produced.
  const [arrivedTaskId, setArrivedTaskId] = useState<string | null>(null);
  const [inFlightKey, setInFlightKey] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  // Captured at click time; it becomes a departure only when its committed result arrives.
  const pendingDeparture = useRef<DepartingRow | null>(null);
  const [departures, setDepartures] = useState<Departure[]>([]);
  const workingRow = working?.row ?? null;
  const workingKey = workingRow ? occurrenceKey(workingRow) : null;
  // A new card starts collapsed, with no effect: this only remembers which card was opened.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  // Present while the next step is being edited, and after a failed save, so the text is kept.
  const [noteDraft, setNoteDraft] = useState<{ key: string; text: string } | null>(null);
  const noteEditing = noteDraft !== null && noteDraft.key === workingKey;
  const noteText = noteEditing ? noteDraft.text : (working?.note ?? '');
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [planUndo, setPlanUndo] = useState<PlanUndo | null>(null);
  const restToggle = useRef<HTMLButtonElement>(null);
  const rest = useRef<HTMLDivElement>(null);
  const workingCardElement = useRef<HTMLElement>(null);
  const pendingCheckFocus = useRef(false);
  const flushingNotes = useRef(false);
  const groups = [
    { key: 'today', label: '今天', rows: overview.today },
    { key: 'upcoming', label: '之后', rows: overview.upcoming },
    { key: 'overdue', label: '逾期', rows: overview.overdue },
  ] as const;
  // Today's plan: everything due today or earlier, plus what was finished today.
  const openToday = overview.today.length + overview.overdue.length;
  const doneToday = overview.completed.length;
  const planToday = openToday + doneToday;
  const allDone = !unavailable && planToday > 0 && openToday === 0;
  const rowsOfGroup = (group: string) =>
    group === 'today'
      ? overview.today
      : group === 'overdue'
        ? overview.overdue
        : group === 'upcoming'
          ? overview.upcoming
          : [...overview.today, ...overview.overdue];
  /** The rows a group actually draws: the working row lives in the card, not in its list. */
  const renderedRows = (group: string) =>
    group === 'working'
      ? workingRow
        ? [workingRow]
        : []
      : rowsOfGroup(group).filter((row) => occurrenceKey(row) !== workingKey);
  const departureByKey = new Map(departures.map((departure) => [departure.key, departure]));
  // A creation grant flies its coin from the new row; it never stamps or folds anything.
  const creation = celebration?.kind === 'created' ? celebration : null;
  const celebratedKey =
    celebration && !creation ? `${celebration.taskId}:${celebration.localDate}` : null;
  const finishedCard = departures.find(
    (departure) =>
      departure.group === 'working' &&
      !rowsOfGroup('working').some((row) => occurrenceKey(row) === departure.key),
  );
  // A finished card does not fold: it stays exactly as it was for its celebration, then leaves
  // in the same render as Home's layout changes back, so the page moves once.
  const heldCard =
    !workingRow && finishedCard && finishedCard.key === celebratedKey ? finishedCard : null;
  const cardRow = workingRow ?? heldCard?.occurrence ?? null;
  const cardKey = cardRow ? occurrenceKey(cardRow) : null;
  const restHidden = cardKey !== null && expandedFor !== cardKey;
  const afterPress = useAfterPress();
  const notes = useTaskNotes(cardRow, working?.onSaveTaskNotes, afterPress);
  // Typed text is on its way by itself, and beforeunload starts its write, so a reload does not ask
  // about it. Only text that could not be saved warns. Leaving inside the app waits for the write
  // and stays if it fails, unless the user gives the text up. The card's own actions wait too.
  useEditProtection({
    dirty: notes.status === 'failed' || notes.stranded.length > 0,
    busy: () => operation.pending.current,
    autosaving: notes.hasUnsaved,
    prepareLeave: async () => (await notes.saveAll()) || window.confirm(DISCARD_AND_LEAVE_QUESTION),
    draftVersion: notes.version,
  });
  // An open next step is removed with the page, and React sends no blur for it. Its own entry, so
  // saving it cannot stand in for the note's check above. The version counts keystrokes, not text:
  // a successful save closes the field, and the text it then shows must not look like a new edit.
  const nextStepKeystrokes = useRef(0);
  useEditProtection({
    dirty: noteEditing && noteText.trim() !== (working?.note ?? ''),
    busy: false,
    prepareLeave: () => (workingRow ? saveNote(workingRow, noteText) : Promise.resolve(true)),
    draftVersion: nextStepKeystrokes.current,
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (draft) root.current?.querySelector<HTMLInputElement>('.task-form input')?.focus();
  }, [draft]);
  useEffect(() => {
    if (!arrivedTaskId) return;
    const timer = window.setTimeout(() => setArrivedTaskId(null), 1600);
    return () => window.clearTimeout(timer);
  }, [arrivedTaskId]);
  useEffect(() => {
    const pending = pendingDeparture.current;
    if (
      !celebration ||
      celebration.kind === 'created' ||
      pending?.key !== `${celebration.taskId}:${celebration.localDate}`
    )
      return;
    pendingDeparture.current = null;
    setDepartures((list) => [
      ...list.filter((departure) => departure.key !== pending.key),
      { ...pending, shownAt: null, collapsing: false, createdAt: Date.now() },
    ]);
  }, [celebration]);
  useEffect(() => {
    const present = (departure: Departure) =>
      rowsOfGroup(departure.group).some((row) => occurrenceKey(row) === departure.key);
    if (departures.some((departure) => departure.shownAt === null && !present(departure)))
      setDepartures((list) =>
        list.map((departure) =>
          departure.shownAt === null && !present(departure)
            ? { ...departure, shownAt: Date.now() }
            : departure,
        ),
      );
  }, [overview, departures]);
  useEffect(() => {
    const now = Date.now();
    const timers = departures.flatMap((departure) => {
      if (departure.shownAt === null)
        return [
          window.setTimeout(
            () => setDepartures((list) => list.filter((entry) => entry.key !== departure.key)),
            Math.max(0, departure.createdAt + DEPARTURE_WAIT_MS - now),
          ),
        ];
      // The card ends with its celebration (see heldCard), never on a clock of its own.
      if (departure.group === 'working') return [];
      const elapsed = now - departure.shownAt;
      return [
        ...(departure.collapsing
          ? []
          : [
              window.setTimeout(
                () =>
                  setDepartures((list) =>
                    list.map((entry) =>
                      entry.key === departure.key ? { ...entry, collapsing: true } : entry,
                    ),
                  ),
                Math.max(0, TASK_CELEBRATION_MS.rowHold - elapsed),
              ),
            ]),
        window.setTimeout(
          () => setDepartures((list) => list.filter((entry) => entry.key !== departure.key)),
          Math.max(0, TASK_CELEBRATION_MS.rowHold + TASK_CELEBRATION_MS.rowCollapse - elapsed),
        ),
      ];
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [departures]);
  useEffect(() => {
    if (finishedCard && !heldCard)
      setDepartures((list) => list.filter((entry) => entry.key !== finishedCard.key));
  }, [finishedCard, heldCard]);
  useEffect(() => {
    // A row found now can leave the list at the commit, and take focus with it.
    if (layoutFlipping) return;
    if (pendingCheckFocus.current && workingKey) {
      pendingCheckFocus.current = false;
      pendingTask.current = null;
      pendingNext.current = null;
      const card = workingCardElement.current;
      const check = card?.querySelector<HTMLButtonElement>('.home-task-check');
      // A refresh in flight can disable the check for a moment; focus must still land on the card.
      if (check && !check.disabled) check.focus();
      else card?.querySelector<HTMLElement>('[data-task-id]')?.focus();
      return;
    }
    // A hidden row cannot take focus, and the browser would drop the request silently.
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-task-id]') ?? [])].filter(
      (row) => !row.closest('[hidden]'),
    );
    const target = pendingTask.current
      ? rows.find(
          (row) => row.dataset.taskId === pendingTask.current && row.dataset.group !== 'completed',
        )
      : pendingNext.current
        ? rows.find((row) => row.dataset.occurrence === pendingNext.current)
        : null;
    if (pendingTask.current || pendingNext.current) {
      if (target) {
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
      } else
        root.current
          ?.querySelector<HTMLElement>('#home-tasks-heading')
          ?.focus({ preventScroll: true });
      pendingTask.current = null;
      pendingNext.current = null;
    }
  }, [overview, workingKey, layoutFlipping]);
  // Another page started a card while focus was in the list that just collapsed.
  useEffect(() => {
    if (restHidden && rest.current?.contains(document.activeElement)) restToggle.current?.focus();
  }, [restHidden]);

  async function loadItems() {
    if (loadingItems.current || itemsLoaded.current || !writer.listItems) return;
    loadingItems.current = true;
    try {
      const result = await writer.listItems({ includeReviewHistory: false });
      if (alive.current) {
        setItems(result);
        setItemError(null);
        itemsLoaded.current = true;
      }
    } catch {
      if (alive.current) setItemError('学习条目没加载出来。');
    } finally {
      loadingItems.current = false;
    }
  }

  async function save(values: TaskFormValues, commit: TaskFormCommit) {
    if (!draft || !operation.begin()) return;
    try {
      const { task: saved, reward } = await saveTaskDraftWithReward(
        writer,
        commit.id,
        values,
        commit.draft,
      );
      if (!alive.current) return;
      pendingTask.current = saved.id;
      setPlanUndo(null);
      // The new row, its highlight and the coin's origin must not be hidden.
      setExpandedFor(cardKey);
      setArrivedTaskId(saved.id);
      setDraft(null);
      setSaveError(null);
      onCreated(saved, reward);
      return true;
    } catch (error) {
      if (alive.current) setSaveError(displayError(error, '待办无法保存，请重试。'));
    } finally {
      operation.finish();
    }
  }

  /** The row focus lands on once this one leaves. Rows in the collapsed list do not count. */
  function rememberNextRow() {
    const activeRows = [
      ...(root.current?.querySelectorAll<HTMLElement>('[data-occurrence]') ?? []),
    ].filter((element) => !element.closest('[hidden]'));
    const current = activeRows.findIndex((element) => element.contains(document.activeElement));
    pendingNext.current =
      activeRows[current + 1]?.dataset.occurrence ??
      activeRows[current - 1]?.dataset.occurrence ??
      'heading';
  }

  /** One click, one action: a second click while the note is being written does nothing. */
  async function flushNotes(): Promise<TaskNotesFlush> {
    if (flushingNotes.current) return { ok: false, task: null };
    flushingNotes.current = true;
    try {
      return await notes.flush();
    } finally {
      flushingNotes.current = false;
    }
  }

  async function toggle(row: TaskOccurrence, group: string) {
    // The note reaches the task before the card ends. If it cannot, the card stays and says so.
    const flushed = group === 'working' ? await flushNotes() : null;
    if (flushed && !flushed.ok) return;
    rememberNextRow();
    setPlanUndo(null);
    setMenuKey(null);
    const key = occurrenceKey(row);
    pendingDeparture.current = null;
    if (
      !row.completion &&
      !reducedMotion &&
      (group === 'today' || group === 'overdue' || group === 'working')
    ) {
      const element = root.current?.querySelector<HTMLElement>(
        `[data-occurrence="${group}:${key}"]`,
      );
      pendingDeparture.current = {
        key,
        group,
        index: renderedRows(group).findIndex((candidate) => occurrenceKey(candidate) === key),
        occurrence: withNewestTask(row, flushed?.task ?? null),
        height: element?.offsetHeight ?? 0,
        note: group === 'working' ? noteText : '',
      };
    }
    setInFlightKey(key);
    const changed = await onToggle(row);
    if (!alive.current) return;
    setInFlightKey(null);
    if (!changed) {
      pendingNext.current = null;
      if (pendingDeparture.current?.key === key) pendingDeparture.current = null;
      return;
    }
    // A committed undo ends any finishing moment of that same occurrence at once.
    if (row.completion) setDepartures((list) => list.filter((departure) => departure.key !== key));
  }

  /** Keeps just-finished rows at their index, with the same key, until each folds away. */
  function withDeparting(rows: TaskOccurrence[], group: string) {
    const entries = rows.map((row) => ({ row, departure: null as Departure | null }));
    const present = new Set(rows.map(occurrenceKey));
    for (const departure of [...departures].sort((a, b) => a.index - b.index)) {
      if (departure.group !== group || present.has(departure.key)) continue;
      if (group === 'working' && departure !== heldCard) continue;
      entries.splice(Math.max(0, Math.min(departure.index, entries.length)), 0, {
        row: departure.occurrence,
        departure,
      });
    }
    return entries;
  }

  function hasDeparture(group: string) {
    return departures.some(
      (departure) =>
        departure.group === group &&
        !rowsOfGroup(group).some((row) => occurrenceKey(row) === departure.key),
    );
  }

  function clearNoteError() {
    setSaveError((current) => (current === NOTE_SAVE_ERROR ? null : current));
  }

  async function saveNote(row: TaskOccurrence, text: string): Promise<boolean> {
    const key = occurrenceKey(row);
    // Text typed while this save ran belongs to a later one, so the field stays open for it. The
    // saved line can be taller than the field, and the error sits above the list.
    const settled = () =>
      afterPress(() => {
        setNoteDraft((current) => (current?.key === key && current.text === text ? null : current));
        clearNoteError();
      });
    if (!working || text.trim() === working.note) {
      settled();
      return true;
    }
    try {
      await working.onSaveNote(row, text);
      if (alive.current) settled();
      return true;
    } catch {
      if (alive.current) setSaveError(NOTE_SAVE_ERROR);
      return false;
    }
  }

  /** Whatever was written on the card reaches its task before the card ends. */
  async function saveCard(row: TaskOccurrence): Promise<boolean> {
    return (await flushNotes()).ok && (await saveNote(row, noteText));
  }

  async function beginWork(row: TaskOccurrence) {
    if (!working) return;
    // Set first: the card can redraw before this call returns.
    pendingCheckFocus.current = true;
    setExpandedFor(null);
    try {
      await working.onStart(row);
      if (!alive.current) return;
      setSaveError(null);
    } catch {
      pendingCheckFocus.current = false;
      if (alive.current) setSaveError('没能开始，请重试。');
    }
  }

  async function start(row: TaskOccurrence) {
    setPlanUndo(null);
    setMenuKey(null);
    if (workingRow && !(await saveCard(workingRow))) return;
    await beginWork(row);
  }

  async function putDown() {
    if (!working || !workingRow) return;
    setPlanUndo(null);
    setMenuKey(null);
    const row = workingRow;
    if (!(await saveCard(row))) return;
    pendingTask.current = row.task.id;
    try {
      await working.onPutDown();
      if (alive.current) setSaveError(null);
    } catch {
      pendingTask.current = null;
      if (alive.current) setSaveError('没能放下，请重试。');
    }
  }

  /** The edit form compares against the stored task, so the card's newest version goes to it. */
  async function edit(row: TaskOccurrence, group: string) {
    if (group !== 'working') {
      onEdit(row.task);
      return;
    }
    const flushed = await flushNotes();
    if (flushed.ok) onEdit(withNewestTask(row, flushed.task).task);
  }

  async function applyPlan(row: TaskOccurrence, action: TaskPlanAction, group: ActiveGroup) {
    if (!plan) return;
    if (group === 'working' && !(await flushNotes()).ok) return;
    rememberNextRow();
    setMenuKey(null);
    setPlanUndo(null);
    const index = renderedRows(group).findIndex(
      (candidate) => occurrenceKey(candidate) === occurrenceKey(row),
    );
    const receipt = await plan.onApply(row, action);
    if (!alive.current) return;
    if (!receipt) {
      pendingNext.current = null;
      return;
    }
    setPlanUndo({ receipt, group, index, today: overview.localDate });
  }

  async function undoPlan(undo: PlanUndo) {
    if (!plan) return;
    if ((await plan.onUndo(undo.receipt)) && alive.current) {
      setPlanUndo(null);
      pendingTask.current = undo.receipt.taskId;
    }
  }

  async function restore(row: TaskOccurrence) {
    if (!plan) return;
    setPlanUndo(null);
    if ((await plan.onRestore(row)) && alive.current) pendingTask.current = row.task.id;
  }

  function undoLine(group: ActiveGroup) {
    if (!planUndo || planUndo.group !== group || planUndo.today !== overview.localDate) return null;
    return (
      <li className="home-task-undo" key="plan-undo">
        <span>{TASK_PLAN_DONE[planUndo.receipt.action]}</span>
        <button
          className="button text-button"
          aria-label={`撤销 ${planUndo.receipt.title}`}
          disabled={busy || operation.busy}
          onClick={() => void undoPlan(planUndo)}
        >
          撤销
        </button>
      </li>
    );
  }

  function renderRows(rows: TaskOccurrence[], group: string) {
    const blocked = unavailable || readBlocked;
    const planGroup: ActiveGroup | null =
      group === 'today' || group === 'overdue' || group === 'working' ? group : null;
    const rendered = withDeparting(rows, group).map(({ row, departure }) => {
      const key = occurrenceKey(row);
      const departed = departure !== null;
      const rowActionsDisabled = busy || blocked || operation.busy || departed;
      // Editing does not depend on the list having been read, so ⋯ stays open to it then.
      const editDisabled = busy || operation.busy || departed;
      const onCard = group === 'working';
      // A working row is already started, and a finished or future row cannot be.
      const canStart =
        working !== undefined && !departed && (group === 'today' || group === 'overdue');
      // A finished card keeps its controls in place, hidden, so its title never shifts.
      const canPlan = plan !== undefined && (!departed || onCard) && planGroup !== null;
      const completing = !row.completion && departureByKey.has(key);
      const finished = Boolean(row.completion) || completing;
      // The new row is the creation coin's origin; its check is measured, not changed.
      const origin =
        !departed && creation?.taskId === row.task.id
          ? { 'data-celebration-origin': creation.id }
          : {};
      return (
        <li
          key={key}
          {...(departed
            ? { 'aria-hidden': true, inert: true }
            : {
                'data-task-id': row.task.id,
                'data-group': group,
                'data-occurrence': `${group}:${key}`,
                tabIndex: -1,
              })}
          aria-busy={inFlightKey === key || undefined}
          className={
            departed
              ? `home-task-ghost is-completing${departure.collapsing ? ' is-collapsing' : ''}`
              : completing
                ? 'is-completing'
                : row.completion
                  ? 'home-task-completed'
                  : row.task.id === arrivedTaskId
                    ? 'home-task-arrived'
                    : ''
          }
          style={
            departure?.height
              ? ({ '--row-h': `${departure.height}px` } as CSSProperties)
              : undefined
          }
        >
          {group === 'upcoming' ? (
            <span className="home-task-future-mark" aria-label="未来安排" {...origin}>
              ○
            </span>
          ) : (
            <button
              className={`home-task-check motion-press${blocked ? ' is-blocked' : ''}`}
              aria-label={`${row.completion ? '撤销' : '完成'} ${row.task.title}`}
              data-celebration-key={group === 'completed' ? undefined : key}
              {...origin}
              disabled={busy || blocked || operation.busy || completing}
              onClick={() => void toggle(row, group)}
            >
              {completing && <span className="home-task-check-ring" aria-hidden="true" />}
              {finished && <span className="home-task-check-mark">✓</span>}
            </button>
          )}
          <div className="home-task-content">
            <strong>{row.task.title}</strong>
            {hasRowMeta(row, overview.localDate) && (
              <div className="home-task-meta">
                {row.localDate !== overview.localDate && (
                  <time dateTime={row.localDate}>{row.localDate}</time>
                )}
                {row.task.scheduledTime && <span>{row.task.scheduledTime}</span>}
                {row.task.recurrence !== 'specific_date' && (
                  <span>{row.task.recurrence === 'daily' ? '每天' : '每周'}</span>
                )}
                {row.task.priority !== 'normal' && (
                  <span>{row.task.priority === 'high' ? '高优先级' : '低优先级'}</span>
                )}
              </div>
            )}
            {row.task.notes && !onCard && (
              <details className="home-task-notes">
                <summary>查看备注</summary>
                <p>{row.task.notes}</p>
              </details>
            )}
          </div>
          {/* Starting or putting down moves these buttons, so the second click of a double-click
              lands on whatever is now under the pointer. It is not a second decision. A keyboard or
              screen reader click has no count, so it always goes through. */}
          <div
            className="home-task-actions"
            onMouseDownCapture={(event) => {
              if (event.detail > 1) event.preventDefault();
            }}
            onClickCapture={(event) => {
              if (event.detail > 1) event.stopPropagation();
            }}
          >
            {canStart && (
              <button
                className="button text-button home-task-start"
                aria-label={`开始 ${row.task.title}`}
                disabled={rowActionsDisabled}
                onClick={() => void start(row)}
              >
                开始
              </button>
            )}
            {onCard && (
              <button
                className="button text-button home-task-put-down"
                aria-label={`先放下 ${row.task.title}`}
                disabled={rowActionsDisabled}
                onClick={() => void putDown()}
              >
                先放下
              </button>
            )}
            {/* Where ⋯ can appear, 编辑 lives in it. A row with no menu keeps it out here, since a
                menu of one would only add a click. A finished row has neither. */}
            {(plan === undefined || planGroup === null) && (
              <button
                className="button text-button home-task-edit"
                disabled={editDisabled}
                aria-label={`编辑 ${row.task.title}`}
                onClick={() => void edit(row, group)}
              >
                编辑
              </button>
            )}
            {canPlan && (
              <button
                className="button text-button home-task-more"
                aria-label={`更多 ${row.task.title}`}
                aria-expanded={menuKey === key}
                disabled={editDisabled}
                onClick={() => setMenuKey(menuKey === key ? null : key)}
                onKeyDown={(event) => {
                  // Opening it leaves focus here, outside the menu's own handler.
                  if (event.key === 'Escape' && menuKey === key) setMenuKey(null);
                }}
              >
                ⋯
              </button>
            )}
          </div>
          {canPlan && menuKey === key && planGroup && (
            <div
              className="home-task-plan"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                setMenuKey(null);
                event.currentTarget.parentElement
                  ?.querySelector<HTMLElement>('.home-task-more')
                  ?.focus();
              }}
            >
              <button
                className="button text-button"
                aria-label={`编辑 ${row.task.title}`}
                disabled={editDisabled}
                onClick={(event) => {
                  // The menu goes away with this button, and a note that cannot be saved stays here.
                  event.currentTarget.parentElement?.parentElement
                    ?.querySelector<HTMLElement>('.home-task-more')
                    ?.focus();
                  setMenuKey(null);
                  void edit(row, group);
                }}
              >
                编辑
              </button>
              {rowPlanActions(row.task).map((action) => (
                <button
                  className="button text-button"
                  key={action}
                  aria-label={`${TASK_PLAN_LABELS[action]} ${row.task.title}`}
                  disabled={rowActionsDisabled}
                  onClick={() => void applyPlan(row, action, planGroup)}
                >
                  {TASK_PLAN_LABELS[action]}
                </button>
              ))}
            </div>
          )}
        </li>
      );
    });
    const undo = planGroup ? undoLine(planGroup) : null;
    if (undo && planUndo) {
      rendered.splice(Math.max(0, Math.min(planUndo.index, rendered.length)), 0, undo);
    }
    return <ol className="home-task-list">{rendered}</ol>;
  }

  const undoInGroup = (group: string) =>
    planUndo?.group === group && planUndo.today === overview.localDate;
  const workingUndo = undoInGroup('working');
  const skippedRows = plan ? (overview.skipped ?? []) : [];
  // The card's own row is not one of the rest, and a finished one has already left the count.
  const restCount = workingRow ? openToday - 1 : openToday;

  return (
    <section className="home-tasks-card" ref={root} aria-labelledby="home-tasks-heading">
      <header className="home-tasks-header">
        <div>
          <h3 id="home-tasks-heading" tabIndex={-1}>
            全部待办
          </h3>
        </div>
        <button
          ref={add}
          className="button primary-action"
          data-celebration-fallback="task-create"
          disabled={busy || operation.busy}
          onClick={() => {
            if (draft) {
              root.current?.querySelector<HTMLInputElement>('.task-form input')?.focus();
              return;
            }
            if (!requestEditorLeave()) return;
            setSaveError(null);
            setDraft({
              id: crypto.randomUUID(),
              values: createDefaultTaskDraft(overview.localDate),
            });
          }}
        >
          <ActionIcon kind="plus" />
          添加待办
        </button>
        <div className="home-task-counts" aria-label="待办数量">
          <span
            className={`home-task-progress${allDone ? ' is-all-done' : ''}${
              celebration?.kind === 'all-done' ? ' is-celebrating' : ''
            }`}
          >
            今天 <strong>{unavailable ? '—' : `${doneToday}/${planToday}`}</strong>
          </span>
          <span>
            之后 <strong>{unavailable ? '—' : overview.upcoming.length}</strong>
          </span>
          {balance !== undefined && (
            <span className="home-task-wallet">
              零花钱 <strong data-wallet-target="tasks-card">{balance}</strong>
            </span>
          )}
        </div>
      </header>
      <div className="home-task-feedback">{feedback}</div>
      <div className="home-working-slot">
        {!unavailable && (cardRow || workingUndo) && (
          <HomeWorkingCard
            cardRef={workingCardElement}
            {...(cardRow
              ? {
                  fields: {
                    finished: !workingRow,
                    next: {
                      text: workingRow ? noteText : (heldCard?.note ?? ''),
                      editing: noteEditing,
                      onOpen: () => workingKey && setNoteDraft({ key: workingKey, text: noteText }),
                      onChange: (text: string) => {
                        nextStepKeystrokes.current += 1;
                        if (workingKey) setNoteDraft({ key: workingKey, text });
                      },
                      onCommit: () =>
                        workingRow ? saveNote(workingRow, noteText) : Promise.resolve(true),
                      onCancel: () => {
                        setNoteDraft(null);
                        clearNoteError();
                      },
                    },
                    notes,
                  },
                }
              : {})}
          >
            {renderRows(renderedRows('working'), 'working')}
          </HomeWorkingCard>
        )}
        {!unavailable && cardKey && (
          <button
            ref={restToggle}
            className="button text-button home-working-rest-toggle"
            aria-expanded={!restHidden}
            aria-controls="home-task-rest"
            onClick={() => setExpandedFor(restHidden ? cardKey : null)}
          >
            {!restHidden ? '收起' : restCount > 0 ? `今天还有 ${restCount} 项` : '其余待办'}
          </button>
        )}
      </div>
      <div
        className="home-task-scroll"
        tabIndex={restHidden ? undefined : 0}
        role="region"
        aria-label="全部待办列表"
      >
        {saveError && <Notice tone="error">{saveError}</Notice>}
        <StrandedNotes
          notes={notes}
          focusAfter={() =>
            root.current
              ?.querySelector<HTMLElement>('#home-tasks-heading')
              ?.focus({ preventScroll: true })
          }
        />
        {draft && (
          <TaskForm
            key={draft.id}
            initial={draft.values}
            draftId={draft.id}
            learningItems={items}
            defaultLocalDate={overview.localDate}
            submitLabel="创建待办"
            busy={operation.busy}
            onOptionsOpen={() => void loadItems()}
            onSubmit={save}
            onCancel={() => {
              setDraft(null);
              setSaveError(null);
              add.current?.focus();
            }}
          />
        )}
        {draft && itemError && (
          <Notice tone="warning">
            {itemError}{' '}
            <button className="button text-button" onClick={() => void loadItems()}>
              重试加载
            </button>
          </Notice>
        )}
        <div id="home-task-rest" ref={rest} hidden={restHidden}>
          {!unavailable &&
            groups.map((group) => {
              const undoHere = undoInGroup(group.key);
              const hasRows = renderedRows(group.key).length > 0;
              const finishing = hasDeparture(group.key);
              // No overdue tasks: no group at all. Its last row folds the whole group with it.
              if (group.key === 'overdue' && !hasRows && !finishing && !undoHere) return null;
              const folding =
                group.key === 'overdue' &&
                !hasRows &&
                !undoHere &&
                departures.every(
                  (departure) => departure.group !== group.key || departure.collapsing,
                );
              return (
                <section
                  className={`home-task-group${folding ? ' is-folding' : ''}`}
                  key={group.key}
                  aria-labelledby={`home-task-${group.key}`}
                >
                  <h4 id={`home-task-${group.key}`}>
                    {group.label}
                    <span>{renderedRows(group.key).length}</span>
                  </h4>
                  {/* While the last row folds, the all-done line already sits beneath it in the
                    same cell, so the group shrinks once instead of collapsing and then growing. */}
                  <div className="home-task-group-body">
                    {(hasRows || finishing || undoHere) &&
                      renderRows(renderedRows(group.key), group.key)}
                    {group.key === 'today' && allDone && group.rows.length === 0 && !undoHere && (
                      <p className="home-task-all-done">今天的待办都完成了 ✓</p>
                    )}
                  </div>
                </section>
              );
            })}
          {unavailable && (
            <p className="muted" role="status">
              {loading ? '正在加载待办…' : '待办没加载出来，请重试。'}
            </p>
          )}
          {!unavailable && overview.completed.length > 0 && (
            <details
              className="home-task-completed-group"
              open={completedOpen}
              onToggle={(event) => setCompletedOpen(event.currentTarget.open)}
            >
              <summary>
                今天已完成 <span>{overview.completed.length}</span>
              </summary>
              {renderRows(overview.completed, 'completed')}
            </details>
          )}
          {!unavailable && skippedRows.length > 0 && (
            <details className="home-task-completed-group">
              <summary>
                今天不做 <span>{skippedRows.length}</span>
              </summary>
              <ol className="home-task-list">
                {skippedRows.map((row) => (
                  <li key={occurrenceKey(row)}>
                    <span className="home-task-skipped-mark" aria-hidden="true">
                      −
                    </span>
                    <div className="home-task-content">
                      <strong>{row.task.title}</strong>
                    </div>
                    <button
                      className="button text-button"
                      aria-label={`恢复今天 ${row.task.title}`}
                      disabled={busy || readBlocked || operation.busy}
                      onClick={() => void restore(row)}
                    >
                      恢复今天
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
        {!restHidden && (
          <button className="button text-button" onClick={onManage}>
            管理待办与历史
          </button>
        )}
      </div>
    </section>
  );
}

function occurrenceKey(row: TaskOccurrence): string {
  return `${row.task.id}:${row.localDate}`;
}

function withNewestTask(row: TaskOccurrence, task: DailyTask | null): TaskOccurrence {
  return task?.id === row.task.id && task.updatedAt >= row.task.updatedAt ? { ...row, task } : row;
}

/** Today and 一次性 go without saying, so many rows have no second line at all. */
function hasRowMeta(row: TaskOccurrence, today: string): boolean {
  return (
    row.localDate !== today ||
    Boolean(row.task.scheduledTime) ||
    row.task.recurrence !== 'specific_date' ||
    row.task.priority !== 'normal'
  );
}
