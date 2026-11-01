import { saveTaskDraftWithReward } from './task-save';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  DailyTask,
  DailyTaskKind,
  DailyTaskUpdate,
  LearningItem,
  ListItemsOptions,
  NewDailyTask,
  TaskCompletion,
  TaskCompletionResult,
  TaskDaySummary,
  TaskOccurrence,
  TaskPriority,
} from '../database';
import { learningItemTitle } from '../database';
import { addLocalCalendarDays, localDateKey, nextScheduledDate } from '../models/daily-task';
import { LiveStatus, Notice } from '../shared/components';
import { loadAllowance, type AllowanceState, type TaskAllowanceResult } from '../shared/allowance';
import {
  taskCelebrationFor,
  taskChangeMessage,
  taskCreationCelebrationFor,
  taskCreationMessage,
  type TaskCelebration,
} from '../shared/task-celebration';
import { changeTaskCompletion } from './task-completion';
import { displayError, hasExtensionRuntime } from '../shared/extension';
import { useOperation } from '../shared/use-operation';
import { requestEditorLeaveAsync, useEditProtection } from '../shared/edit-protection';
import { useMinuteClock } from './useMinuteClock';
import { forgetDeletedTask } from '../shared/working-card-store';
import {
  MOTION_DURATION_MS,
  MotionCount,
  safeViewTransition,
  useReducedMotion,
} from '../ui/motion';
import {
  buildCompanionHomeMessage,
  Companion,
  useCompanionArtPreload,
  worriedCompanionLeading,
} from './Companion';
import { headPoseForMood } from '../companion/companion-scenes';
import { TaskCoinLayer } from './TaskCelebration';
import { useTaskCelebration } from './use-task-celebration';
import { useDelayedFlag } from '../shared/use-delayed-flag';
import './task-feedback.css';
import { repository as defaultRepository } from './services';
import {
  createDefaultTaskDraft,
  TaskForm,
  type TaskFormDraft,
  type TaskFormValues,
  type TaskFormCommit,
} from './TaskForm';
import { freshCompanionMessage, useFreshInstall } from '../edition/fresh-install';

export type TasksSection = 'today' | 'upcoming' | 'active' | 'completed' | 'archived';

export type TaskEditorRequest =
  | { key: number; mode: 'create'; initial?: TaskFormDraft }
  | { key: number; mode: 'edit'; task: DailyTask };

export type TaskEditorRequestInput =
  { mode: 'create'; initial?: TaskFormDraft } | { mode: 'edit'; task: DailyTask };

type TaskMotionState = {
  id: string;
  kind: 'restored' | 'created' | 'updated';
};

export interface TaskDashboardRepository {
  listTasks(): Promise<DailyTask[]>;
  listTaskCompletions(): Promise<TaskCompletion[]>;
  listItems(options?: ListItemsOptions): Promise<LearningItem[]>;
  getTaskDaySummary(localDate: string): Promise<TaskDaySummary>;
  createTask(
    input: NewDailyTask,
    draft?: import('../database/drafts').DraftToken,
  ): Promise<DailyTask>;
  /** The same atomic create, also returning the committed grant; preferred when present. */
  createTaskWithReward?(
    input: NewDailyTask,
    draft?: import('../database/drafts').DraftToken,
  ): Promise<{ task: DailyTask; reward: TaskAllowanceResult }>;
  getTask?(id: string): Promise<DailyTask | undefined>;
  updateTask(
    id: string,
    changes: DailyTaskUpdate,
    commit?: import('../database/edit-commit').EditCommit,
  ): Promise<DailyTask>;
  archiveTask(id: string, archived?: boolean): Promise<DailyTask>;
  deleteTask(id: string): Promise<void>;
  completeTaskForDate(taskId: string, localDate?: string): Promise<TaskCompletion>;
  completeTaskForDateWithResult(taskId: string, localDate?: string): Promise<TaskCompletionResult>;
  undoTaskCompletion(taskId: string, localDate: string): Promise<boolean>;
  changeTaskCompletionAtomic?: import('./task-completion').TaskCompletionPort['atomic'];
}

const systemClock = () => new Date();

