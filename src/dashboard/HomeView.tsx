import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import type { DailyTask, LearningItem, TaskDaySummary, TaskOccurrence } from '../database';
import { learningItemTitle } from '../database';
import { learningGoalLabel } from '../models/learning-item';
import { localDateKey } from '../models/daily-task';
import {
  DEFAULT_ALLOWANCE,
  loadAllowance,
  type AllowanceState,
  type TaskAllowanceResult,
} from '../shared/allowance';
import { LiveStatus, Notice } from '../shared/components';
import { ActionIcon } from '../shared/ActionIcon';
import { displayError, hasExtensionRuntime } from '../shared/extension';
import { DEFAULT_PREFERENCES, type ValRecallPreferences } from '../shared/preferences';
import { MotionCount, useReducedMotion } from '../ui/motion';
import {
  taskCelebrationFor,
  taskChangeMessage,
  taskCreationCelebrationFor,
  taskCreationMessage,
  type TaskCelebration,
} from '../shared/task-celebration';
import {
  buildCompanionHomeMessage,
  Companion,
  useCompanionArtPreload,
  worriedCompanionLeading,
} from './Companion';
import {
  WORKING_HEAD_POSE,
  allDonePose,
  homePose,
  reactionPose,
} from '../companion/companion-scenes';
import { TaskCoinLayer } from './TaskCelebration';
import { useTaskCelebration } from './use-task-celebration';
import { useDelayedFlag } from '../shared/use-delayed-flag';
import { HomeStatistics } from './StatisticsView';
import { ItemThumbnail } from './ItemThumbnail';
import {
  loadHomeDashboardData,
  type HomeDashboardData,
  type HomeDataRepository,
} from './home-data';
import { buildDashboardHomeSummary } from './home-summary';
import { repository } from './services';
import { UpcomingReviewsCard } from './UpcomingReviewsCard';
import { useMinuteClock } from './useMinuteClock';
import { changeTaskCompletion, type TaskCompletionPort } from './task-completion';
import { useOperation } from '../shared/use-operation';
import { useEditProtection } from '../shared/edit-protection';
import { HomeReviewStrip } from './HomeReviewStrip';
import { HomeTasks, type HomeTaskWriter } from './HomeTasks';
import {
  TASK_PLAN_DONE,
  applyTaskPlan,
  undoTaskPlan,
  type TaskPlanAction,
  type TaskPlanPort,
  type TaskPlanReceipt,
} from './task-plan';
import { useWorkingCard } from './use-working-card';
import { useWorkingLayoutTransition } from './use-working-layout-transition';
import {
  EMPTY_WORKING_PLAN,
  countOpenOneOffs,
  putDownWork,
  resolveWorkingRow,
  saveWorkingNote,
  saveWorkingPlan,
  startWork,
  workingNoteFor,
  workingPlanFor,
} from '../models/working-card';
import type { HomeTaskOverview } from '../models/task-overview';
import { freshCompanionMessage, useFreshInstall } from '../edition/fresh-install';

export type HomeItemsLoader = () => Promise<LearningItem[]>;
export type HomeDataLoader = (now: Date) => Promise<HomeDashboardData>;
export type HomeTaskSummary = TaskDaySummary & { overview?: HomeTaskOverview };
export type HomeTaskSummaryLoader = (localDate: string) => Promise<HomeTaskSummary>;

export type HomeTaskActions = TaskCompletionPort;

const loadRepositoryHomeData: HomeDataLoader = (now) =>
  loadHomeDashboardData(repository as HomeDataRepository, now);
const loadRepositoryTaskSummary: HomeTaskSummaryLoader = async (localDate) =>
  taskSummaryFromOverview(await repository.getHomeTaskOverview(localDate));
const repositoryTaskActions: HomeTaskActions = {
  atomic: (taskId, date, completed, now) =>
    repository.changeTaskCompletionAtomic(taskId, date, completed, now),
  complete: (taskId, localDate) => repository.completeTaskForDateWithResult(taskId, localDate),
  undo: (taskId, localDate) => repository.undoTaskCompletion(taskId, localDate),
};
const systemClock = () => new Date();

/** The first-run card ships in the public edition only, as its own chunk. */
const FirstRunCard = __VALRECALL_PUBLIC_RELEASE__
  ? lazy(() =>
      import('../edition/FirstRunCard').then((module) => ({ default: module.FirstRunCard })),
    )
  : null;

