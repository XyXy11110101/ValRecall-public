import { DraftRepository } from '../database/drafts';
import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import { LiveStatus } from '../shared/components';
import { useDelayedFlag } from '../shared/use-delayed-flag';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MobileRepository,
  mobileAvailableBalance,
  mobileVisibleTasks,
  type MobileOutboxEntry,
  type MobileState,
} from '../database/mobile-repository';
import { type TaskPriority, type TaskRecurrence } from '../models/daily-task';
import { TaskList } from './TaskList';
import { TaskProgress } from './TaskProgress';
import { TaskHistory } from './TaskHistory';
import { taskProgress } from './task-progress';
import {
  completionEstimate,
  confirmationMessage,
  confirmedCompletions,
  confirmedFromReceipts,
  creationEstimate,
  groupMobileTasks,
  pendingEstimate,
  pendingReversal,
  type ConfirmedCompletion,
  type MobileTaskRow,
} from './task-presentation';
export { pendingEstimate } from './task-presentation';
import { dateInTimeZone, isRecord } from '../sync/protocol';
import { useMobileWidget } from './use-mobile-widget';
import { MobileAutoSync, type AutoSyncResult, type AutoSyncMode } from './auto-sync';
import { nativeRequest } from './bridge';
import { SyncClient, MobileSyncError } from './sync-client';
import {
  useMobileNavigation,
  isSubpage,
  isFormPage,
  pageTab,
  type MobileTab,
  type MobilePage,
} from './navigation';
import { MobileIcon } from './MobileIcon';
import { MOBILE_WALLET_TAB_ID, useMobileMotion } from './useMobileMotion';
import { MobileCompanion, type MobileCompanionCompletion } from './MobileCompanion';

/** How long the floating completion line stays; it never moves page content. */
const CELEBRATION_STATUS_MS = 2400;

type Feedback = { notice?: string; error?: string; form?: 'add-task' | 'spend' };
const pageNames: Record<MobilePage, string> = {
  tasks: '待办',
  wallet: '零花钱',
  settings: '设置',
  'add-task': '添加任务',
  spend: '记一笔扣款',
  'task-history': '完成历史',
};

export interface MobileAppServices {
  draftRepository?: DraftRepository;
  repository: Pick<
    MobileRepository,
    | 'load'
    | 'createTask'
    | 'enqueueCompletion'
    | 'enqueueTaskAction'
    | 'enqueueSpend'
    | 'cancelNeverSent'
    | 'acceptNewEpoch'
  > &
    Partial<Pick<MobileRepository, 'open'>>;
  client: Pick<SyncClient, 'sync'> & Partial<Pick<SyncClient, 'checkForChanges' | 'changeProbe'>>;
  native: typeof nativeRequest;
}

export interface MobileAppProps {
  services?: MobileAppServices;
  clock?: () => Date;
  confirmAction?: (message: string) => boolean;
}

let singleton: MobileAppServices | undefined;
function defaultServices(): MobileAppServices {
  if (!singleton) {
    const repository = new MobileRepository();
    singleton = { repository, client: new SyncClient(repository), native: nativeRequest };
  }
  return singleton;
}
const currentTime = () => new Date();
const confirmUser = (message: string) => window.confirm(message);
const weekdays = [
  [1, '一'],
  [2, '二'],
  [3, '三'],
  [4, '四'],
  [5, '五'],
  [6, '六'],
  [0, '日'],
] as const;

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function operationTitle(entry: MobileOutboxEntry, state: MobileState): string {
  if (entry.operation.kind === 'create-task') return entry.operation.task.title;
  if (entry.operation.kind === 'spend-allowance')
    return `${entry.operation.amount} 元${entry.operation.note ? ` · ${entry.operation.note}` : ''}`;
  const taskId = entry.operation.taskId;
  const localCreate = state.outbox.find(
    (row) =>
      row.epoch === entry.epoch &&
      row.operation.kind === 'create-task' &&
      row.operation.task.id === taskId,
  );
  if (localCreate?.operation.kind === 'create-task') return localCreate.operation.task.title;
  return (
    mobileVisibleTasks(state).find(({ task }) => task.id === taskId)?.task.title ??
    state.archives
      .flatMap((archive) => archive.snapshot.tasks)
      .find(({ task }) => task.id === taskId)?.task.title ??
    taskId
  );
}

function savedAt(state: MobileState, checkedAt?: Date | null): string {
  if (!state.snapshot) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: state.snapshot.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(checkedAt ?? new Date(state.snapshot.generatedAt));
}