export function TasksView({
  revision,
  onChanged,
  editorRequest,
  onEditorRequestConsumed,
  taskRepository = defaultRepository,
  clock = systemClock,
  allowanceLoader = loadAllowance,
}: {
  revision: number;
  onChanged: () => void;
  editorRequest?: TaskEditorRequest | null;
  onEditorRequestConsumed?: () => void;
  taskRepository?: TaskDashboardRepository;
  clock?: () => Date;
  allowanceLoader?: () => Promise<AllowanceState>;
}) {
  const now = useMinuteClock(clock);
  const today = localDateKey(now);
  const freshInstall = __VALRECALL_PUBLIC_RELEASE__
    ? useFreshInstall(revision, defaultRepository)
    : false;
  const [section, setSection] = useState<TasksSection>('today');
  const [tasks, setTasks] = useState<DailyTask[]>([]);
  const [completions, setCompletions] = useState<TaskCompletion[]>([]);
  const [items, setItems] = useState<LearningItem[]>([]);
  const [summary, setSummary] = useState<TaskDaySummary>(emptySummary(today));
  const [kindFilter, setKindFilter] = useState<DailyTaskKind | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | 'all'>('all');
  const [editor, setEditor] = useState<
    { mode: 'create'; initial: TaskFormDraft } | { mode: 'edit'; task: DailyTask } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [editorVersion, setEditorVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // A fast refresh after a save never flashes; a slow one still shows.
  const refreshVisible = useDelayedFlag(refreshing);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [taskMotion, setTaskMotion] = useState<TaskMotionState | null>(null);
  // Every result mounts a new notice (keyed by its sequence), so an identical warning or
  // error that comes back for the next action is announced again.
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'warning' | 'error';
    seq: number;
  } | null>(null);
  const noticeSeq = useRef(0);
  // Every successful result is spoken by a hidden status line: the row, seal, coin and counts
  // already show it, so nothing appears or moves. The sequence re-announces an identical
  // sentence. Warnings and errors keep the visible notice.
  const [liveStatus, setLiveStatus] = useState<{ text: string; seq: number } | null>(null);
  const liveStatusSeq = useRef(0);
  // A committed creation grant flies once the refreshed list has the new row and it has focus.
  const pendingCreationRef = useRef<TaskCelebration | null>(null);
  const loadedRef = useRef(false);
  const loadRequest = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const operation = useOperation();
  useEditProtection({ dirty: false, busy: () => operation.pending.current });
  const motionTimerRef = useRef<number | null>(null);
  const creationId = useRef(crypto.randomUUID());
  const pendingFocusTaskIdRef = useRef<string | null>(null);
  const pendingSectionFocusRef = useRef(false);
  const pendingActionFocusRef = useRef<string | null>(null);
  const addTaskButtonRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useReducedMotion();
  const taskCelebration = useTaskCelebration();
  const [balance, setBalance] = useState<number | null>(null);
  // The joyful head is decoded first, so a celebration never flashes the placeholder.
  const successPortraitReady = useCompanionArtPreload([headPoseForMood('success')], today);

  useEffect(() => {
    if (allowanceLoader === loadAllowance && !hasExtensionRuntime()) return;
    let active = true;
    void allowanceLoader()
      .then((loaded) => {
        if (active) setBalance(loaded.balance);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [allowanceLoader, revision]);

  async function load() {
    const request = ++loadRequest.current;
    if (!loadedRef.current) setLoading(true);
    else setRefreshing(true);
    try {
      const [loadedTasks, loadedCompletions, loadedItems, loadedSummary] = await Promise.all([
        taskRepository.listTasks(),
        taskRepository.listTaskCompletions(),
        taskRepository.listItems({ includeReviewHistory: false }),
        taskRepository.getTaskDaySummary(today),
      ]);
      if (request !== loadRequest.current) return;
      setTasks(loadedTasks);
      setCompletions(loadedCompletions);
      setItems(loadedItems);
      setSummary(loadedSummary);
      loadedRef.current = true;
      setLoadError(null);
    } catch (error) {
      if (request !== loadRequest.current) return;
      setLoadError(displayError(error, '待办无法加载。'));
    } finally {
      if (request === loadRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void load();
    return () => {
      loadRequest.current += 1;
    };
  }, [revision, taskRepository, today]);

  useEffect(() => {
    if (!editorRequest) return;
    setEditorVersion((version) => version + 1);
    const requestedTask = editorRequest.mode === 'edit' ? editorRequest.task : null;
    const requestedDate = requestedTask ? nextScheduledDate(requestedTask, today) : null;
    setSection(
      requestedTask?.archived
        ? 'archived'
        : requestedDate && requestedDate > today
          ? 'upcoming'
          : 'today',
    );
    creationId.current = crypto.randomUUID();
    setEditor(
      editorRequest.mode === 'edit'
        ? { mode: 'edit', task: editorRequest.task }
        : { mode: 'create', initial: editorRequest.initial ?? createDefaultTaskDraft(today) },
    );
    onEditorRequestConsumed?.();
  }, [editorRequest?.key]);

  useEffect(() => {
    if (!editor || loading) return;
    document.querySelector<HTMLElement>('#task-form-heading')?.focus();
  }, [editor, loading]);

  useEffect(() => {
    // Wait for the refresh a save started, so the new row can receive focus.
    if (loading || refreshing) return;
    const taskId = pendingFocusTaskIdRef.current;
    if (taskId !== null) {
      pendingFocusTaskIdRef.current = null;
      const target = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].find(
        (candidate) => candidate.dataset.taskId === taskId,
      );
      if (target) {
        // Brought into view before the coin is measured, so the coin starts at the new row.
        // A long 即将到来 list can scroll the header wallet away: the amount then shows at
        // the row (and as the static receipt for reduced motion) instead of nothing.
        target.focus({ preventScroll: true });
        target.scrollIntoView?.({ block: 'nearest' });
      } else addTaskButtonRef.current?.focus();
      const creation = pendingCreationRef.current;
      pendingCreationRef.current = null;
      if (creation) taskCelebration.celebrate(creation, { companion: false });
      if (target) return;
    }
    if (pendingSectionFocusRef.current) {
      document.querySelector<HTMLButtonElement>(`[data-task-section="${section}"]`)?.focus();
      pendingSectionFocusRef.current = false;
    }
  }, [completions, section, summary, tasks, editor, loading, refreshing]);

  useEffect(() => {
    // Once the completed or reopened row is usable again, focus returns to its button unless
    // the person has already moved on to another control.
    if (busyTaskId !== null) return;
    const taskId = pendingActionFocusRef.current;
    pendingActionFocusRef.current = null;
    if (taskId === null) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      actionFocusTaskId(active) !== taskId
    )
      return;
    const row = [...document.querySelectorAll<HTMLElement>('[data-task-id]')].find(
      (candidate) => candidate.dataset.taskId === taskId,
    );
    row
      ?.querySelector<HTMLButtonElement>('[data-task-action="complete"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [busyTaskId]);

  useEffect(
    () => () => {
      if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current);
    },
    [],
  );

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const visibleToday = summary.occurrences.filter((occurrence) => matchesFilters(occurrence.task));
  const visibleTasks = tasks.filter(matchesFilters);
  const upcoming = useMemo(() => {
    const firstFutureDate = addLocalCalendarDays(today, 1);
    return visibleTasks
      .filter((task) => !task.archived)
      .map((task) => ({ task, date: nextScheduledDate(task, firstFutureDate) }))
      .filter((entry): entry is { task: DailyTask; date: string } => entry.date !== null)
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) || compareTaskTimeAndTitle(left.task, right.task),
      );
  }, [today, visibleTasks]);
  // The bubble names the reviews that are still due, never a review it has not counted.
  const dueReviewCount = useMemo(
    () =>
      items.filter((item) => !item.suspended && item.fsrsCard.due.getTime() <= now.getTime())
        .length,
    [items, now],
  );
  const companionState =
    taskCelebration.reaction && successPortraitReady
      ? 'success'
      : summary.remaining > 0
        ? 'due'
        : 'idle';
  const visibleCompletions = completions.filter((completion) => {
    const task = taskById.get(completion.taskId);
    return task === undefined || matchesFilters(task);
  });

  function matchesFilters(task: DailyTask): boolean {
    return (
      (kindFilter === 'all' || task.kind === kindFilter) &&
      (priorityFilter === 'all' || task.priority === priorityFilter)
    );
  }

  // An empty section mentions the filters only when one is actually on.
  const filtering = kindFilter !== 'all' || priorityFilter !== 'all';

  function showTaskMotion(id: string, kind: TaskMotionState['kind']) {
    setTaskMotion({ id, kind });
    if (motionTimerRef.current !== null) window.clearTimeout(motionTimerRef.current);
    const duration =
      kind === 'restored' ? MOTION_DURATION_MS.standard : MOTION_DURATION_MS.emphasis;
    motionTimerRef.current = window.setTimeout(() => {
      motionTimerRef.current = null;
      setTaskMotion(null);
    }, duration);
  }

  function announce(text: string) {
    setLiveStatus({ text, seq: ++liveStatusSeq.current });
  }

  function showNotice(text: string, tone: 'warning' | 'error') {
    setNotice({ text, tone, seq: ++noticeSeq.current });
  }

  function changeSection(nextSection: TasksSection) {
    if (nextSection === section) return;
    safeViewTransition(() => setSection(nextSection), { reducedMotion });
  }

  async function openEditor(next: NonNullable<typeof editor>) {
    if (!(await requestEditorLeaveAsync())) return;
    creationId.current = crypto.randomUUID();
    setEditor(next);
    setEditorVersion((version) => version + 1);
  }

  async function saveTask(values: TaskFormValues, commit: TaskFormCommit) {
    if (!operation.begin()) return;
    try {
      let savedTask: DailyTask;
      if (editor?.mode === 'edit') {
        savedTask = await taskRepository.updateTask(editor.task.id, values, commit);
        setNotice(null);
        announce('待办已更新。');
        showTaskMotion(savedTask.id, 'updated');
      } else {
        const created = await saveTaskDraftWithReward(
          taskRepository,
          commit.id,
          values,
          commit.draft,
        );
        savedTask = created.task;
        if (created.reward) setBalance(created.reward.state.balance);
        setNotice(null);
        announce(taskCreationMessage(created.reward?.reward ?? 0));
        pendingCreationRef.current = taskCreationCelebrationFor({
          taskId: savedTask.id,
          localDate: today,
          reward: created.reward,
        });
        showTaskMotion(savedTask.id, 'created');
      }
      setKindFilter('all');
      setPriorityFilter('all');
      if (editor?.mode !== 'edit') {
        const nextDate = nextScheduledDate(savedTask, today);
        setSection(nextDate && nextDate > today ? 'upcoming' : 'today');
      }
      pendingFocusTaskIdRef.current = savedTask.id;
      setEditor(null);
      onChanged();
      await load();
      return true;
    } catch (error) {
      showNotice(displayError(error, '待办无法保存。'), 'error');
    } finally {
      operation.finish();
    }
  }

  async function complete(occurrence: TaskOccurrence) {
    // The row's own 完成/撤销 button is disabled while busy, which drops keyboard focus to
    // the page; it is given back once the row is usable again.
    const keepFocus = actionFocusTaskId(document.activeElement) === occurrence.task.id;
    if (!operation.begin()) return;
    setBusyTaskId(occurrence.task.id);
    pendingActionFocusRef.current = null;
    // The reaction pose cycles with today's completions; fixed here, before the commit.
    const completedBefore = summary.completed;
    try {
      const result = await changeTaskCompletion(
        {
          complete: (id, date) => taskRepository.completeTaskForDateWithResult(id, date),
          undo: (id, date) => taskRepository.undoTaskCompletion(id, date),
          atomic: taskRepository.changeTaskCompletionAtomic?.bind(taskRepository),
        },
        occurrence.task.id,
        occurrence.localDate,
        !occurrence.completion,
        clock(),
      );
      if (result.reward) setBalance(result.reward.state.balance);
      if (occurrence.completion && result.changed)
        taskCelebration.dismiss(occurrence.task.id, occurrence.localDate);
      const completing = !occurrence.completion;
      // The stamp, coin and companion follow only the committed result.
      const celebration = completing
        ? taskCelebrationFor({
            completing,
            result,
            taskId: occurrence.task.id,
            localDate: occurrence.localDate,
            today,
            remainingToday:
              occurrence.localDate === today ? Math.max(0, summary.remaining - 1) : null,
            fallbackId: crypto.randomUUID(),
          })
        : null;
      // Exactly one announcement per result: a visible warning, or the hidden status line,
      // worded exactly as on Home.
      if (result.warning) showNotice(result.warning, 'warning');
      else {
        setNotice(null);
        announce(taskChangeMessage({ completing, result, celebration }));
      }
      if (!completing) {
        showTaskMotion(occurrence.task.id, 'restored');
        if (section === 'completed') pendingSectionFocusRef.current = true;
      }
      if (celebration) taskCelebration.celebrate(celebration, { ordinal: completedBefore });
      onChanged();
      await load();
    } catch (error) {
      showNotice(displayError(error, '待办完成状态无法更改。'), 'error');
    } finally {
      if (keepFocus) pendingActionFocusRef.current = occurrence.task.id;
      setBusyTaskId(null);
      operation.finish();
    }
  }

  async function archive(task: DailyTask, archived: boolean) {
    if (!operation.begin()) return;
    setBusyTaskId(task.id);
    try {
      await taskRepository.archiveTask(task.id, archived);
      setNotice(null);
      announce(archived ? '待办已归档。' : '已取消归档。');
      pendingSectionFocusRef.current = true;
      onChanged();
      await load();
    } catch (error) {
      showNotice(displayError(error, '待办无法归档。'), 'error');
    } finally {
      setBusyTaskId(null);
      operation.finish();
    }
  }

  async function remove(task: DailyTask) {
    if (operation.pending.current) return;
    if (!window.confirm(`删除「${task.title}」及其完成记录？`)) return;
    if (!operation.begin()) return;
    setBusyTaskId(task.id);
    try {
      await taskRepository.deleteTask(task.id);
      await forgetDeletedTask(task.id);
      if (editor?.mode === 'edit' && editor.task.id === task.id) setEditor(null);
      setNotice(null);
      announce('已删除。');
      pendingSectionFocusRef.current = true;
      onChanged();
      await load();
    } catch (error) {
      showNotice(displayError(error, '待办无法删除。'), 'error');
    } finally {
      setBusyTaskId(null);
      operation.finish();
    }
  }

  return (
    <section
      className="stack tasks-view"
      aria-labelledby="tasks-heading"
      aria-busy={loading || refreshing || operation.busy}
      data-reduced-motion={reducedMotion}
    >
      <TaskCoinLayer celebration={taskCelebration.current} reducedMotion={reducedMotion} />
      <div className="split">
        <h2 className="dashboard-page-heading" id="tasks-heading" tabIndex={-1}>
          待办
        </h2>
        <div className="tasks-header-actions">
          {/* Always visible, so a coin always has somewhere to land, even in 即将到来. */}
          <p className="tasks-wallet-chip">
            零花钱{' '}
            <span data-wallet-target="tasks-header">
              {balance === null ? <strong>—</strong> : <MotionCount value={balance} as="strong" />}
            </span>
          </p>
          <button
            className="button motion-press"
            ref={addTaskButtonRef}
            data-celebration-fallback="task-create"
            disabled={operation.busy}
            onClick={() => openEditor({ mode: 'create', initial: createDefaultTaskDraft(today) })}
          >
            添加待办
          </button>
        </div>
      </div>

      {notice && (
        <div className="motion-state-change" key={notice.seq}>
          <Notice
            tone={notice.tone}
            leading={notice.tone === 'error' ? worriedCompanionLeading(today) : undefined}
          >
            {notice.text}
          </Notice>
        </div>
      )}

      {loadError && (
        <Notice tone="error" leading={worriedCompanionLeading(today)}>
          {loadError}{' '}
          <button className="button secondary" disabled={refreshing} onClick={() => void load()}>
            重新加载待办
          </button>
        </Notice>
      )}
      {!loading && !loadError && notice?.tone !== 'error' && (
        <Companion
          state={companionState}
          count={dueReviewCount}
          taskCount={summary.remaining}
          compact
          placement="tasks"
          pose={headPoseForMood(companionState)}
          dateKey={today}
          message={
            taskCelebration.reaction
              ? taskCelebration.reaction.praise
              : __VALRECALL_PUBLIC_RELEASE__ &&
                  freshInstall !== false &&
                  !(summary.remaining === 0 && summary.completed > 0)
                ? freshInstall && freshCompanionMessage(summary.remaining)
                : buildCompanionHomeMessage(dueReviewCount, summary.remaining)
          }
        />
      )}

      {!loading && editor && (
        <div className="motion-reveal">
          <TaskForm
            key={editorVersion}
            draftId={creationId.current}
            initial={editor.mode === 'edit' ? editor.task : editor.initial}
            learningItems={items}
            defaultLocalDate={today}
            submitLabel={editor.mode === 'edit' ? '保存待办' : '创建待办'}
            busy={operation.busy}
            onSubmit={saveTask}
            onCancel={() => {
              pendingFocusTaskIdRef.current = editor.mode === 'edit' ? editor.task.id : null;
              setEditor(null);
              if (editor.mode === 'create') addTaskButtonRef.current?.focus();
            }}
          />
        </div>
      )}

      <div className="task-toolbar">
        <div className="task-section-tabs" role="tablist" aria-label="待办分区">
          {TASK_SECTIONS.map((entry) => (
            <button
              className={`button small-button task-section-button motion-press ${
                section === entry.id ? '' : 'secondary'
              }`}
              role="tab"
              aria-selected={section === entry.id}
              data-task-section={entry.id}
              key={entry.id}
              onClick={() => changeSection(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="task-filters">
          <label className="field">
            <span>类型</span>
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as DailyTaskKind | 'all')}
            >
              <option value="all">全部</option>
              <option value="routine">重复待办</option>
              <option value="one_off">一次性</option>
              <option value="practice">学习练习</option>
            </select>
          </label>
          <label className="field">
            <span>优先级</span>
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.target.value as TaskPriority | 'all')}
            >
              <option value="all">全部</option>
              <option value="high">高</option>
              <option value="normal">普通</option>
              <option value="low">低</option>
            </select>
          </label>
        </div>
        {/* A fixed slot in the toolbar: a slow refresh shows here and never pushes the list
            down; results are spoken by the hidden status line. */}
        <div className="tasks-refresh-slot">
          <LiveStatus text={liveStatus?.text ?? null} seq={liveStatus?.seq ?? 0} />
          {refreshVisible && (
            <div className="dashboard-refresh-status" role="status">
              <span className="motion-loading-indicator" aria-hidden="true" />
              <span>正在刷新待办</span>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card dashboard-loading-state" role="status">
          <span className="motion-loading-indicator" aria-hidden="true" />
          <span>正在加载待办…</span>
        </div>
      ) : !loadedRef.current ? null : (
        <div className="stack task-section-content motion-view-swap" key={section}>
          {section === 'today' && (
            <TodayTasks
              summary={summary}
              empty={filtering ? '今天没有符合筛选的待办。' : '今天没有待办。'}
              occurrences={visibleToday}
              itemById={itemById}
              busyTaskId={busyTaskId}
              taskMotion={taskMotion}
              celebration={taskCelebration.current}
              onComplete={(occurrence) => void complete(occurrence)}
              onEdit={(task) => openEditor({ mode: 'edit', task })}
              onArchive={(task) => void archive(task, true)}
            />
          )}
          {section === 'upcoming' && (
            <TaskCollection
              empty={filtering ? '没有符合筛选的即将到来的待办。' : '没有即将到来的待办。'}
              entries={upcoming.map(({ task, date }) => ({ task, date }))}
              itemById={itemById}
              busyTaskId={busyTaskId}
              taskMotion={taskMotion}
              celebration={taskCelebration.current}
              onEdit={(task) => openEditor({ mode: 'edit', task })}
              onArchive={(task) => void archive(task, true)}
              onDelete={(task) => void remove(task)}
            />
          )}
          {section === 'active' && (
            <TaskCollection
              empty={filtering ? '没有符合筛选的进行中待办。' : '没有进行中的待办。'}
              entries={visibleTasks.filter((task) => !task.archived).map((task) => ({ task }))}
              itemById={itemById}
              busyTaskId={busyTaskId}
              taskMotion={taskMotion}
              celebration={taskCelebration.current}
              onEdit={(task) => openEditor({ mode: 'edit', task })}
              onArchive={(task) => void archive(task, true)}
              onDelete={(task) => void remove(task)}
            />
          )}
          {section === 'completed' && (
            <CompletedHistory
              empty={filtering ? '没有符合筛选的完成记录。' : '没有完成记录。'}
              completions={visibleCompletions}
              taskById={taskById}
              busyTaskId={busyTaskId}
              taskMotion={taskMotion}
              onUndo={(task, completion) =>
                void complete({ task, localDate: completion.localDate, completion })
              }
            />
          )}
          {section === 'archived' && (
            <TaskCollection
              empty={filtering ? '没有符合筛选的已归档待办。' : '没有已归档的待办。'}
              entries={visibleTasks.filter((task) => task.archived).map((task) => ({ task }))}
              itemById={itemById}
              busyTaskId={busyTaskId}
              taskMotion={taskMotion}
              onEdit={(task) => openEditor({ mode: 'edit', task })}
              onArchive={(task) => void archive(task, false)}
              onDelete={(task) => void remove(task)}
              archived
            />
          )}
        </div>
      )}
    </section>
  );
}

const TASK_SECTIONS: ReadonlyArray<{ id: TasksSection; label: string }> = [
  { id: 'today', label: '今天' },
  { id: 'upcoming', label: '即将到来' },
  { id: 'active', label: '全部进行中' },
  { id: 'completed', label: '完成记录' },
  { id: 'archived', label: '已归档' },
];

function TodayTasks({
  summary,
  empty,
  occurrences,
  itemById,
  busyTaskId,
  taskMotion,
  celebration,
  onComplete,
  onEdit,
  onArchive,
}: {
  summary: TaskDaySummary;
  empty: string;
  occurrences: TaskOccurrence[];
  itemById: ReadonlyMap<string, LearningItem>;
  busyTaskId: string | null;
  taskMotion: TaskMotionState | null;
  celebration: TaskCelebration | null;
  onComplete(occurrence: TaskOccurrence): void;
  onEdit(task: DailyTask): void;
  onArchive(task: DailyTask): void;
}) {
  return (
    <section className="card stack">
      <div className="task-summary" aria-label="今天的待办摘要">
        <TaskStat label="全部" value={summary.total} />
        <TaskStat label="已完成" value={summary.completed} />
        <TaskStat label="剩余" value={summary.remaining} />
      </div>
      {occurrences.length === 0 ? (
        <div className="empty-state motion-state-change">{empty}</div>
      ) : (
        <div className="task-list">
          {occurrences.map((occurrence) => (
            <TaskRow
              key={occurrence.task.id}
              task={occurrence.task}
              {...optionalItem(linkedItem(occurrence.task, itemById))}
              missingLink={hasMissingLink(occurrence.task, itemById)}
              completed={occurrence.completion !== null}
              busy={busyTaskId === occurrence.task.id}
              {...motionKindFor(occurrence.task.id, taskMotion)}
              celebrationId={
                celebration?.kind !== 'created' &&
                celebration?.taskId === occurrence.task.id &&
                celebration.localDate === occurrence.localDate
                  ? celebration.id
                  : null
              }
              creationId={creationIdFor(occurrence.task.id, celebration)}
              onComplete={() => onComplete(occurrence)}
              onEdit={() => onEdit(occurrence.task)}
              onArchive={() => onArchive(occurrence.task)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskCollection({
  entries,
  empty,
  itemById,
  busyTaskId,
  taskMotion,
  celebration = null,
  onEdit,
  onArchive,
  onDelete,
  archived = false,
}: {
  entries: Array<{ task: DailyTask; date?: string }>;
  empty: string;
  itemById: ReadonlyMap<string, LearningItem>;
  busyTaskId: string | null;
  taskMotion: TaskMotionState | null;
  celebration?: TaskCelebration | null;
  onEdit(task: DailyTask): void;
  onArchive(task: DailyTask): void;
  onDelete(task: DailyTask): void;
  archived?: boolean;
}) {
  if (entries.length === 0) return <div className="empty-state motion-state-change">{empty}</div>;
  return (
    <div className="task-list">
      {entries.map(({ task, date }) => (
        <TaskRow
          key={task.id}
          task={task}
          {...(date === undefined ? {} : { date })}
          {...optionalItem(linkedItem(task, itemById))}
          missingLink={hasMissingLink(task, itemById)}
          busy={busyTaskId === task.id}
          {...motionKindFor(task.id, taskMotion)}
          creationId={creationIdFor(task.id, celebration)}
          onEdit={() => onEdit(task)}
          onArchive={() => onArchive(task)}
          onDelete={() => onDelete(task)}
          archiveLabel={archived ? '取消归档' : '归档'}
        />
      ))}
    </div>
  );
}

function CompletedHistory({
  empty,
  completions,
  taskById,
  busyTaskId,
  taskMotion,
  onUndo,
}: {
  empty: string;
  completions: TaskCompletion[];
  taskById: ReadonlyMap<string, DailyTask>;
  busyTaskId: string | null;
  taskMotion: TaskMotionState | null;
  onUndo(task: DailyTask, completion: TaskCompletion): void;
}) {
  if (completions.length === 0) {
    return <div className="empty-state motion-state-change">{empty}</div>;
  }
  return (
    <div className="task-list">
      {completions.map((completion) => {
        const task = taskById.get(completion.taskId);
        return (
          <article
            className={`card task-row${taskMotionClass(task?.id, taskMotion)}`}
            data-task-id={task?.id}
            key={completion.id}
            tabIndex={-1}
          >
            <div>
              <time className="muted small" dateTime={completion.completedAt}>
                {formatDateTime(new Date(completion.completedAt))}
              </time>
              <h3>{task?.title ?? '已删除的待办'}</h3>
              <p className="muted small">安排日期：{formatLocalDate(completion.localDate)}</p>
            </div>
            {task && (
              <div className="task-row-actions">
                <button
                  className="button secondary small-button motion-press"
                  disabled={busyTaskId === task.id}
                  onClick={() => onUndo(task, completion)}
                >
                  撤销完成
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  date,
  item,
  missingLink = false,
  completed,
  busy,
  onComplete,
  onEdit,
  onArchive,
  onDelete,
  archiveLabel = '归档',
  motionKind,
  celebrationId = null,
  creationId = null,
}: {
  task: DailyTask;
  date?: string;
  item?: LearningItem;
  missingLink?: boolean;
  completed?: boolean;
  busy: boolean;
  onComplete?: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete?: () => void;
  archiveLabel?: string;
  motionKind?: TaskMotionState['kind'];
  /** Set while a committed completion of this row is being celebrated. */
  celebrationId?: string | null;
  /** Set while the creation grant of this new row is shown: its coin starts at the title. */
  creationId?: string | null;
}) {
  return (
    <article
      className={`card task-row${completed ? ' task-completed' : ''}${
        motionKind ? ` task-motion-${motionKind}` : ''
      }`}
      data-task-id={task.id}
      tabIndex={-1}
    >
      <div className="task-row-copy">
        <div className="cluster">
          <span className="pill">{kindLabel(task.kind)}</span>
          {task.priority !== 'normal' && (
            <span className={`pill task-priority-${task.priority}`}>
              {priorityLabel(task.priority)}
            </span>
          )}
          {task.scheduledTime && <span className="pill">{task.scheduledTime}</span>}
          {date && <span className="muted small">{formatLocalDate(date)}</span>}
        </div>
        <h3>
          {/* The creation coin starts at the title text, not the middle of the full-width row. */}
          <span {...(creationId ? { 'data-celebration-origin': creationId } : {})}>
            {task.title}
          </span>
        </h3>
        {task.notes && <p>{task.notes}</p>}
        {item && (
          <p className="muted small">
            关联 {learningItemTitle(item)}
            {item.sourceType === 'text'
              ? ' · 文字'
              : item.sourceType === 'image'
                ? ' · 图片'
                : item.timestampDisplay
                  ? ` · ${item.timestampDisplay}`
                  : ' · 视频'}
          </p>
        )}
        {missingLink && <p className="muted small">关联的学习条目不可用</p>}
      </div>
      <div className="task-row-actions">
        {onComplete && (
          <span className="task-complete-action">
            <button
              className={`button small-button motion-press ${completed ? 'secondary' : ''}`}
              data-task-action="complete"
              disabled={busy}
              aria-busy={busy}
              aria-label={completed ? `撤销 ${task.title}` : `完成 ${task.title}`}
              onClick={onComplete}
            >
              {completed ? '撤销' : '完成'}
            </button>
            {celebrationId && (
              <span
                className="task-celebration-seal"
                data-celebration-origin={celebrationId}
                aria-hidden="true"
              >
                ✓
              </span>
            )}
          </span>
        )}
        <button
          className="button secondary small-button motion-press"
          disabled={busy}
          onClick={onEdit}
        >
          编辑
        </button>
        <button
          className="button secondary small-button motion-press"
          disabled={busy}
          onClick={onArchive}
        >
          {archiveLabel}
        </button>
        {onDelete && (
          <button
            className="button danger small-button motion-press"
            disabled={busy}
            onClick={onDelete}
          >
            删除
          </button>
        )}
      </div>
    </article>
  );
}

function TaskStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <MotionCount value={value} as="strong" />
      <span>{label}</span>
    </div>
  );
}

/** The task whose own 完成/撤销 button holds focus, if any. */
function actionFocusTaskId(element: Element | null): string | null {
  if (!(element instanceof HTMLElement) || element.dataset.taskAction !== 'complete') return null;
  return element.closest<HTMLElement>('[data-task-id]')?.dataset.taskId ?? null;
}

function creationIdFor(taskId: string, celebration: TaskCelebration | null): string | null {
  return celebration?.kind === 'created' && celebration.taskId === taskId ? celebration.id : null;
}

function motionKindFor(
  taskId: string,
  taskMotion: TaskMotionState | null,
): { motionKind?: TaskMotionState['kind'] } {
  if (taskMotion?.id !== taskId) return {};
  return { motionKind: taskMotion.kind };
}

function taskMotionClass(taskId: string | undefined, taskMotion: TaskMotionState | null): string {
  return taskId !== undefined && taskMotion?.id === taskId ? ` task-motion-${taskMotion.kind}` : '';
}

function linkedItem(
  task: DailyTask,
  itemById: ReadonlyMap<string, LearningItem>,
): LearningItem | undefined {
  return task.linkedLearningItemId === null ? undefined : itemById.get(task.linkedLearningItemId);
}

function optionalItem(item: LearningItem | undefined): { item?: LearningItem } {
  return item === undefined ? {} : { item };
}

function hasMissingLink(task: DailyTask, itemById: ReadonlyMap<string, LearningItem>): boolean {
  return task.linkedLearningItemId !== null && !itemById.has(task.linkedLearningItemId);
}

function kindLabel(kind: DailyTaskKind): string {
  switch (kind) {
    case 'routine':
      return '重复待办';
    case 'one_off':
      return '一次性';
    case 'practice':
      return '练习';
  }
}

function priorityLabel(priority: Exclude<TaskPriority, 'normal'>): string {
  return priority === 'high' ? '高' : '低';
}

function formatLocalDate(localDate: string): string {
  const parts = localDate.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
    new Date(year, month - 1, day, 12),
  );
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function compareTaskTimeAndTitle(left: DailyTask, right: DailyTask): number {
  return (
    (left.scheduledTime ?? '99:99').localeCompare(right.scheduledTime ?? '99:99') ||
    left.title.localeCompare(right.title)
  );
}

function emptySummary(localDate: string): TaskDaySummary {
  return { localDate, total: 0, completed: 0, remaining: 0, occurrences: [] };
}
