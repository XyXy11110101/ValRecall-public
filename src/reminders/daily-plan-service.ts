import { reopenDayForAlarm } from '../edition/daily-plan-day';
import {
  hasReachedLocalReminderTime,
  isValidReminderTime,
  localDateKey,
  nextLocalReminderOccurrence,
  type ReminderNotification,
} from './reminder-service';

export const DAILY_PLAN_ALARM_NAME = 'valrecall.daily-plan';
export const DAILY_PLAN_NOTIFICATION_ID = 'valrecall.daily-plan-reminder';
export const DAILY_PLAN_TEST_NOTIFICATION_ID = 'valrecall.daily-plan-reminder-test';

export interface DailyPlanPreferences {
  dailyPlanReminderEnabled: boolean;
  dailyPlanReminderTime: string;
  includeReviewsInDailyPlan: boolean;
  includeTasksInDailyPlan: boolean;
}

export interface DailyPlanState {
  lastEvaluationLocalDate: string | null;
  lastNotificationLocalDate: string | null;
}

export const DEFAULT_DAILY_PLAN_PREFERENCES: Readonly<DailyPlanPreferences> = Object.freeze({
  dailyPlanReminderEnabled: true,
  dailyPlanReminderTime: '09:00',
  includeReviewsInDailyPlan: true,
  includeTasksInDailyPlan: true,
});

export const DEFAULT_DAILY_PLAN_STATE: Readonly<DailyPlanState> = Object.freeze({
  lastEvaluationLocalDate: null,
  lastNotificationLocalDate: null,
});

export interface DailyPlanServicePort {
  now(): Date;
  loadPreferences(): Promise<DailyPlanPreferences>;
  loadState(): Promise<DailyPlanState>;
  saveState(state: DailyPlanState): Promise<void>;
  countDueReviews(now: Date): Promise<number>;
  countRemainingTasks(now: Date): Promise<number>;
  createAlarm(name: string, when: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  createNotification(id: string, notification: ReminderNotification): Promise<void>;
}

/**
 * Owns the optional morning summary independently from the existing review reminder.
 * The port deliberately exposes counts rather than task or learning-item records so
 * notification text cannot accidentally include private content.
 */
export class DailyPlanService {
  private pendingOperation: Promise<void> = Promise.resolve();

  constructor(private readonly port: DailyPlanServicePort) {}

  reconcile(): Promise<void> {
    return this.runOperation(() => this.reconcileOnce());
  }

  handleAlarm(name: string): Promise<void> {
    if (name !== DAILY_PLAN_ALARM_NAME) return Promise.resolve();
    return this.runOperation(() => this.handleDailyPlanAlarm());
  }

  /** Sends an explicit count-only test without reading or changing real deduplication state. */
  async sendTestNotification(): Promise<void> {
    const preferences = await this.port.loadPreferences();
    const now = this.port.now();
    const [reviewCount, taskCount] = await Promise.all([
      preferences.includeReviewsInDailyPlan
        ? this.port.countDueReviews(new Date(now))
        : Promise.resolve(0),
      preferences.includeTasksInDailyPlan
        ? this.port.countRemainingTasks(new Date(now))
        : Promise.resolve(0),
    ]);
    await this.port.createNotification(DAILY_PLAN_TEST_NOTIFICATION_ID, {
      title: 'ValRecall 每日计划测试',
      message: buildDailyPlanMessage({
        reviewCount: normalizeCount(reviewCount, 'Review'),
        taskCount: normalizeCount(taskCount, 'Task'),
        includeReviews: preferences.includeReviewsInDailyPlan,
        includeTasks: preferences.includeTasksInDailyPlan,
      }),
    });
  }

  private runOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.pendingOperation.then(operation, operation);
    this.pendingOperation = result.catch(() => undefined);
    return result;
  }

  private async reconcileOnce(): Promise<void> {
    const preferences = await this.port.loadPreferences();
    if (!preferences.dailyPlanReminderEnabled) {
      await this.port.clearAlarm(DAILY_PLAN_ALARM_NAME);
      return;
    }

    const now = this.port.now();
    try {
      if (hasReachedLocalReminderTime(now, preferences.dailyPlanReminderTime)) {
        await this.evaluateCurrentLocalDay(now, preferences);
      }
    } finally {
      await this.scheduleNext(now, preferences.dailyPlanReminderTime);
    }
  }

  private async handleDailyPlanAlarm(): Promise<void> {
    if (__VALRECALL_PUBLIC_RELEASE__) await reopenDayForAlarm(this.port);
    const now = this.port.now();
    let preferences: DailyPlanPreferences | null = null;
    try {
      preferences = await this.port.loadPreferences();
      if (!preferences.dailyPlanReminderEnabled) {
        await this.port.clearAlarm(DAILY_PLAN_ALARM_NAME);
        return;
      }
      await this.evaluateCurrentLocalDay(now, preferences);
    } finally {
      if (preferences?.dailyPlanReminderEnabled) {
        await this.scheduleNext(now, preferences.dailyPlanReminderTime);
      } else if (preferences === null) {
        await this.scheduleNext(now, DEFAULT_DAILY_PLAN_PREFERENCES.dailyPlanReminderTime);
      }
    }
  }