export function MobileApp({
  services: injected,
  clock = currentTime,
  confirmAction = confirmUser,
}: MobileAppProps) {
  const [services] = useState(() => injected ?? defaultServices());
  const navigation = useMobileNavigation();
  const { page } = navigation;
  const motion = useMobileMotion(page);
  const [state, setState] = useState<MobileState | null>(null);
  // The sequence restarts the timer and re-announces a line identical to the previous one.
  const [celebrationStatus, setCelebrationStatus] = useState<{ text: string; seq: number } | null>(
    null,
  );
  const celebrationSeq = useRef(0);
  const announceCelebration = (text: string) =>
    setCelebrationStatus({ text, seq: ++celebrationSeq.current });
  // The latest saved completion, for the private companion's cheer (unused in public builds).
  const [companionCompletion, setCompanionCompletion] = useState<MobileCompanionCompletion | null>(
    null,
  );
  const companionSeq = useRef(0);
  const confirmedFrom = useRef<MobileState | null>(null);
  // Each computer confirmation is spoken once, whichever path reports it first: the sync
  // summary's applied receipts, or the stored-state comparison.
  const announcedConfirmations = useRef(new Set<string>());
  const announceConfirmed = useRef<(rows: readonly ConfirmedCompletion[]) => boolean>(() => false);
  /** How many confirmation lines were spoken; a requested sync that spoke one says no more. */
  const confirmationsSpoken = useRef(0);
  // The result of a sync the person asked for, spoken once by a hidden status line; the
  // summary shows it. Automatic syncs stay silent.
  const [syncOutcome, setSyncOutcome] = useState<{
    text: string;
    succeeded: boolean;
    spokenBefore: number;
    seq: number;
  } | null>(null);
  const [syncStatus, setSyncStatus] = useState<{ text: string; seq: number } | null>(null);
  const syncStatusSeq = useRef(0);
  // A task saved on the phone is announced, with its estimate coin, once back on #tasks.
  const [creationCue, setCreationCue] = useState<{
    entryId: string;
    rowId: string;
    amount: number;
  } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [messages, setMessages] = useState<Partial<Record<MobileTab, Feedback>>>({});
  const [historyLimit, setHistoryLimit] = useState(30);
  const historyFocus = useRef<string | null>(null);
  const futureList = useRef<HTMLDetailsElement>(null);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  // Only a sync the person asked for shows 正在同步; automatic ones keep the summary still.
  const [visibleSync, setVisibleSync] = useState(false);
  const manualRequest = useRef(false);
  /** The running sync was asked for (or adopted by a click), so its result is spoken. */
  const visibleRun = useRef(false);
  const [syncMessage, setSyncMessage] = useState('');
  const [syncNeedsAction, setSyncNeedsAction] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [mutating, setMutating] = useState(false);
  // An automatic sync is unseen, yet pairing and cancelling wait for it: a slow one explains
  // why, a fast one never flashes a hint.
  const backgroundSync = useDelayedFlag((syncing || checking) && !visibleSync);
  const [pairing, setPairing] = useState(false);
  const [epochChange, setEpochChange] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState(clock);
  const [qr, setQr] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [recurrence, setRecurrence] = useState<TaskRecurrence>('specific_date');
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([]);
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [spendAmount, setSpendAmount] = useState('');
  const [spendNote, setSpendNote] = useState('');
  const alive = useRef(true);
  const query = useRef(0);
  const mutationLock = useRef(false);
  const networkLock = useRef(false);
  const pairingLock = useRef(false);
  const ready = useRef(false);
  const epochRef = useRef<string | null | undefined>(undefined);
  const auto = useRef<MobileAutoSync | null>(null);
  const appForeground = useRef(true);
  const networkOnline = useRef(true);

  const [draftRepository] = useState(
    () =>
      services.draftRepository ??
      new DraftRepository(
        services.repository.open
          ? { open: services.repository.open.bind(services.repository) }
          : new MobileRepository(),
      ),
  );
  const [taskDraftId, setTaskDraftId] = useState<string>(() => crypto.randomUUID());
  const [spendDraftId, setSpendDraftId] = useState<string>(() => crypto.randomUUID());
  const [taskDraftEpoch, setTaskDraftEpoch] = useState<string | null>(null);
  const [spendDraftEpoch, setSpendDraftEpoch] = useState<string | null>(null);
  const taskDirty = Boolean(
    title ||
    notes ||
    scheduledDate ||
    scheduledTime ||
    selectedWeekdays.length ||
    recurrence !== 'specific_date' ||
    priority !== 'normal',
  );
  const spendDirty = Boolean(spendAmount || spendNote);
  useEffect(() => {
    if (taskDirty && taskDraftEpoch === null && state?.epoch) setTaskDraftEpoch(state.epoch);
    if (taskDirty && recurrence === 'specific_date' && !scheduledDate && state?.snapshot) {
      setScheduledDate(dateInTimeZone(clock(), state.snapshot.timeZone));
    }
    if (spendDirty && spendDraftEpoch === null && state?.epoch) setSpendDraftEpoch(state.epoch);
  }, [
    taskDirty,
    spendDirty,
    taskDraftEpoch,
    spendDraftEpoch,
    state?.epoch,
    state?.snapshot,
    recurrence,
    scheduledDate,
    clock,
  ]);
  const taskPayload = useMemo(
    () => ({
      id: taskDraftId,
      epoch: taskDraftEpoch,
      title,
      notes,
      recurrence,
      selectedWeekdays,
      scheduledDate,
      scheduledTime,
      priority,
    }),
    [
      taskDraftId,
      taskDraftEpoch,
      title,
      notes,
      recurrence,
      selectedWeekdays,
      scheduledDate,
      scheduledTime,
      priority,
    ],
  );
  const spendPayload = useMemo(
    () => ({ id: spendDraftId, epoch: spendDraftEpoch, amount: spendAmount, note: spendNote }),
    [spendDraftId, spendDraftEpoch, spendAmount, spendNote],
  );
  const taskDraft = useDurableDraft({
    id: taskDraftId,
    scope: 'mobile-task',
    summary: title || '未完成任务',
    payload: taskPayload,
    dirty: taskDirty,
    active: page === 'add-task',
    repository: draftRepository,
    onRestore(value, row) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        value.id !== row.id ||
        !(value.epoch === null || typeof value.epoch === 'string') ||
        !['title', 'notes', 'scheduledDate', 'scheduledTime'].every(
          (key) => typeof value[key] === 'string',
        ) ||
        !['specific_date', 'daily', 'selected_weekdays'].includes(String(value.recurrence)) ||
        !['low', 'normal', 'high'].includes(String(value.priority)) ||
        !Array.isArray(value.selectedWeekdays) ||
        !value.selectedWeekdays.every(
          (day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
        )
      )
        throw new Error('任务草稿格式无效。');
      setTaskDraftId(row.id);
      setTaskDraftEpoch(value.epoch);
      setTitle(value.title as string);
      setNotes(value.notes as string);
      setScheduledDate(value.scheduledDate as string);
      setScheduledTime(value.scheduledTime as string);
      setRecurrence(value.recurrence as TaskRecurrence);
      setSelectedWeekdays(value.selectedWeekdays as number[]);
      setPriority(value.priority as TaskPriority);
    },
  });
  const spendDraft = useDurableDraft({
    id: spendDraftId,
    scope: 'mobile-spend',
    summary: spendAmount ? spendAmount + ' 元 · ' + spendNote : '未完成扣款',
    payload: spendPayload,
    dirty: spendDirty,
    active: page === 'spend',
    repository: draftRepository,
    onRestore(value, row) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        value.id !== row.id ||
        !(value.epoch === null || typeof value.epoch === 'string') ||
        typeof value.amount !== 'string' ||
        typeof value.note !== 'string'
      )
        throw new Error('扣款草稿格式无效。');
      setSpendDraftId(row.id);
      setSpendDraftEpoch(value.epoch);
      setSpendAmount(value.amount);
      setSpendNote(value.note);
    },
  });

  const widgetDraft = useRef({ taskDirty, taskDraft, state, page });
  widgetDraft.current = { taskDirty, taskDraft, state, page };
  const widget = useMobileWidget({
    state,
    now,
    loadError,
    epochChanging: epochChange !== undefined,
    busy: mutating || pairing,
    native: services.native,
    navigation,
    notice: announceCelebration,
    async prepareAdd() {
      if (widgetDraft.current.taskDirty) return;
      const epoch = widgetDraft.current.state?.epoch;
      const drafts = await draftRepository.list('mobile-task');
      const current = widgetDraft.current;
      if (current.taskDirty || current.page !== 'add-task' || current.state?.epoch !== epoch)
        return;
      const previous = drafts.find(
        (draft) => isRecord(draft.payload) && draft.payload.epoch === epoch,
      );
      if (previous) await current.taskDraft.restore(previous);
    },
  });

  const reload = useCallback(async () => {
    const request = ++query.current;
    try {
      const next = await services.repository.load();
      if (alive.current && request === query.current) {
        setState(next);
        setLoadError('');
        ready.current = true;
      }
      return true;
    } catch {
      if (alive.current && request === query.current) {
        ready.current = false;
        setLoadError('读取失败，请重试。');
      }
      return false;
    }
  }, [services]);

  const runSync = useCallback(
    async (mode: AutoSyncMode): Promise<AutoSyncResult> => {
      if (
        networkLock.current ||
        pairingLock.current ||
        !ready.current ||
        epochRef.current !== undefined
      )
        return 'stop';
      const manual = manualRequest.current;
      visibleRun.current = manual;
      const spokenBefore = confirmationsSpoken.current;
      let outcome: { text: string; succeeded: boolean } | null = null;
      networkLock.current = true;
      let reloadRequired = true;
      if (alive.current) {
        setChecking(mode === 'check');
        if (mode === 'sync') setSyncing(true);
        setVisibleSync(manual);
        // An older result is no longer current; removing it is silent.
        setSyncStatus(null);
      }
      try {
        const result =
          mode === 'check' &&
          services.client.changeProbe === true &&
          services.client.checkForChanges
            ? await services.client.checkForChanges(() => {
                if (alive.current) setSyncing(true);
              })
            : await services.client.sync();
        reloadRequired = result.snapshotUpdated;
        if (alive.current) {
          setSyncMessage('');
          setSyncNeedsAction(false);
          setCheckedAt(clock());
          // The same sync may already have removed the acknowledged entries; its receipts
          // still say what the computer applied.
          announceConfirmed.current(confirmedFromReceipts(result.applied ?? []));
        }
        outcome = { text: '同步完成。', succeeded: true };
        return result.changeProbe ? 'ok' : 'legacy';
      } catch (failure) {
        const text = message(failure, '同步失败，请重试。');
        const transient =
          failure instanceof MobileSyncError &&
          ['UNAVAILABLE', 'SNAPSHOT_EXPIRED'].includes(failure.code);
        if (alive.current) {
          setSyncMessage(text);
          setSyncNeedsAction(!transient);
          if (failure instanceof MobileSyncError && failure.code === 'EPOCH_CHANGED') {
            epochRef.current = failure.newEpoch;
            setEpochChange(failure.newEpoch);
          }
        }
        // The epoch alert speaks for itself; anything else that needs action says so.
        if (!(failure instanceof MobileSyncError && failure.code === 'EPOCH_CHANGED'))
          outcome = { text: transient ? text : `需要处理：${text}`, succeeded: false };
        return failure instanceof MobileSyncError &&
          ['UNAVAILABLE', 'SNAPSHOT_EXPIRED'].includes(failure.code)
          ? services.client.changeProbe === false
            ? 'legacy-retry'
            : 'retry'
          : 'stop';
      } finally {
        if (reloadRequired) await reload();
        networkLock.current = false;
        const requested = visibleRun.current;
        visibleRun.current = false;
        if (alive.current) {
          setSyncing(false);
          setChecking(false);
          setVisibleSync(false);
          // Decided after this sync's reload, once any confirmation it brought was spoken.
          if (requested && outcome)
            setSyncOutcome({ ...outcome, spokenBefore, seq: ++syncStatusSeq.current });
        }
      }
    },
    [clock, reload, services],
  );

  useEffect(() => {
    alive.current = true;
    const controller = new MobileAutoSync(
      runSync,
      () =>
        alive.current &&
        appForeground.current &&
        networkOnline.current &&
        navigator.onLine !== false &&
        document.visibilityState !== 'hidden' &&
        ready.current &&
        !pairingLock.current &&
        epochRef.current === undefined,
    );
    auto.current = controller;
    void reload().then((loaded) => {
      if (loaded) controller.trigger();
    });
    const foreground = () => {
      if (document.visibilityState === 'hidden' || !appForeground.current) {
        controller.suspend();
        return;
      }
      setNow(clock());
      controller.trigger();
    };
    const online = () => {
      networkOnline.current = true;
      foreground();
    };
    const offline = () => {
      networkOnline.current = false;
      controller.suspend();
    };
    const resume = () => {
      appForeground.current = true;
      foreground();
    };
    const background = () => {
      appForeground.current = false;
      controller.suspend();
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNow(clock());
    }, 60_000);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    window.addEventListener('valrecall-network-ready', online);
    window.addEventListener('valrecall-network-offline', offline);
    window.addEventListener('valrecall-app-resume', resume);
    window.addEventListener('valrecall-app-background', background);
    return () => {
      alive.current = false;
      query.current++;
      controller.dispose();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      window.removeEventListener('valrecall-network-ready', online);
      window.removeEventListener('valrecall-network-offline', offline);
      window.removeEventListener('valrecall-app-resume', resume);
      window.removeEventListener('valrecall-app-background', background);
    };
  }, [clock, reload, runSync]);

  /** A sync the person asked for. One already running automatically is shown from now on. */
  function syncNow() {
    if (networkLock.current) {
      setVisibleSync(true);
      visibleRun.current = true;
    }
    manualRequest.current = true;
    try {
      auto.current?.trigger(true);
    } finally {
      manualRequest.current = false;
    }
  }

  /** A null success keeps the page still: the caller reports through the floating line. */
  async function mutate(
    action: () => Promise<unknown>,
    success: string | null,
    area: MobileTab = 'tasks',
    form?: 'add-task' | 'spend',
  ): Promise<boolean> {
    if (mutationLock.current || !ready.current) return false;
    mutationLock.current = true;
    setMutating(true);
    setMessages((current) => ({ ...current, [area]: {} }));
    try {
      await action();
      if (alive.current && success !== null)
        setMessages((current) => ({ ...current, [area]: { notice: success } }));
      await reload();
      auto.current?.changed();
      return true;
    } catch (failure) {
      if (alive.current)
        setMessages((current) => ({
          ...current,
          [area]: { error: message(failure, '没有保存成功，请重试。'), form },
        }));
      return false;
    } finally {
      mutationLock.current = false;
      if (alive.current) setMutating(false);
    }
  }

  async function pair(scan: boolean) {
    if (pairingLock.current || networkLock.current || mutationLock.current) return;
    pairingLock.current = true;
    setPairing(true);
    setMessages((current) => ({ ...current, settings: {} }));
    try {
      await services.native(scan ? 'pair.scan' : 'pair.import', scan ? {} : { qr });
      if (!alive.current) return;
      setQr('');
      epochRef.current = undefined;
      setEpochChange(undefined);
      setMessages((current) => ({ ...current, settings: { notice: '已配对，正在同步。' } }));
    } catch (failure) {
      if (alive.current)
        setMessages((current) => ({
          ...current,
          settings: { error: message(failure, '配对失败，请重新显示电脑配对码。') },
        }));
      return;
    } finally {
      pairingLock.current = false;
      if (alive.current) setPairing(false);
    }
    syncNow();
  }

  async function acceptEpoch() {
    if (!epochChange || networkLock.current || mutationLock.current || pairingLock.current) return;
    if (!confirmAction('接收电脑恢复后的数据？旧记录会另存。')) return;
    const accepted = await mutate(
      () => services.repository.acceptNewEpoch(epochChange),
      '正在同步新数据。',
      'settings',
    );
    if (accepted) {
      epochRef.current = undefined;
      setEpochChange(undefined);
      syncNow();
    }
  }

  async function addTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state?.snapshot || epochRef.current !== undefined) return;
    if (recurrence === 'selected_weekdays' && selectedWeekdays.length === 0) {
      setMessages((current) => ({
        ...current,
        tasks: { error: '请至少选择一个星期。', form: 'add-task' },
      }));
      return;
    }
    let createdId = '';
    let createdEntryId = '';
    const saved = await mutate(
      async () => {
        const token = await taskDraft.flush();
        const entry = await services.repository.createTask(
          {
            title,
            notes,
            recurrence,
            selectedWeekdays,
            scheduledDate:
              recurrence === 'specific_date'
                ? scheduledDate || dateInTimeZone(clock(), state.snapshot!.timeZone)
                : null,
            scheduledTime: scheduledTime || null,
            priority,
          },
          clock(),
          {
            id: taskDraftId,
            epoch: taskDraftEpoch ?? state.epoch!,
            ...(token ? { draft: token } : {}),
          },
        );
        taskDraft.markCommitted();
        if (entry.operation.kind === 'create-task') {
          createdId = entry.operation.task.id;
          createdEntryId = entry.id;
        }
      },
      // Reported on the floating line once back on #tasks, so nothing pushes the list down.
      null,
      'tasks',
      'add-task',
    );
    if (saved && alive.current) {
      // Back on #tasks the new row is focused, with 之后 opened for a later date, so no
      // extra link is left above the list.
      setTaskDraftId(crypto.randomUUID());
      setTaskDraftEpoch(null);
      setTitle('');
      setNotes('');
      setRecurrence('specific_date');
      setSelectedWeekdays([]);
      setScheduledDate('');
      setScheduledTime('');
      setPriority('normal');
      navigation.complete('add-task', createdId ? 'mobile-task-' + createdId : undefined);
      if (createdEntryId) {
        const entryId = createdEntryId;
        const rowId = 'mobile-task-' + createdId;
        // Saved on the phone only: an estimate from the stored entry until the computer confirms.
        void services.repository
          .load()
          .then((after) => creationEstimate(after, entryId))
          .catch(() => 0)
          .then((amount) => {
            if (alive.current) setCreationCue({ entryId, rowId, amount });
          });
      }
    }
  }

  async function cancel(entry: MobileOutboxEntry) {
    if (!confirmAction('取消这笔扣款？')) return;
    await mutate(() => services.repository.cancelNeverSent(entry.id), '已取消扣款。', 'settings');
  }

  async function taskAction(
    row: MobileTaskRow,
    action: 'undo-task' | 'cancel-task' | 'restore-task',
  ) {
    if (mutationLock.current) return;
    if (
      action === 'cancel-task' &&
      row.task.recurrence === 'specific_date' &&
      !confirmAction('不做这件待办了？')
    )
      return;
    if (action === 'undo-task') {
      const unsent = state?.outbox.find(
        (entry) =>
          entry.operation.kind === 'complete-task' &&
          entry.operation.taskId === row.task.id &&
          (entry.operation.occurrenceDate ?? entry.operation.date) === row.date &&
          entry.status === 'pending' &&
          !entry.attempted,
      );
      const prompt =
        __VALRECALL_PUBLIC_RELEASE__ || unsent
          ? '撤销这次完成？'
          : row.rewardAmount === null || row.rewardAmount === undefined
            ? '撤销这次完成？余额不变。'
            : row.rewardAmount > 0
              ? '撤销完成并扣回 ' + row.rewardAmount + ' 元？'
              : '撤销这次完成？';
      if (!confirmAction(prompt)) return;
    }
    const saved = await mutate(
      () => services.repository.enqueueTaskAction(action, row.task.id, row.date, clock()),
      action === 'undo-task'
        ? '已撤销完成。'
        : action === 'restore-task'
          ? '已恢复今天的待办。'
          : row.task.recurrence === 'specific_date'
            ? '已取消待办。'
            : '今天已跳过。',
    );
    if (saved && page === 'task-history') historyFocus.current = row.task.id;
  }

  async function spend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state?.snapshot || epochRef.current !== undefined || mutationLock.current) return;
    const amount = Number(spendAmount.trim());
    if (!/^[1-9]\d*$/.test(spendAmount.trim()) || !Number.isSafeInteger(amount)) {
      setMessages((current) => ({
        ...current,
        wallet: { error: '请输入大于 0 的整数金额。', form: 'spend' },
      }));
      return;
    }
    if (!confirmAction(`确认扣除 ${amount} 元？`)) return;
    const saved = await mutate(
      async () => {
        const token = await spendDraft.flush();
        await services.repository.enqueueSpend(amount, spendNote.trim() || undefined, clock(), {
          id: spendDraftId,
          epoch: spendDraftEpoch ?? state.epoch!,
          ...(token ? { draft: token } : {}),
        });
        spendDraft.markCommitted();
      },
      '已记录扣款。',
      'wallet',
      'spend',
    );
    if (saved && alive.current) {
      setSpendDraftId(crypto.randomUUID());
      setSpendDraftEpoch(null);
      setSpendAmount('');
      setSpendNote('');
      navigation.complete('spend', 'mobile-wallet-balance');
    }
  }

  const snapshot = state?.snapshot;
  const today = snapshot ? dateInTimeZone(now, snapshot.timeZone) : null;
  const canEdit = Boolean(snapshot?.version === 2 && !loadError && epochChange === undefined);
  const groups = useMemo(
    () =>
      state && today
        ? groupMobileTasks(state, today)
        : { open: [], future: [], completed: [], skipped: [] },
    [state, today],
  );
  const progress = useMemo(
    () => (snapshot && today ? taskProgress(groups.completed, today, snapshot.timeZone) : null),
    [groups.completed, today, snapshot],
  );
  // The computer's receipt is the real moment of payment; announce it once per operation.
  announceConfirmed.current = (rows) => {
    const fresh = rows.filter((row) => !announcedConfirmations.current.has(row.operationId));
    for (const row of fresh) announcedConfirmations.current.add(row.operationId);
    if (!fresh.length || document.visibilityState === 'hidden') return false;
    announceCelebration(confirmationMessage(fresh));
    confirmationsSpoken.current += 1;
    const amount = fresh.reduce((sum, row) => sum + (row.amount ?? 0), 0);
    if (amount > 0) motion.celebrateConfirmation(`+${amount}`);
    return true;
  };
  useEffect(() => {
    if (!state) return;
    const confirmed = confirmedCompletions(confirmedFrom.current, state);
    confirmedFrom.current = state;
    announceConfirmed.current(confirmed);
  }, [state]);
  // Declared after the confirmation effect, so it runs after it in the commit that has the
  // sync's reloaded state (or a later one): a confirmation already says the sync worked, so a
  // success line then adds nothing. A failure is always spoken.
  useEffect(() => {
    if (!syncOutcome) return;
    if (syncOutcome.succeeded && confirmationsSpoken.current !== syncOutcome.spokenBefore) return;
    setSyncStatus({ text: syncOutcome.text, seq: syncOutcome.seq });
  }, [syncOutcome]);
  // Back on #tasks after saving a task: one floating line, and the estimate coin from its row.
  useEffect(() => {
    if (!creationCue || page !== 'tasks') return;
    setCreationCue(null);
    // Already confirmed by the computer (and announced) while this waited: nothing to add.
    if (announcedConfirmations.current.has(creationCue.entryId)) return;
    const { amount, rowId } = creationCue;
    announceCelebration(
      !__VALRECALL_PUBLIC_RELEASE__ && amount > 0 ? `已添加 · 待入账 +${amount} 元` : '已添加',
    );
    if (amount > 0) motion.celebrateCreation(rowId, `+${amount}`);
  }, [creationCue, page]);
  useEffect(() => {
    if (!celebrationStatus) return;
    const timer = window.setTimeout(() => setCelebrationStatus(null), CELEBRATION_STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [celebrationStatus]);
  useEffect(() => {
    if (mutating || !historyFocus.current) return;
    const id = historyFocus.current;
    historyFocus.current = null;
    if (page !== 'task-history') return;
    (
      document.getElementById('mobile-history-group-' + id) ??
      document.getElementById('mobile-page-heading')
    )?.focus({ preventScroll: true });
  }, [mutating, page, state]);
  const activeRows =
    state?.outbox.filter(
      (entry) =>
        entry.epoch === state.epoch &&
        (entry.status === 'pending' || entry.status === 'acknowledged'),
    ) ?? [];
  const pendingSpend = activeRows.reduce(
    (total, row) => total + (row.operation.kind === 'spend-allowance' ? row.operation.amount : 0),
    0,
  );
  const pendingReward = state ? pendingEstimate(state) : 0;
  const reversal = state ? pendingReversal(state) : 0;
  const acknowledgedReward = activeRows.reduce(
    (total, row) => total + (row.status === 'acknowledged' ? (row.receipt?.reward ?? 0) : 0),
    0,
  );
  const available = state ? mobileAvailableBalance(state) : 0;
  const attentionCount =
    state?.outbox.filter((entry) => entry.status === 'conflict' || entry.status === 'isolated')
      .length ?? 0;
  const pendingCount = activeRows.length;
  const hasPendingMoney =
    pendingReward + acknowledgedReward > 0 || pendingSpend > 0 || reversal !== 0;
  const taskList = (rows: MobileTaskRow[], idPrefix = 'mobile-task-', showNotes = true) => (
    <TaskList
      rows={rows}
      disabled={!canEdit || mutating}
      timeZone={snapshot!.timeZone}
      idPrefix={idPrefix}
      showNotes={showNotes}
      onComplete={async (row) => {
        const finish = motion.prepareCompletion('mobile-task-' + row.task.id);
        // Today's count before this completion, so a reload during the hold cannot change it.
        const ordinal = progress?.today.length ?? 0;
        let entryId: string | null = null;
        const saved = await mutate(async () => {
          entryId = (await services.repository.enqueueCompletion(row.task.id, clock())).id;
        }, null);
        if (!saved || entryId === null) return;
        if (__VALRECALL_PRIVATE_COMPANION_ASSETS__ && alive.current)
          setCompanionCompletion({ ordinal, seq: ++companionSeq.current });
        const savedId: string = entryId;
        // Saved on the phone only: an estimate until the computer confirms it.
        const estimate = services.repository
          .load()
          .then((after) => completionEstimate(after, savedId))
          .catch(() => 0);
        finish({ estimate });
        const amount = await estimate;
        if (alive.current)
          announceCelebration(
            !__VALRECALL_PUBLIC_RELEASE__ && amount > 0
              ? `已完成 · 待入账 +${amount} 元`
              : '已完成',
          );
      }}
      onAction={(row, action) => void taskAction(row, action)}
    />
  );

  async function discardTask() {
    const dirty =
      title ||
      notes ||
      scheduledDate ||
      scheduledTime ||
      selectedWeekdays.length ||
      recurrence !== 'specific_date' ||
      priority !== 'normal';
    if (dirty && !confirmAction('放弃这份任务草稿？填写的内容将清空。')) return;
    try {
      await taskDraft.discardCurrent();
    } catch (failure) {
      setMessages((current) => ({
        ...current,
        tasks: { error: message(failure, '草稿未删除。'), form: 'add-task' },
      }));
      return;
    }
    setTaskDraftId(crypto.randomUUID());
    setTaskDraftEpoch(null);
    setTitle('');
    setNotes('');
    setRecurrence('specific_date');
    setSelectedWeekdays([]);
    setScheduledDate('');
    setScheduledTime('');
    setPriority('normal');
    setMessages((current) => ({ ...current, tasks: {} }));
    navigation.back();
  }
  async function discardSpend() {
    if ((spendAmount || spendNote) && !confirmAction('放弃这份扣款草稿？填写的内容将清空。'))
      return;
    try {
      await spendDraft.discardCurrent();
    } catch (failure) {
      setMessages((current) => ({
        ...current,
        wallet: { error: message(failure, '草稿未删除。'), form: 'spend' },
      }));
      return;
    }
    setSpendDraftId(crypto.randomUUID());
    setSpendDraftEpoch(null);
    setSpendAmount('');
    setSpendNote('');
    setMessages((current) => ({ ...current, wallet: {} }));
    navigation.back();
  }
  const feedback = (area: MobileTab) => {
    const value = messages[area];
    if (!value) return null;
    if (isFormPage(page) && (value.form !== page || !value.error)) return null;
    return (
      <div className="mobile-feedback">
        {value.notice && (
          <p className="mobile-status" role="status">
            {value.notice}
          </p>
        )}
        {value.error && (
          <div className="mobile-error" role="alert">
            <p>{value.error}</p>
            {value.form && page !== value.form && (
              <button
                type="button"
                className="mobile-text-button"
                onClick={() => navigation.go(value.form!)}
              >
                返回{value.form === 'spend' ? '扣款' : '任务'}草稿
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <main ref={motion.shell} className={'mobile-shell' + (isSubpage(page) ? ' has-subpage' : '')}>
      <header className={isSubpage(page) ? 'mobile-subpage-bar' : 'mobile-header'}>
        {isSubpage(page) && (
          <button type="button" className="mobile-text-button" onClick={() => navigation.back()}>
            <MobileIcon name="back" />
            返回
          </button>
        )}
        {__VALRECALL_PRIVATE_COMPANION_ASSETS__ && (
          <MobileCompanion
            active={page === 'tasks'}
            today={today}
            now={now}
            loadError={Boolean(loadError)}
            openTasks={state && snapshot && !loadError ? groups.open.length : null}
            completedToday={progress?.today.length ?? 0}
            completion={companionCompletion}
          />
        )}
        <div>
          <h1 id="mobile-page-heading" tabIndex={-1}>
            {pageNames[page]}
          </h1>
          {page === 'tasks' && (
            <p className="mobile-muted">
              {today
                ? new Intl.DateTimeFormat('zh-CN', {
                    timeZone: snapshot!.timeZone,
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                  }).format(now)
                : '今天，从一件事开始'}
            </p>
          )}
          {page === 'settings' && <p className="mobile-muted">ValRecall · 手机伴侣</p>}
        </div>
        {isFormPage(page) && (
          <button
            type="submit"
            form={page === 'add-task' ? 'mobile-add-form' : 'mobile-spend-form'}
            className="mobile-save-button"
            disabled={
              !canEdit ||
              mutating ||
              (page === 'add-task' ? !title.trim() : !spendAmount || available <= 0)
            }
          >
            {mutating ? '保存中…' : page === 'add-task' ? '保存任务' : '确认扣除'}
          </button>
        )}
        {page === 'tasks' && (
          <button
            id="mobile-open-add"
            type="button"
            className="mobile-add-button"
            onClick={() => navigation.go('add-task')}
            disabled={!canEdit}
          >
            <MobileIcon name="plus" />
            添加任务
          </button>
        )}
      </header>
      <section className="mobile-sync-summary" hidden={isSubpage(page)} aria-label="同步状态">
        <button
          className="mobile-sync-link"
          type="button"
          onClick={() => navigation.go('settings', 'mobile-connection-heading')}
          aria-label="查看同步设置"
        >
          <MobileIcon name="sync" />
          {/* Not a live region: the floating line is the one announcement for a result. */}
          <span>
            {syncing && visibleSync
              ? '正在同步'
              : syncNeedsAction || attentionCount > 0
                ? '需要处理'
                : pendingCount > 0
                  ? pendingCount + ' 条待同步'
                  : snapshot
                    ? '已同步'
                    : '未连接电脑'}
          </span>
          <MobileIcon name="chevron" />
        </button>
        <button
          className="mobile-sync-action secondary"
          type="button"
          disabled={
            (visibleSync && (syncing || checking)) ||
            pairing ||
            !state ||
            Boolean(loadError) ||
            epochChange !== undefined
          }
          onClick={syncNow}
        >
          {visibleSync && (syncing || checking) ? '正在同步…' : '同步'}
        </button>
        {syncMessage && <p className="mobile-sync-detail">{syncMessage}</p>}
      </section>
      <LiveStatus
        className="mobile-sr-only"
        text={syncStatus?.text ?? null}
        seq={syncStatus?.seq ?? 0}
      />

      {loadError && (
        <div className="mobile-error" role="alert">
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() =>
              void reload().then((loaded) => {
                if (loaded) syncNow();
              })
            }
          >
            重试
          </button>
        </div>
      )}
      {!state && !loadError && <p role="status">加载中…</p>}
      {epochChange !== undefined && (
        <div className="mobile-error" role="alert">
          <p>电脑数据已更换。</p>
          {epochChange === null ? (
            <>
              <p>请先重新扫描电脑配对码。</p>
              <button
                type="button"
                onClick={() => navigation.go('settings', 'mobile-connection-heading')}
              >
                打开配对设置
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={mutating || syncing || pairing}
              onClick={() => void acceptEpoch()}
            >
              接收新数据
            </button>
          )}
        </div>
      )}

      <div className="mobile-page" hidden={page !== 'tasks'}>
        {feedback('tasks')}
        <section className="mobile-module mobile-today" aria-labelledby="mobile-current-heading">
          <div className="mobile-module-heading">
            <h2 id="mobile-current-heading">当前待办</h2>
            <span className="mobile-count">{state && !loadError ? groups.open.length : '—'}</span>
          </div>
          {!state || loadError ? (
            !loadError && <p className="mobile-empty">加载中…</p>
          ) : !snapshot ? (
            <div className="mobile-empty">
              <p>先连接电脑。</p>
              <button
                type="button"
                className="mobile-text-button"
                onClick={() => navigation.go('settings', 'mobile-connection-heading')}
              >
                前往配对
              </button>
            </div>
          ) : groups.open.length ? (
            <>
              {groups.open.some((row) => row.date >= today!) &&
                taskList(groups.open.filter((row) => row.date >= today!))}
              {groups.open.some((row) => row.date < today!) && (
                <section className="mobile-overdue" aria-labelledby="mobile-overdue-heading">
                  <h3 id="mobile-overdue-heading" className="mobile-group-label">
                    逾期
                    <span className="mobile-count">
                      {groups.open.filter((row) => row.date < today!).length}
                    </span>
                  </h3>
                  {taskList(groups.open.filter((row) => row.date < today!))}
                </section>
              )}
            </>
          ) : (
            <div className="mobile-empty">
              <p>当前没有待办。</p>
              <p className="mobile-muted">添加一件小事，或看看之后的安排。</p>
            </div>
          )}
        </section>
        {progress && !loadError && (
          <TaskProgress progress={progress} onHistory={() => navigation.go('task-history')} />
        )}
        {widget.futureTask && (
          <section
            className="mobile-module"
            id="mobile-widget-next-task"
            tabIndex={-1}
            aria-label="下一次安排"
          >
            <h2>{widget.futureTask.task.title}</h2>
            <p className="mobile-muted">
              下一次安排：{widget.futureTask.date}
              {widget.futureTask.task.scheduledTime
                ? ' · ' + widget.futureTask.task.scheduledTime
                : ''}
            </p>
            <button className="mobile-text-button" onClick={widget.dismissFuture}>
              收起
            </button>
          </section>
        )}
        {snapshot && (
          <section className="mobile-module mobile-task-groups" aria-label="其他任务">
            <details className="mobile-future" id="mobile-future" ref={futureList} tabIndex={-1}>
              <summary>
                之后<span className="mobile-count">{groups.future.length}</span>
              </summary>
              {groups.future.length ? (
                taskList(groups.future)
              ) : (
                <p className="mobile-empty">暂无之后的安排。</p>
              )}
            </details>
            <details
              className="mobile-completed"
              onToggle={(event) => {
                if (!event.currentTarget.open) setHistoryLimit(30);
              }}
            >
              <summary>
                今天已完成
                <span className="mobile-count">
                  {loadError ? '—' : (progress?.today.length ?? 0)}
                </span>
              </summary>
              {loadError ? null : progress?.today.length ? (
                taskList(progress.today.slice(0, historyLimit), 'mobile-today-task-')
              ) : (
                <p className="mobile-empty">今天还没有完成的任务。</p>
              )}
              {!loadError && (progress?.today.length ?? 0) > historyLimit && (
                <button
                  type="button"
                  className="mobile-text-button"
                  onClick={() => setHistoryLimit((limit) => limit + 30)}
                >
                  加载更多
                </button>
              )}
            </details>
            <details className="mobile-skipped">
              <summary>
                已跳过<span className="mobile-count">{groups.skipped.length}</span>
              </summary>
              {groups.skipped.length ? (
                taskList(groups.skipped)
              ) : (
                <p className="mobile-empty">暂无跳过的任务。</p>
              )}
            </details>
          </section>
        )}
        {!__VALRECALL_PUBLIC_RELEASE__ && pendingReward > 0 && (
          <p className="mobile-status">待入账 +{pendingReward} 元</p>
        )}
      </div>

      <div id="mobile-history-page" className="mobile-page" hidden={page !== 'task-history'}>
        {feedback('tasks')}
        <div hidden={Boolean(loadError)}>
          {progress && snapshot && (
            <TaskHistory
              groups={progress.history}
              timeZone={snapshot.timeZone}
              renderRows={(rows) => taskList(rows, 'mobile-history-task-', false)}
            />
          )}
        </div>
      </div>

      <div className="mobile-page" hidden={page !== 'add-task'}>
        <form
          id="mobile-add-form"
          className="mobile-form mobile-module"
          aria-label="添加任务"
          onSubmit={(event) => void addTask(event)}
        >
          <div className="mobile-add-entry">
            <fieldset className="mobile-add-title" disabled={!canEdit || mutating}>
              <label>
                <span className="mobile-sr-only">任务标题</span>
                <input
                  id="mobile-task-title"
                  required
                  maxLength={500}
                  value={title}
                  name="title"
                  placeholder="添加一件要做的事"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            </fieldset>
            <div className="mobile-add-draft">
              <DraftRecovery draft={taskDraft} disabled={mutating} />
              {widget.addError && (
                <div className="mobile-error" role="alert">
                  <p>{widget.addError}</p>
                  <button type="button" onClick={widget.retryAdd}>
                    重试读取草稿
                  </button>
                </div>
              )}
            </div>
          </div>
          <fieldset className="mobile-add-options" disabled={!canEdit || mutating}>
            <label>
              重复安排
              <select
                name="recurrence"
                form="mobile-add-form"
                value={recurrence}
                onChange={(event) => setRecurrence(event.target.value as TaskRecurrence)}
              >
                <option value="specific_date">一次性</option>
                <option value="daily">每天</option>
                <option value="selected_weekdays">每周指定星期</option>
              </select>
            </label>
            {recurrence === 'specific_date' && (
              <label>
                日期
                <input
                  name="date"
                  form="mobile-add-form"
                  type="date"
                  required
                  value={scheduledDate || today || ''}
                  onChange={(event) => setScheduledDate(event.target.value)}
                />
              </label>
            )}
            {recurrence === 'selected_weekdays' && (
              <fieldset className="mobile-weekdays">
                <legend>选择星期</legend>
                {weekdays.map(([day, label]) => (
                  <label key={day}>
                    <input
                      name={'weekday-' + day}
                      form="mobile-add-form"
                      type="checkbox"
                      checked={selectedWeekdays.includes(day)}
                      onChange={(event) =>
                        setSelectedWeekdays((current) =>
                          event.target.checked
                            ? [...current, day].sort((a, b) => a - b)
                            : current.filter((value) => value !== day),
                        )
                      }
                    />
                    周{label}
                  </label>
                ))}
              </fieldset>
            )}
          </fieldset>
          <details className="mobile-advanced">
            <summary>更多选项</summary>
            <fieldset className="mobile-form" disabled={!canEdit || mutating}>
              <label>
                备注（可选）
                <textarea
                  name="notes"
                  form="mobile-add-form"
                  maxLength={8000}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </label>
              <label>
                计划时间（可选）
                <input
                  name="time"
                  form="mobile-add-form"
                  type="time"
                  value={scheduledTime}
                  onChange={(event) => setScheduledTime(event.target.value)}
                />
              </label>
              <label>
                优先级
                <select
                  name="priority"
                  form="mobile-add-form"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as TaskPriority)}
                >
                  <option value="normal">普通</option>
                  <option value="high">优先</option>
                  <option value="low">稍后</option>
                </select>
              </label>
            </fieldset>
          </details>

          {feedback('tasks')}
          {__VALRECALL_PUBLIC_RELEASE__ ? null : (
            <p className="mobile-muted mobile-add-reward">添加 +5 元，完成再 +5 元</p>
          )}
        </form>

        <button
          type="button"
          className="mobile-text-button mobile-discard"
          disabled={mutating}
          onClick={discardTask}
        >
          放弃草稿
        </button>
      </div>

      <div className="mobile-page" hidden={__VALRECALL_PUBLIC_RELEASE__ || page !== 'wallet'}>
        {feedback('wallet')}
        <section className="mobile-module mobile-wallet" aria-labelledby="mobile-wallet-balance">
          <h2 className="mobile-balance-label" id="mobile-wallet-balance" tabIndex={-1}>
            余额
          </h2>
          <p className="mobile-balance-line">
            <strong className="mobile-balance">{snapshot ? snapshot.wallet.balance : '—'}</strong>
            <span>元</span>
          </p>
          {!snapshot && <p className="mobile-muted">同步后显示余额。</p>}
          <button
            id="mobile-open-spend"
            type="button"
            disabled={!canEdit || mutating || available <= 0}
            onClick={() => navigation.go('spend')}
          >
            记一笔扣款
          </button>
          {snapshot && available <= 0 && <p className="mobile-muted">暂无可扣金额。</p>}
        </section>
        <section className="mobile-module" aria-labelledby="mobile-pending-heading">
          <h2 id="mobile-pending-heading">待确认</h2>
          {!state || loadError ? (
            !loadError && <p className="mobile-pending-empty">加载中…</p>
          ) : hasPendingMoney ? (
            <dl className="mobile-amount-list">
              <div>
                <dt>待入账</dt>
                <dd>
                  {pendingReward + acknowledgedReward > 0 ? '+' : ''}
                  {pendingReward + acknowledgedReward}
                  <span> 元</span>
                </dd>
              </div>
              <div>
                <dt>待扣款</dt>
                <dd>
                  {pendingSpend > 0 ? '−' : ''}
                  {pendingSpend}
                  <span> 元</span>
                </dd>
              </div>
              <div>
                <dt>待撤销</dt>
                <dd>
                  {reversal === null ? '金额待确认' : (reversal > 0 ? '−' : '') + reversal + ' 元'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mobile-pending-empty">
              <MobileIcon name="check" />
              暂无待确认操作
            </p>
          )}
          <button
            type="button"
            className="mobile-settings-row"
            onClick={() => navigation.go('settings', 'mobile-records-heading')}
          >
            <MobileIcon name="history" />
            <span>查看记录</span>
            <MobileIcon name="chevron" />
          </button>
        </section>
      </div>

      <div className="mobile-page" hidden={__VALRECALL_PUBLIC_RELEASE__ || page !== 'spend'}>
        <DraftRecovery draft={spendDraft} disabled={mutating} />
        <form
          id="mobile-spend-form"
          className="mobile-form mobile-spend-form mobile-module"
          aria-label="扣除零花钱"
          onSubmit={(event) => void spend(event)}
        >
          <fieldset disabled={!canEdit || mutating}>
            <label>
              金额（元）
              <input
                name="amount"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                max={available}
                required
                placeholder="0"
                value={spendAmount}
                onChange={(event) => setSpendAmount(event.target.value)}
              />
            </label>
            <label>
              备注（可选）
              <input
                name="spend-note"
                maxLength={500}
                value={spendNote}
                onChange={(event) => setSpendNote(event.target.value)}
              />
            </label>
            <p className="mobile-muted">可扣除 {available} 元</p>
            {feedback('wallet')}
          </fieldset>
        </form>

        <button
          type="button"
          className="mobile-text-button mobile-discard"
          disabled={mutating}
          onClick={discardSpend}
        >
          放弃扣款草稿
        </button>
      </div>

      <div className="mobile-page" hidden={page !== 'settings'}>
        <section
          className="mobile-module mobile-settings"
          aria-labelledby="mobile-connection-heading"
        >
          <div className="mobile-setting-heading">
            <span className="mobile-setting-icon">
              <MobileIcon name="sync" />
            </span>
            <h2 id="mobile-connection-heading" tabIndex={-1}>
              连接与同步
            </h2>
          </div>
          {feedback('settings')}
          <button
            type="button"
            className={snapshot ? 'mobile-sync-action' : 'mobile-text-button'}
            disabled={
              (visibleSync && (syncing || checking)) ||
              pairing ||
              !state ||
              Boolean(loadError) ||
              epochChange !== undefined
            }
            onClick={syncNow}
          >
            {visibleSync && (syncing || checking) ? '正在同步…' : '立即同步'}
          </button>
          {snapshot && state && (
            <details className="mobile-connection-details">
              <summary>连接详情</summary>
              <p className="mobile-muted">
                上次同步：{savedAt(state, checkedAt)}
                <br />
                电脑时区：{snapshot.timeZone}
              </p>
            </details>
          )}
          <details className="mobile-pairing" open={!snapshot ? true : undefined}>
            <summary>配对与连接方式</summary>
            <div className="mobile-toolbar">
              <button
                type="button"
                className={snapshot ? 'secondary' : undefined}
                disabled={syncing || checking || pairing || mutating}
                aria-describedby={backgroundSync ? 'mobile-pairing-wait' : undefined}
                onClick={() => void pair(true)}
              >
                {pairing ? '等待配对…' : '扫描电脑二维码'}
              </button>
            </div>
            {backgroundSync && (
              <p id="mobile-pairing-wait" className="mobile-muted mobile-background-sync">
                正在同步，稍后可配对。
              </p>
            )}

            <details>
              <summary>无法扫码？粘贴配对文字</summary>
              <div className="mobile-form">
                <label>
                  电脑显示的配对文字
                  <textarea
                    name="pair-text"
                    value={qr}
                    onChange={(event) => setQr(event.target.value)}
                    maxLength={4096}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  disabled={!qr.trim() || pairing || syncing || checking || mutating}
                  aria-describedby={backgroundSync ? 'mobile-pairing-wait' : undefined}
                  onClick={() => void pair(false)}
                >
                  使用配对文字
                </button>
                <p className="mobile-muted">请勿分享配对文字。</p>
              </div>
            </details>
          </details>
        </section>
        <section className="mobile-module mobile-recovery" aria-labelledby="mobile-records-heading">
          <div className="mobile-module-heading">
            <div className="mobile-setting-heading">
              <span className="mobile-setting-icon neutral">
                <MobileIcon name="history" />
              </span>
              <h2 id="mobile-records-heading" tabIndex={-1}>
                同步记录
              </h2>
            </div>
            <span className="mobile-count">{state && !loadError ? state.outbox.length : '—'}</span>
          </div>
          {state && (
            <>
              {state.outbox.length === 0 ? (
                <p className="mobile-muted">没有待同步的记录。</p>
              ) : (
                <ul className="mobile-task-list">
                  {state.outbox.map((entry) => (
                    <li key={entry.id} className="mobile-operation">
                      <details>
                        <summary>
                          <span className="mobile-operation-status">
                            {entry.status === 'isolated'
                              ? '旧版本记录'
                              : entry.status === 'conflict'
                                ? '冲突'
                                : entry.status === 'acknowledged'
                                  ? '已确认 · 更新中'
                                  : entry.attempted
                                    ? '已发送'
                                    : '未发送'}{' '}
                            ·{' '}
                            {
                              {
                                'create-task': '新增',
                                'spend-allowance': '扣款',
                                'complete-task': '完成',
                                'undo-task': '撤销完成',
                                'archive-task': '不做了',
                                'skip-task': '今天不做',
                                'restore-task': '恢复今天',
                              }[entry.operation.kind]
                            }
                          </span>{' '}
                          <span className="mobile-operation-title">
                            {operationTitle(entry, state)}
                          </span>
                        </summary>
                        {entry.receipt?.message && <p>{entry.receipt.message}</p>}
                        <p className="mobile-muted">
                          操作编号：{entry.id}
                          <br />
                          数据版本：{entry.epoch}
                          <br />
                          记录时间：{entry.operation.at}
                        </p>
                        {entry.operation.kind === 'create-task' ? (
                          <>
                            <p>{entry.operation.task.notes}</p>
                            <p>
                              安排：
                              {entry.operation.task.recurrence === 'daily'
                                ? '每天'
                                : entry.operation.task.recurrence === 'specific_date'
                                  ? entry.operation.task.scheduledDate
                                  : '星期 ' + entry.operation.task.selectedWeekdays.join('、')}{' '}
                              {entry.operation.task.scheduledTime}
                            </p>
                          </>
                        ) : entry.operation.kind === 'spend-allowance' ? (
                          <p>
                            扣款 {entry.operation.amount} 元。{entry.operation.note}
                          </p>
                        ) : (
                          <p>
                            操作日期：{entry.operation.date} · {entry.operation.timeZone}
                          </p>
                        )}
                        {entry.status === 'conflict' && <p>请在电脑核对。</p>}
                        {entry.status === 'isolated' && <p>旧版本记录，仅供查看。</p>}
                        {entry.status === 'pending' &&
                          !entry.attempted &&
                          entry.epoch === state.epoch &&
                          entry.operation.kind === 'spend-allowance' && (
                            <>
                              <button
                                type="button"
                                disabled={mutating || syncing}
                                aria-describedby={
                                  backgroundSync && syncing
                                    ? 'mobile-cancel-wait-' + entry.id
                                    : undefined
                                }
                                onClick={() => void cancel(entry)}
                              >
                                取消待扣款
                              </button>
                              {backgroundSync && syncing && (
                                <p
                                  id={'mobile-cancel-wait-' + entry.id}
                                  className="mobile-muted mobile-background-sync"
                                >
                                  正在同步，稍后可取消。
                                </p>
                              )}
                            </>
                          )}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              {state.archives.map((archive) => (
                <details key={archive.id}>
                  <summary>
                    旧记录存档 · {archive.archivedAt} · {archive.snapshot.tasks.length} 个任务
                  </summary>
                  {__VALRECALL_PUBLIC_RELEASE__ ? (
                    <p>完成记录 {archive.snapshot.completions.length} 条。</p>
                  ) : (
                    <p>
                      当时余额：{archive.snapshot.wallet.balance}
                      ；完成记录 {archive.snapshot.completions.length} 条。
                    </p>
                  )}
                  <ul>
                    {archive.snapshot.tasks.map(({ task }) => (
                      <li key={task.id}>
                        {task.title}
                        {task.notes ? ' · ' + task.notes : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </>
          )}
        </section>
        <section className="mobile-module mobile-help" aria-labelledby="mobile-help-heading">
          <div className="mobile-setting-heading">
            <span className="mobile-setting-icon neutral">
              <MobileIcon name="help" />
            </span>
            <h2 id="mobile-help-heading">使用帮助</h2>
          </div>
          <details>
            <summary>如何自动接续</summary>
            <p>电脑需开着 Edge 并开启手机同步，两台设备连同一 Wi-Fi。</p>
            <p>打开 App 时自动同步，也可点顶部“同步”。</p>
          </details>
          <details>
            <summary>任务与日期</summary>
            <p>修改、恢复或停止重复待办请在电脑上操作。</p>
          </details>
          {__VALRECALL_PUBLIC_RELEASE__ ? null : (
            <details>
              <summary>余额与奖励</summary>
              <p>添加待办 +5 元，完成再 +5 元。</p>
              <p>撤销完成会扣回奖励。</p>
            </details>
          )}
          <p className="mobile-muted mobile-font-attribution">
            {__VALRECALL_PUBLIC_RELEASE__
              ? '本产品使用思源黑体（Noto Sans SC），SIL Open Font License 1.1。'
              : '本产品使用 MiSans 字体，由小米提供。'}
          </p>
        </section>
      </div>
      {attentionCount > 0 && !isSubpage(page) && page !== 'settings' && (
        <p className="mobile-attention" role="status">
          {attentionCount} 条记录需要核对。
          <button
            type="button"
            className="mobile-text-button"
            onClick={() => navigation.go('settings', 'mobile-records-heading')}
          >
            查看记录
          </button>
        </p>
      )}
      <p
        className="mobile-celebration-status"
        role="status"
        aria-live="polite"
        hidden={isSubpage(page) || !celebrationStatus}
      >
        {celebrationStatus && <span key={celebrationStatus.seq}>{celebrationStatus.text}</span>}
      </p>
      <nav
        className="mobile-bottom-nav"
        data-tab={pageTab(page)}
        aria-label="手机主导航"
        hidden={isSubpage(page)}
      >
        {(__VALRECALL_PUBLIC_RELEASE__
          ? (['tasks', 'settings'] as const)
          : (['tasks', 'wallet', 'settings'] as const)
        ).map((tab) => (
          <button
            key={tab}
            id={tab === 'wallet' ? MOBILE_WALLET_TAB_ID : undefined}
            type="button"
            aria-current={pageTab(page) === tab ? 'page' : undefined}
            onClick={() => navigation.go(tab)}
          >
            <MobileIcon name={tab} />
            <span>{pageNames[tab]}</span>
          </button>
        ))}
      </nav>
    </main>
  );
}