export function HomeView({
  initialEntry = false,
  revision,
  onStartReview,
  onAddQuestion,
  onOpenStatistics = () => undefined,
  onViewItem = () => undefined,
  onOpenTasks = () => undefined,
  onEditTask = () => undefined,
  onViewUpcoming = () => undefined,
  onOpenReminderSettings = () => undefined,
  onOpenAllowance = () => undefined,
  onTasksChanged = () => undefined,
  loadItems,
  loadHomeData = loadRepositoryHomeData,
  loadTaskSummary,
  taskActions = repositoryTaskActions,
  taskWriter = repository,
  taskPlanPort = repository,
  clock = systemClock,
  preferences = DEFAULT_PREFERENCES,
  items: controlledItems,
  taskSummary: controlledTaskSummary,
  allowance: controlledAllowance,
  allowanceLoader = loadAllowance,
}: {
  initialEntry?: boolean;
  revision: number;
  onStartReview: () => void;
  onAddQuestion: () => void;
  onOpenStatistics?: () => void;
  onViewItem?: (item: LearningItem) => void;
  onOpenTasks?: () => void;
  onEditTask?: (task: DailyTask) => void;
  onViewUpcoming?: () => void;
  onOpenReminderSettings?: () => void;
  onOpenAllowance?: () => void;
  onTasksChanged?: () => void;
  loadItems?: HomeItemsLoader;
  loadHomeData?: HomeDataLoader;
  loadTaskSummary?: HomeTaskSummaryLoader;
  taskActions?: HomeTaskActions;
  taskWriter?: HomeTaskWriter;
  taskPlanPort?: TaskPlanPort;
  clock?: () => Date;
  preferences?: ValRecallPreferences;
  items?: readonly LearningItem[];
  taskSummary?: HomeTaskSummary;
  allowance?: AllowanceState;
  allowanceLoader?: () => Promise<AllowanceState>;
}) {
  const now = useMinuteClock(clock);
  const localDate = localDateKey(now);
  const freshInstall = __VALRECALL_PUBLIC_RELEASE__ ? useFreshInstall(revision, repository) : false;
  const shouldLoadTasks =
    controlledTaskSummary === undefined &&
    (controlledItems === undefined || loadTaskSummary !== undefined);
  const taskSummaryLoader = loadTaskSummary ?? loadRepositoryTaskSummary;
  const [loadedData, setLoadedData] = useState<HomeDashboardData>(() => emptyHomeData());
  const [loadedTaskSummary, setLoadedTaskSummary] = useState<HomeTaskSummary>(() =>
    emptyTaskSummary(localDate),
  );
  const [loading, setLoading] = useState(controlledItems === undefined);
  const [tasksLoading, setTasksLoading] = useState(shouldLoadTasks);
  const [itemsRefreshing, setItemsRefreshing] = useState(false);
  const [tasksRefreshing, setTasksRefreshing] = useState(false);
  const taskOperation = useOperation();
  useEditProtection({ dirty: false, busy: () => taskOperation.pending.current });
  const [error, setError] = useState<string | null>(null);
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  const [taskError, setTaskError] = useState<string | null>(null);
  // A success is spoken by the hidden status line: the stamp, coin and counts already show
  // it. An unconfirmed reward stays a visible warning. The sequence re-announces identical
  // text and re-mounts an identical warning.
  const [taskStatus, setTaskStatus] = useState<{ text: string; seq: number } | null>(null);
  const [taskWarning, setTaskWarning] = useState<{ text: string; seq: number } | null>(null);
  const taskStatusSeq = useRef(0);
  // A committed creation grant waits for the refreshed list, so its coin starts at the row.
  const [creationMoment, setCreationMoment] = useState<{
    celebration: TaskCelebration;
    afterRead: number;
    tasksAtSave: HomeTaskSummary;
  } | null>(null);
  const [settledRead, setSettledRead] = useState(0);
  const taskReadSequence = useRef(0);
  const [taskAttempt, setTaskAttempt] = useState(0);
  const savedSinceRead = useRef(false);
  const [allowanceState, setAllowanceState] = useState<AllowanceState>(
    () => controlledAllowance ?? DEFAULT_ALLOWANCE,
  );
  const itemsLoadedRef = useRef(controlledItems !== undefined);
  // The loading state is for the first attempt only. A failed first read must not replace the page
  // again on every later try, and each minute's tick is one: the card's fields live on that page.
  const itemsSettledRef = useRef(controlledItems !== undefined);
  const tasksLoadedRef = useRef(!shouldLoadTasks);
  const reducedMotion = useReducedMotion();
  const taskCelebration = useTaskCelebration();
  // Finishing from the card, the stamp and coin play on the card first. The full figure is not on
  // the page until the layout changes back, so its reaction starts then, on its own clock.
  const reactionAfterCard = useTaskCelebration();
  const [cardMoment, setCardMoment] = useState<{
    celebration: TaskCelebration;
    ordinal: number;
  } | null>(null);
  const cardMomentShowing =
    cardMoment !== null && taskCelebration.current?.id === cardMoment.celebration.id;
  // 撤销 during that moment brings the card back, but the list has not been read yet.
  const [undoneCard, setUndoneCard] = useState<{
    row: TaskOccurrence;
    afterRead: number;
    tasksAtSave: HomeTaskSummary;
  } | null>(null);
  const lastNoteSave = useRef<{ task: DailyTask; readsStarted: number } | null>(null);
  const workingCard = useWorkingCard();
  // The reaction and all-done poses are decoded first, so a celebration never flashes.
  const successPortraitReady = useCompanionArtPreload(
    [reactionPose(0), reactionPose(1), reactionPose(2), allDonePose(localDate)],
    localDate,
  );

  useEffect(() => {
    if (controlledItems !== undefined) return;
    let active = true;
    const initialLoad = !itemsSettledRef.current;
    if (initialLoad) setLoading(true);
    else setItemsRefreshing(true);
    const pending = loadItems
      ? loadItems().then((items) => homeDataFromItems(items, now))
      : loadHomeData(now);
    void pending
      .then((data) => {
        if (active) {
          setLoadedData(data);
          itemsLoadedRef.current = true;
          // Cleared here, not when the read starts: the notice would blink out and back each try.
          setError(null);
        }
      })
      .catch((caught) => {
        if (active) setError(displayError(caught, '首页摘要无法加载。'));
      })
      .finally(() => {
        if (active) {
          itemsSettledRef.current = true;
          setLoading(false);
          setItemsRefreshing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [controlledItems, loadHomeData, loadItems, now, revision, summaryAttempt]);

  useEffect(() => {
    if (!shouldLoadTasks) {
      setTasksLoading(false);
      tasksLoadedRef.current = true;
      return;
    }
    let active = true;
    const request = ++taskReadSequence.current;
    const initialLoad = !tasksLoadedRef.current;
    if (initialLoad) setTasksLoading(true);
    else setTasksRefreshing(true);
    setTaskError(null);
    void taskSummaryLoader(localDate)
      .then((summary) => {
        if (active && request === taskReadSequence.current) {
          // A read that began before a note was saved must not put the old note back.
          const saved = lastNoteSave.current;
          setLoadedTaskSummary(
            saved && request <= saved.readsStarted ? withSavedTask(summary, saved.task) : summary,
          );
          savedSinceRead.current = false;
          tasksLoadedRef.current = true;
        }
      })
      .catch((caught) => {
        if (active && request === taskReadSequence.current)
          setTaskError(
            savedSinceRead.current
              ? '列表没刷新，请重新加载。'
              : displayError(caught, '待办无法加载。'),
          );
      })
      .finally(() => {
        if (active && request === taskReadSequence.current) {
          setTasksLoading(false);
          setTasksRefreshing(false);
          setSettledRead(request);
        }
      });
    return () => {
      active = false;
      taskReadSequence.current += 1;
    };
  }, [controlledTaskSummary, localDate, revision, shouldLoadTasks, taskSummaryLoader, taskAttempt]);

  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTaskAttempt((value) => value + 1), 100);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  useEffect(() => {
    if (controlledAllowance !== undefined) {
      setAllowanceState(controlledAllowance);
      return;
    }
    if (allowanceLoader === loadAllowance && !hasExtensionRuntime()) return;
    let active = true;
    void allowanceLoader()
      .then((loaded) => {
        if (active) setAllowanceState(loaded);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [allowanceLoader, controlledAllowance, revision, taskAttempt]);

  function refreshTasksAfterSave() {
    savedSinceRead.current = true;
    onTasksChanged();
    setTaskAttempt((value) => value + 1);
  }

  function announceTask(text: string) {
    setTaskStatus({ text, seq: ++taskStatusSeq.current });
  }

  function taskCreated(task: DailyTask, reward: TaskAllowanceResult | null) {
    if (reward && controlledAllowance === undefined) setAllowanceState(reward.state);
    setTaskWarning(null);
    announceTask(taskCreationMessage(reward?.reward ?? 0));
    const celebration = taskCreationCelebrationFor({
      taskId: task.id,
      localDate: localDateKey(clock()),
      reward,
    });
    // Any task read that settles after this point was started after the save.
    setCreationMoment(
      celebration ? { celebration, afterRead: taskReadSequence.current, tasksAtSave: tasks } : null,
    );
    refreshTasksAfterSave();
  }

  /**
   * A note is part of the task, but saving one is not an action on it: no lock, no reward and no
   * refresh that would disable the row. The saved task replaces the row in place, so nothing on
   * the page flashes and an edit form opened next compares against what is really stored. It is
   * drawn before this returns, so an action waiting on the save continues from the new list.
   */
  async function saveTaskNotes(taskId: string, notes: string | null) {
    const saved = await taskPlanPort.updateTask(taskId, { notes });
    lastNoteSave.current = { task: saved, readsStarted: taskReadSequence.current };
    flushSync(() => setLoadedTaskSummary((summary) => withSavedTask(summary, saved)));
    return saved;
  }

  /** Skip, move and drop share completion's lock, refresh and error path, and move no money. */
  async function changeTaskPlan<T>(
    /** The recurring occurrence's date: acting on it after midnight would be stale. */
    recurringDate: string | null,
    change: () => Promise<T>,
    message: string,
  ): Promise<T | null> {
    if (taskOperation.pending.current) return null;
    if (recurringDate !== null && recurringDate !== localDateKey(clock())) {
      setTaskError('任务日期已变化，请刷新后再操作。');
      setTaskAttempt((value) => value + 1);
      return null;
    }
    if (!taskOperation.begin()) return null;
    setTaskError(null);
    setTaskWarning(null);
    try {
      const result = await change();
      announceTask(message);
      refreshTasksAfterSave();
      return result;
    } catch (caught) {
      setTaskError(displayError(caught, '待办无法更改。'));
      return null;
    } finally {
      taskOperation.finish();
    }
  }

  const applyPlan = (row: TaskOccurrence, action: TaskPlanAction) =>
    changeTaskPlan(
      row.task.recurrence === 'specific_date' ? null : row.localDate,
      () => applyTaskPlan(taskPlanPort, row, action, clock()),
      `${TASK_PLAN_DONE[action]}。`,
    );
  const undoPlan = async (receipt: TaskPlanReceipt) =>
    (await changeTaskPlan(
      receipt.action === 'skip-today' ? receipt.localDate : null,
      async () => {
        await undoTaskPlan(taskPlanPort, receipt, clock());
        return true;
      },
      '已撤销。',
    )) === true;
  const restorePlan = async (row: TaskOccurrence) =>
    (await changeTaskPlan(
      row.localDate,
      async () => {
        await taskPlanPort.changeTaskSkipAtomic(
          'restore-task',
          row.task.id,
          row.localDate,
          clock(),
        );
        return true;
      },
      '已恢复今天的待办。',
    )) === true;

  async function toggleTask(occurrence: TaskOccurrence) {
    if (taskOperation.pending.current) return false;
    if (
      !occurrence.completion &&
      (occurrence.localDate > localDateKey(clock()) ||
        (occurrence.task.recurrence !== 'specific_date' &&
          occurrence.localDate !== localDateKey(clock())))
    ) {
      setTaskError('任务日期已变化，请刷新后再操作。');
      setTaskAttempt((value) => value + 1);
      return false;
    }
    if (!taskOperation.begin()) return false;
    setTaskError(null);
    setTaskWarning(null);
    const completing = !occurrence.completion;
    const today = localDateKey(clock());
    const current = tasks.overview ?? overviewFromTaskSummary(tasks);
    const openToday = current.today.length + current.overdue.length;
    // The reaction pose cycles with today's completions; fixed here, before the commit.
    const completedBefore = current.completed.length;
    try {
      const result = await changeTaskCompletion(
        taskActions,
        occurrence.task.id,
        occurrence.localDate,
        completing,
        clock(),
      );
      if (result.reward && controlledAllowance === undefined)
        setAllowanceState(result.reward.state);
      // Only a completion this call committed celebrates; undo reports its reversal plainly.
      const celebration = taskCelebrationFor({
        completing,
        result,
        taskId: occurrence.task.id,
        localDate: occurrence.localDate,
        today,
        remainingToday: occurrence.localDate <= today ? Math.max(0, openToday - 1) : null,
        fallbackId: crypto.randomUUID(),
      });
      // Exactly one announcement per result: a visible warning, or the hidden status line.
      if (result.warning) setTaskWarning({ text: result.warning, seq: ++taskStatusSeq.current });
      else announceTask(taskChangeMessage({ completing, result, celebration }));
      if (celebration) {
        // Under reduced motion nothing plays on the card, so the layout changes back at once.
        const fromCard =
          !reducedMotion &&
          !document.hidden &&
          workingRow?.task.id === occurrence.task.id &&
          workingRow.localDate === occurrence.localDate;
        if (fromCard) setCardMoment({ celebration, ordinal: completedBefore });
        taskCelebration.celebrate(
          celebration,
          fromCard ? { companion: false } : { ordinal: completedBefore },
        );
      } else if (!completing && result.changed) {
        if (
          cardMoment?.celebration.taskId === occurrence.task.id &&
          cardMoment.celebration.localDate === occurrence.localDate
        )
          setUndoneCard({
            row: { ...occurrence, completion: null },
            afterRead: taskReadSequence.current,
            tasksAtSave: tasks,
          });
        setCardMoment((moment) =>
          moment?.celebration.taskId === occurrence.task.id &&
          moment.celebration.localDate === occurrence.localDate
            ? null
            : moment,
        );
        taskCelebration.dismiss(occurrence.task.id, occurrence.localDate);
        reactionAfterCard.dismiss(occurrence.task.id, occurrence.localDate);
      }
      refreshTasksAfterSave();
      return true;
    } catch (caught) {
      setTaskError(displayError(caught, '待办完成状态无法更改。'));
      return false;
    } finally {
      taskOperation.finish();
    }
  }

  const data = controlledItems ? homeDataFromItems(controlledItems, now) : loadedData;
  const tasks = controlledTaskSummary ?? loadedTaskSummary;

  // Fires once the refreshed list contains the new row (its coin starts there), or once the
  // read after the save settled without it or failed (then from the 添加待办 button).
  useEffect(() => {
    if (!creationMoment) return;
    const { celebration, afterRead, tasksAtSave } = creationMoment;
    const overview = tasks.overview ?? overviewFromTaskSummary(tasks);
    const arrived = [...overview.today, ...overview.overdue, ...overview.upcoming].some(
      (row) => row.task.id === celebration.taskId,
    );
    // Without a task reader there is nothing to wait for unless the parent supplies the list.
    const settled = shouldLoadTasks
      ? settledRead > afterRead
      : controlledTaskSummary === undefined || tasks !== tasksAtSave;
    if (!arrived && !settled) return;
    setCreationMoment(null);
    taskCelebration.celebrate(celebration, { companion: false });
  }, [
    controlledTaskSummary,
    creationMoment,
    settledRead,
    shouldLoadTasks,
    taskCelebration.celebrate,
    tasks,
  ]);
  useEffect(() => {
    if (!undoneCard) return;
    const settled = shouldLoadTasks
      ? settledRead > undoneCard.afterRead
      : controlledTaskSummary === undefined || tasks !== undoneCard.tasksAtSave;
    if (settled) setUndoneCard(null);
  }, [controlledTaskSummary, settledRead, shouldLoadTasks, tasks, undoneCard]);
  const companionReaction = taskCelebration.reaction ?? reactionAfterCard.reaction;
  // Finished today's todos with nothing left to review: the companion rests in the peace sign.
  const allDoneToday = data.dueCount === 0 && tasks.remaining === 0 && tasks.completed > 0;
  const companionState =
    (companionReaction || allDoneToday) && successPortraitReady
      ? 'success'
      : data.dueCount > 0 || tasks.remaining > 0
        ? 'due'
        : 'idle';
  const companionAllDone = allDoneToday && !companionReaction;
  const taskOverview = tasks.overview ?? overviewFromTaskSummary(tasks);
  const resolvedRow = workingCard.ready ? resolveWorkingRow(workingCard.state, taskOverview) : null;
  // Until the read lands the undone card stands in for its row, or the page would flip out and back.
  const cardRow =
    resolvedRow ??
    (undoneCard && workingCard.state.current?.taskId === undoneCard.row.task.id
      ? undoneCard.row
      : null);
  // A finished card keeps the working layout until its moment is over, so the page moves once. The
  // stamped card ends with the celebration, so that is held back along with the layout.
  const { shown: workingDisplay, flipping: layoutFlipping } = useWorkingLayoutTransition(
    {
      layout: cardRow !== null || cardMomentShowing,
      rowKey: cardRow ? `${cardRow.task.id}:${cardRow.localDate}` : null,
      row: cardRow,
      celebration: taskCelebration.current,
    },
    {
      settled: workingCard.ready && !loading && !tasksLoading && tasksLoadedRef.current,
      reducedMotion,
    },
  );
  const workingRow = workingDisplay.row;
  const workingLayout = workingDisplay.layout;
  // Waits for the layout: the reaction's clock starts when the full figure is back on the page.
  useLayoutEffect(() => {
    if (!cardMoment || cardMomentShowing || layoutFlipping) return;
    setCardMoment(null);
    // A newer completion took its place and already has its reaction. This one would start later
    // and outlast it, and show for a moment after it.
    if (!taskCelebration.reaction)
      reactionAfterCard.celebrate(cardMoment.celebration, { ordinal: cardMoment.ordinal });
  }, [
    cardMoment,
    cardMomentShowing,
    layoutFlipping,
    reactionAfterCard.celebrate,
    taskCelebration.reaction,
  ]);
  const companionPose = homePose({
    mood: companionState,
    hour: now.getHours(),
    dateKey: localDate,
    reviewsDue: data.dueCount > 0,
    allDone: companionAllDone && companionState === 'success',
    reactionOrdinal:
      companionReaction && companionState === 'success' ? companionReaction.ordinal : null,
  });
  // The strip's head and the pose the full figure comes back to: neither may arrive as a pop-in.
  useCompanionArtPreload(
    workingLayout
      ? [
          WORKING_HEAD_POSE,
          homePose({
            mood: data.dueCount > 0 || tasks.remaining > 0 ? 'due' : 'idle',
            hour: now.getHours(),
            dateKey: localDate,
            reviewsDue: data.dueCount > 0,
            allDone: false,
            reactionOrdinal: null,
          }),
        ]
      : [WORKING_HEAD_POSE],
    localDate,
  );
  const initialLoading = loading;
  const refreshing = itemsRefreshing || tasksRefreshing;
  // A fast refresh after a save never flashes; a slow one still shows.
  const refreshVisible = useDelayedFlag(!initialLoading && refreshing);
  const summaryAvailable = controlledItems !== undefined || itemsLoadedRef.current;
  const reviewIsPrimary = summaryAvailable && data.dueCount > 0;
  const addIsPrimary = summaryAvailable && !error && data.dueCount === 0;
  const retrySummary = () => setSummaryAttempt((attempt) => attempt + 1);
  const summaryDescription = !summaryAvailable
    ? '请重试。'
    : error
      ? reviewIsPrimary
        ? undefined
        : '摘要没更新，请重试。'
      : undefined;

  return (
    <section
      className="home-view stack"
      aria-labelledby="home-heading"
      aria-busy={initialLoading || refreshing}
      data-initial-entry={initialEntry}
      data-reduced-motion={reducedMotion}
    >
      <div className="home-entry-region home-editorial-heading">
        <div className="home-editorial-copy">
          <p className="home-edition">
            <time dateTime={localDate}>{localDate.replaceAll('-', ' / ')}</time>
          </p>
          {/* Not shown, but still the page's name and where keyboard focus lands on arrival. */}
          <h2 className="dashboard-page-heading sr-only" id="home-heading" tabIndex={-1}>
            今天的学习
          </h2>
        </div>
        {/* A fixed slot: refreshing after a save never pushes the page down. */}
        <div className="home-refresh-slot">
          {refreshVisible && (
            <div className="dashboard-refresh-status" role="status">
              <span className="motion-loading-indicator" aria-hidden="true" />
              <span>正在刷新今天的摘要</span>
            </div>
          )}
        </div>
      </div>
      {/* Held with the layout: a coin measures its start and its wallet on the page it flies over. */}
      <TaskCoinLayer celebration={workingDisplay.celebration} reducedMotion={reducedMotion} />

      {__VALRECALL_PUBLIC_RELEASE__ && FirstRunCard && freshInstall === true && !error ? (
        <Suspense fallback={null}>
          <FirstRunCard />
        </Suspense>
      ) : (
        error && (
          <div className="motion-state-change" key={error}>
            <Notice tone="error">{error}</Notice>
            {reviewIsPrimary && (
              <div className="cluster">
                <button className="button secondary small-button" onClick={retrySummary}>
                  重试首页摘要
                </button>
              </div>
            )}
          </div>
        )
      )}
      {initialLoading ? (
        <section className="card dashboard-loading-state home-loading-state" role="status">
          <span className="motion-loading-indicator" aria-hidden="true" />
          <span>正在加载首页摘要…</span>
        </section>
      ) : (
        <>
          <div
            className="home-layout"
            data-home-composition="companion-first"
            data-working={workingLayout || undefined}
          >
            {workingLayout && (
              <HomeReviewStrip
                dueCount={data.dueCount}
                available={summaryAvailable}
                action={reviewIsPrimary ? 'review' : addIsPrimary ? 'add' : 'retry'}
                showHead={!error && !taskError}
                dateKey={localDate}
                streak={allowanceState.currentStreak}
                balance={allowanceState.balance}
                onStartReview={onStartReview}
                onAddQuestion={onAddQuestion}
                onRetry={retrySummary}
                onOpenAllowance={onOpenAllowance}
              />
            )}
            <div className="home-workspaces">
              {!workingLayout && (
                <div className="home-learning-workspace">
                  <section className="home-today" aria-label="今天学习">
                    {!error && !taskError && (
                      <div
                        className="home-companion-stage home-entry-region"
                        data-home-region="companion"
                        data-home-stage-state={companionState}
                      >
                        <Companion
                          state={companionState}
                          count={data.dueCount}
                          taskCount={tasks.remaining}
                          placement="home"
                          pose={companionPose}
                          dateKey={localDate}
                          allDone={companionAllDone}
                          {...(companionReaction
                            ? { message: companionReaction.praise }
                            : __VALRECALL_PUBLIC_RELEASE__ &&
                                freshInstall !== false &&
                                !companionAllDone
                              ? {
                                  message:
                                    freshInstall === null
                                      ? null
                                      : freshCompanionMessage(tasks.remaining),
                                }
                              : companionAllDone
                                ? { message: buildCompanionHomeMessage(0, 0) }
                                : {})}
                        />
                      </div>
                    )}
                    <section
                      className="home-summary-card home-entry-region"
                      aria-label="今日摘要"
                      data-home-region="content"
                    >
                      <div className="home-summary-primary">
                        <h3 className="home-workspace-title">今日复习</h3>
                        <div className="home-study-focus">
                          {summaryAvailable ? (
                            <p className="home-due-count">
                              <MotionCount value={data.dueCount} as="strong" />
                              <span>条到期</span>
                            </p>
                          ) : (
                            <h3>摘要没加载出来</h3>
                          )}
                          {summaryDescription && (
                            <p className="muted home-summary-description">{summaryDescription}</p>
                          )}
                        </div>
                        <div className="home-review-actions">
                          <button
                            className="button primary-action home-start-action"
                            onClick={
                              reviewIsPrimary
                                ? onStartReview
                                : addIsPrimary
                                  ? onAddQuestion
                                  : retrySummary
                            }
                          >
                            <ActionIcon kind={reviewIsPrimary ? 'play' : 'plus'} />
                            {reviewIsPrimary
                              ? '开始复习'
                              : addIsPrimary
                                ? '添加回忆题'
                                : '重试首页摘要'}
                          </button>
                          {!addIsPrimary && (
                            <button className="button text-button" onClick={onAddQuestion}>
                              添加回忆题
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="home-summary-aside">
                        <div className="home-completed-stat">
                          {summaryAvailable ? (
                            <MotionCount value={data.reviewsCompletedToday} as="strong" />
                          ) : (
                            <strong aria-label="暂不可用">—</strong>
                          )}
                          <span>今天已复习</span>
                        </div>
                        <p className="home-streak-stat" data-allowance-stat="streak">
                          <MotionCount value={allowanceState.currentStreak} as="strong" />
                          <span>连续天数</span>
                        </p>
                        <button
                          className="home-allowance-balance"
                          type="button"
                          data-allowance-stat="balance"
                          onClick={onOpenAllowance}
                        >
                          <span className="home-wallet-target" data-wallet-target="home">
                            <MotionCount value={allowanceState.balance} as="strong" />
                          </span>
                          <span>零花钱</span>
                        </button>
                      </div>
                    </section>
                  </section>

                  <div className="home-recent-region home-entry-region">
                    {summaryAvailable ? (
                      <HomeList
                        title="最近保存"
                        empty="还没有保存过回忆题。"
                        items={data.recentCaptures}
                        onViewItem={onViewItem}
                        dateFor={(item) => item.createdAt}
                        labelFor={(item) => `保存于 ${formatDateTime(item.createdAt)}`}
                      />
                    ) : (
                      <section className="card home-list-card">
                        <h3>最近保存</h3>
                        <p className="muted">没加载出来。</p>
                      </section>
                    )}
                  </div>
                </div>
              )}
              <div className="home-tasks-rail">
                <HomeTasks
                  overview={taskOverview}
                  unavailable={!tasksLoadedRef.current}
                  loading={tasksLoading}
                  feedback={
                    <>
                      <LiveStatus text={taskStatus?.text ?? null} seq={taskStatus?.seq ?? 0} />
                      {taskError && (
                        <div className="motion-state-change" key={taskError}>
                          <Notice tone="error" leading={worriedCompanionLeading(localDate)}>
                            {taskError}{' '}
                            <button
                              className="button text-button"
                              disabled={tasksRefreshing}
                              onClick={() => setTaskAttempt((value) => value + 1)}
                            >
                              重新加载待办
                            </button>
                          </Notice>
                        </div>
                      )}
                      {taskWarning && (
                        <Notice key={taskWarning.seq} tone="warning">
                          {taskWarning.text}
                        </Notice>
                      )}
                    </>
                  }
                  readBlocked={Boolean(taskError)}
                  busy={taskOperation.busy || tasksRefreshing}
                  writer={taskWriter}
                  celebration={workingDisplay.celebration}
                  balance={allowanceState.balance}
                  onToggle={toggleTask}
                  onCreated={taskCreated}
                  onEdit={onEditTask}
                  onManage={onOpenTasks}
                  working={
                    workingCard.ready && workingCard.state.enabled
                      ? {
                          row: workingRow,
                          note: workingRow
                            ? workingNoteFor(workingCard.state, workingRow, localDate)
                            : '',
                          plan: workingRow
                            ? workingPlanFor(workingCard.state, workingRow, localDate)
                            : EMPTY_WORKING_PLAN,
                          onStart: (row) =>
                            workingCard.update((state) =>
                              startWork(
                                state,
                                row.task.id,
                                localDateKey(clock()),
                                countOpenOneOffs(taskOverview),
                              ),
                            ),
                          onPutDown: () =>
                            workingCard.update((state) =>
                              putDownWork(state, localDateKey(clock())),
                            ),
                          onSaveNote: (row, text) =>
                            workingCard.update((state) =>
                              saveWorkingNote(state, row.task.id, text, localDateKey(clock())),
                            ),
                          onSavePlan: (row, plan) =>
                            workingCard.update((state) =>
                              saveWorkingPlan(state, row.task.id, plan, localDateKey(clock())),
                            ),
                          onSaveTaskNotes: saveTaskNotes,
                        }
                      : undefined
                  }
                  plan={{ onApply: applyPlan, onUndo: undoPlan, onRestore: restorePlan }}
                  layoutFlipping={layoutFlipping}
                />
              </div>
            </div>
            {!workingLayout && (
              <div className="home-support-grid">
                <HomeStatistics revision={revision} onOpen={onOpenStatistics} clock={clock} />
                {summaryAvailable && (
                  <UpcomingReviewsCard
                    data={data}
                    now={now}
                    remindersEnabled={preferences.nextDueReminderEnabled}
                    onViewFullSchedule={onViewUpcoming}
                    onOpenReminderSettings={onOpenReminderSettings}
                  />
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function HomeList({
  title,
  empty,
  items,
  dateFor,
  labelFor,
  onViewItem,
}: {
  title: string;
  empty: string;
  items: readonly LearningItem[];
  dateFor: (item: LearningItem) => Date;
  labelFor: (item: LearningItem) => string;
  onViewItem: (item: LearningItem) => void;
}) {
  return (
    <section className="card home-list-card">
      <div className="split">
        <h3>{title}</h3>
        <span className="pill" aria-live="polite">
          <MotionCount value={items.length} />
        </span>
      </div>
      <div
        className="home-section-state motion-state-change"
        key={items.length === 0 ? 'empty' : 'populated'}
      >
        {items.length === 0 ? (
          <p className="muted small">{empty}</p>
        ) : (
          <ol className="home-list">
            {items.map((item) => {
              const date = dateFor(item);
              return (
                <li className="home-list-item" key={item.id}>
                  {item.sourceType !== 'text' && (
                    <button
                      className="home-recent-image-button"
                      onClick={() => onViewItem(item)}
                      aria-label={`查看 ${learningItemTitle(item)}`}
                    >
                      <ItemThumbnail
                        screenshotId={
                          item.sourceType === 'image' ? item.imageAssetId : item.screenshotId
                        }
                        alt={learningItemTitle(item)}
                        className="home-recent-thumbnail"
                        hideWhenMissing
                      />
                    </button>
                  )}
                  <div className="home-recent-copy">
                    <button className="content-title-button" onClick={() => onViewItem(item)}>
                      {learningItemTitle(item)}
                    </button>
                    {item.coreLesson.trim() && (
                      <p className="home-recent-excerpt">{item.coreLesson}</p>
                    )}
                    <span className="muted small">
                      {learningGoalLabel(item.itemType)}
                      {item.sourceType === 'text'
                        ? ' · 文字'
                        : item.sourceType === 'image'
                          ? ' · 图片'
                          : item.timestampDisplay
                            ? ` · ${item.timestampDisplay}`
                            : ' · 视频'}
                    </span>
                  </div>
                  <time className="muted small" dateTime={date.toISOString()}>
                    {labelFor(item)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}

/** Swaps in a task just saved here; anything the list has that is newer stays. */
function withSavedTask(summary: HomeTaskSummary, saved: DailyTask): HomeTaskSummary {
  const swap = (rows: TaskOccurrence[]) =>
    rows.map((row) =>
      row.task.id === saved.id && row.task.updatedAt <= saved.updatedAt
        ? { ...row, task: saved }
        : row,
    );
  const { overview } = summary;
  return {
    ...summary,
    occurrences: swap(summary.occurrences),
    ...(overview
      ? {
          overview: {
            ...overview,
            today: swap(overview.today),
            overdue: swap(overview.overdue),
            upcoming: swap(overview.upcoming),
            completed: swap(overview.completed),
            ...(overview.skipped ? { skipped: swap(overview.skipped) } : {}),
          },
        }
      : {}),
  };
}

function emptyTaskSummary(localDate: string): TaskDaySummary {
  return { localDate, total: 0, completed: 0, remaining: 0, occurrences: [] };
}

function emptyHomeData(): HomeDashboardData {
  return {
    dueCount: 0,
    reviewsCompletedToday: 0,
    recentCaptures: [],
    upcoming: {
      items: [],
      nextCursor: null,
      hasMore: false,
      invalidCount: 0,
    },
    next24HourTotal: 0,
  };
}

function homeDataFromItems(items: readonly LearningItem[], now: Date): HomeDashboardData {
  const summary = buildDashboardHomeSummary(items, now);
  const future = items
    .filter(
      (item) =>
        !item.suspended &&
        Number.isFinite(item.fsrsCard.due.getTime()) &&
        item.fsrsCard.due.getTime() > now.getTime(),
    )
    .sort(
      (left, right) =>
        left.fsrsCard.due.getTime() - right.fsrsCard.due.getTime() ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
  const bounded = future.slice(0, 60);
  const last = bounded.at(-1);
  const hasMore = future.length > bounded.length;
  const next24Hours = now.getTime() + 24 * 60 * 60 * 1000;
  return {
    dueCount: summary.dueCount,
    reviewsCompletedToday: summary.reviewsCompletedToday,
    recentCaptures: summary.recentCaptures,
    upcoming: {
      items: bounded,
      nextCursor:
        hasMore && last ? { due: last.fsrsCard.due.toISOString(), itemId: last.id } : null,
      hasMore,
      invalidCount: items.filter((item) => !Number.isFinite(item.fsrsCard.due.getTime())).length,
    },
    next24HourTotal: future.filter((item) => item.fsrsCard.due.getTime() < next24Hours).length,
  };
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function taskSummaryFromOverview(overview: HomeTaskOverview): HomeTaskSummary {
  const remaining = overview.overdue.length + overview.today.length;
  return {
    localDate: overview.localDate,
    remaining,
    completed: overview.completed.length,
    total: remaining + overview.completed.length,
    occurrences: [...overview.overdue, ...overview.today, ...overview.completed],
    overview,
  };
}

function overviewFromTaskSummary(summary: TaskDaySummary): HomeTaskOverview {
  return {
    localDate: summary.localDate,
    overdue: summary.occurrences.filter(
      (row) => !row.completion && row.localDate < summary.localDate,
    ),
    today: summary.occurrences.filter(
      (row) => !row.completion && row.localDate === summary.localDate,
    ),
    upcoming: summary.occurrences.filter(
      (row) => !row.completion && row.localDate > summary.localDate,
    ),
    completed: summary.occurrences.filter((row) => row.completion !== null),
  };
}