  private async evaluateCurrentLocalDay(
    now: Date,
    preferences: DailyPlanPreferences,
  ): Promise<void> {
    const localDate = localDateKey(now);
    const state = await this.port.loadState();
    if (
      state.lastEvaluationLocalDate === localDate ||
      state.lastNotificationLocalDate === localDate
    ) {
      return;
    }

    const evaluatedState: DailyPlanState = {
      ...state,
      lastEvaluationLocalDate: localDate,
    };
    await this.port.saveState(evaluatedState);

    const [reviewCount, taskCount] = await Promise.all([
      preferences.includeReviewsInDailyPlan
        ? this.port.countDueReviews(new Date(now))
        : Promise.resolve(0),
      preferences.includeTasksInDailyPlan
        ? this.port.countRemainingTasks(new Date(now))
        : Promise.resolve(0),
    ]);
    const counts: DailyPlanCounts = {
      reviewCount: normalizeCount(reviewCount, 'Review'),
      taskCount: normalizeCount(taskCount, 'Task'),
      includeReviews: preferences.includeReviewsInDailyPlan,
      includeTasks: preferences.includeTasksInDailyPlan,
    };
    // Nothing to do, nothing to say. Today stays marked, so a later wake-up cannot surprise anyone.
    // Only the alarm at the time the user chose looks again: see reopenDayForAlarm.
    if (__VALRECALL_PUBLIC_RELEASE__ && counts.reviewCount === 0 && counts.taskCount === 0) return;

    await this.port.createNotification(DAILY_PLAN_NOTIFICATION_ID, {
      title: 'ValRecall 每日计划',
      message: buildDailyPlanMessage(counts),
    });
    await this.port.saveState({
      ...evaluatedState,
      lastNotificationLocalDate: localDate,
    });
  }

  private async scheduleNext(now: Date, reminderTime: string): Promise<void> {
    const nextOccurrence = nextLocalReminderOccurrence(now, reminderTime);
    await this.port.createAlarm(DAILY_PLAN_ALARM_NAME, nextOccurrence.getTime());
  }
}

export interface DailyPlanCounts {
  reviewCount: number;
  taskCount: number;
  includeReviews: boolean;
  includeTasks: boolean;
}

export function buildDailyPlanMessage(counts: DailyPlanCounts): string {
  const parts: string[] = [];
  if (counts.includeTasks) parts.push(`${normalizeCount(counts.taskCount, '任务')} 项任务`);
  if (counts.includeReviews) parts.push(`${normalizeCount(counts.reviewCount, '复习')} 条复习`);
  if (parts.length === 0) return '今天的每日计划已准备好。';
  return `今天有 ${parts.join('、')}等你。`;
}

export function normalizeDailyPlanPreferences(value: unknown): DailyPlanPreferences {
  if (!isRecord(value)) return { ...DEFAULT_DAILY_PLAN_PREFERENCES };
  return {
    dailyPlanReminderEnabled:
      typeof value.dailyPlanReminderEnabled === 'boolean'
        ? value.dailyPlanReminderEnabled
        : DEFAULT_DAILY_PLAN_PREFERENCES.dailyPlanReminderEnabled,
    dailyPlanReminderTime: isValidReminderTime(value.dailyPlanReminderTime)
      ? value.dailyPlanReminderTime
      : DEFAULT_DAILY_PLAN_PREFERENCES.dailyPlanReminderTime,
    includeReviewsInDailyPlan:
      typeof value.includeReviewsInDailyPlan === 'boolean'
        ? value.includeReviewsInDailyPlan
        : DEFAULT_DAILY_PLAN_PREFERENCES.includeReviewsInDailyPlan,
    includeTasksInDailyPlan:
      typeof value.includeTasksInDailyPlan === 'boolean'
        ? value.includeTasksInDailyPlan
        : DEFAULT_DAILY_PLAN_PREFERENCES.includeTasksInDailyPlan,
  };
}

export function normalizeDailyPlanState(value: unknown): DailyPlanState {
  if (!isRecord(value)) return { ...DEFAULT_DAILY_PLAN_STATE };
  return {
    lastEvaluationLocalDate: isLocalDate(value.lastEvaluationLocalDate)
      ? value.lastEvaluationLocalDate
      : null,
    lastNotificationLocalDate: isLocalDate(value.lastNotificationLocalDate)
      ? value.lastNotificationLocalDate
      : null,
  };
}

function normalizeCount(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} count must be non-negative.`);
  }
  return Math.floor(value);
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
