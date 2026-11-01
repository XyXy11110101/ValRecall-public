export const REMINDER_ALARM_NAME = 'valrecall.daily-review';
export const NEXT_REVIEW_ALARM_NAME = 'valrecall-next-review';
export const REVIEW_NOTIFICATION_ID = 'valrecall.review-reminder';
export const NEXT_REVIEW_NOTIFICATION_ID = 'valrecall.next-review';
export const TEST_NOTIFICATION_ID = 'valrecall.review-reminder-test';

export interface ReminderPreferences {
  reminderEnabled: boolean;
  reminderTime: string;
  notifyOnlyWhenDue: boolean;
  nextDueReminderEnabled: boolean;
  reviewQuietHoursEnabled: boolean;
  reviewQuietHoursStart: string;
  reviewQuietHoursEnd: string;
  groupReviewNotificationCount: boolean;
}

export interface ReminderState {
  lastEvaluationLocalDate: string | null;
  lastNotificationLocalDate: string | null;
  lastDueCohortDigest: string | null;
  lastNextNotificationAt: string | null;
}

export const DEFAULT_REMINDER_PREFERENCES: Readonly<ReminderPreferences> = Object.freeze({
  reminderEnabled: true,
  reminderTime: '20:00',
  notifyOnlyWhenDue: true,
  nextDueReminderEnabled: true,
  reviewQuietHoursEnabled: false,
  reviewQuietHoursStart: '22:00',
  reviewQuietHoursEnd: '08:00',
  groupReviewNotificationCount: true,
});

export const DEFAULT_REMINDER_STATE: Readonly<ReminderState> = Object.freeze({
  lastEvaluationLocalDate: null,
  lastNotificationLocalDate: null,
  lastDueCohortDigest: null,
  lastNextNotificationAt: null,
});

export interface ReminderNotification {
  title: string;
  message: string;
  buttons?: readonly string[];
}

export interface ReviewScheduleEntry {
  id: string;
  due: Date;
}

export interface ReviewSchedule {
  due: ReviewScheduleEntry[];
  future: ReviewScheduleEntry[];
}

export type NotificationPermissionState = 'granted' | 'denied' | 'unavailable';

export interface ReminderStatus {
  nextReviewReminderAt: string | null;
  notificationPermission: NotificationPermissionState;
}

export interface ReminderServicePort {
  now(): Date;
  loadPreferences(): Promise<ReminderPreferences>;
  loadState(): Promise<ReminderState>;
  saveState(state: ReminderState): Promise<void>;
  loadReviewSchedule(now: Date): Promise<ReviewSchedule>;
  createAlarm(name: string, when: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  getAlarmTime(name: string): Promise<number | null>;
  getNotificationPermission(): Promise<NotificationPermissionState>;
  createNotification(id: string, notification: ReminderNotification): Promise<void>;
}

/**
 * Coordinates both review reminder channels. The daily wall-clock reminder and the
 * earliest-FSRS-due reminder share one serialized operation and one due-cohort
 * digest, so they cannot compete by repeatedly notifying for the same unchanged set.
 */
export class ReminderService {
  private pendingRealReminderOperation: Promise<void> = Promise.resolve();

  constructor(private readonly port: ReminderServicePort) {}

  reconcile(): Promise<void> {
    return this.runRealReminderOperation(() => this.reconcileOnce());
  }

  handleAlarm(name: string): Promise<void> {
    if (name !== REMINDER_ALARM_NAME && name !== NEXT_REVIEW_ALARM_NAME) {
      return Promise.resolve();
    }
    return this.runRealReminderOperation(async () => {
      const preferences = await this.port.loadPreferences();
      const now = this.port.now();
      if (name === REMINDER_ALARM_NAME) {
        await this.reconcileDailyReminder(now, preferences);
      } else {
        await this.reconcileNextDueReminder(now, preferences);
      }
    });
  }

  async getStatus(): Promise<ReminderStatus> {
    const [alarmTime, notificationPermission] = await Promise.all([
      this.port.getAlarmTime(NEXT_REVIEW_ALARM_NAME),
      this.port.getNotificationPermission(),
    ]);
    return {
      nextReviewReminderAt:
        alarmTime === null || !Number.isFinite(alarmTime)
          ? null
          : new Date(alarmTime).toISOString(),
      notificationPermission,
    };
  }

  async sendTestNotification(): Promise<void> {
    await this.port.createNotification(TEST_NOTIFICATION_ID, {
      title: 'ValRecall 提醒测试',
      message: '点击开始复习。',
      buttons: ['开始复习'],
    });
  }

  private async reconcileOnce(): Promise<void> {
    const preferences = await this.port.loadPreferences();
    const now = this.port.now();
    await this.reconcileDailyReminder(now, preferences);
    await this.reconcileNextDueReminder(now, preferences);
  }

  private async reconcileDailyReminder(now: Date, preferences: ReminderPreferences): Promise<void> {
    if (!preferences.reminderEnabled) {
      await this.port.clearAlarm(REMINDER_ALARM_NAME);
      return;
    }

    try {
      if (hasReachedLocalReminderTime(now, preferences.reminderTime)) {
        await this.evaluateCurrentLocalDay(now, preferences);
      }
    } finally {
      await this.scheduleDailyNext(now, preferences.reminderTime);
    }
  }

  private async evaluateCurrentLocalDay(
    now: Date,
    preferences: ReminderPreferences,
  ): Promise<void> {
    const localDate = localDateKey(now);
    const state = await this.port.loadState();
    if (
      state.lastEvaluationLocalDate === localDate ||
      state.lastNotificationLocalDate === localDate
    ) {
      return;
    }

    const evaluatedState: ReminderState = {
      ...state,
      lastEvaluationLocalDate: localDate,
    };
    await this.port.saveState(evaluatedState);

    const schedule = normalizeReviewSchedule(
      await this.port.loadReviewSchedule(new Date(now)),
      now,
    );
    const dueCount = schedule.due.length;
    if (preferences.notifyOnlyWhenDue && dueCount === 0) return;

    const digest = dueCount > 0 ? dueCohortDigest(schedule.due) : null;
    if (digest !== null && digest === evaluatedState.lastDueCohortDigest) return;

    const notifiedState: ReminderState = {
      ...evaluatedState,
      lastNotificationLocalDate: localDate,
      lastDueCohortDigest: digest ?? evaluatedState.lastDueCohortDigest,
    };
    // Persist before browser notification creation so a transient notification
    // failure cannot create a restart notification loop.
    await this.port.saveState(notifiedState);
    await this.port.createNotification(REVIEW_NOTIFICATION_ID, {
      title: 'ValRecall 复习',
      message: `今天有 ${dueCount} 条学习内容到期。`,
      buttons: ['开始复习'],
    });
  }

  private async reconcileNextDueReminder(
    now: Date,
    preferences: ReminderPreferences,
  ): Promise<void> {
    await this.port.clearAlarm(NEXT_REVIEW_ALARM_NAME);
    if (!preferences.nextDueReminderEnabled) return;

    const schedule = normalizeReviewSchedule(
      await this.port.loadReviewSchedule(new Date(now)),
      now,
    );
    const state = await this.port.loadState();

    if (schedule.due.length === 0) {
      if (state.lastDueCohortDigest !== null) {
        await this.port.saveState({
          ...state,
          lastDueCohortDigest: null,
        });
      }
      await this.scheduleEarliestFuture(schedule.future, preferences);
      return;
    }

    if (isWithinQuietHours(now, preferences)) {
      await this.port.createAlarm(
        NEXT_REVIEW_ALARM_NAME,
        quietHoursEnd(now, preferences).getTime(),
      );
      return;
    }

    const digest = dueCohortDigest(schedule.due);
    if (digest !== state.lastDueCohortDigest) {
      const notificationTime = now.toISOString();
      await this.port.saveState({
        ...state,
        lastDueCohortDigest: digest,
        lastNextNotificationAt: notificationTime,
      });
      await this.port.createNotification(NEXT_REVIEW_NOTIFICATION_ID, {
        title: 'ValRecall 复习已就绪',
        message: preferences.groupReviewNotificationCount
          ? groupedReviewMessage(schedule.due.length)
          : '学习 Moment 已准备好复习。',
        buttons: ['开始复习'],
      });
    }

    await this.scheduleEarliestFuture(schedule.future, preferences);
  }

  private async scheduleEarliestFuture(
    future: readonly ReviewScheduleEntry[],
    preferences: ReminderPreferences,
  ): Promise<void> {
    const earliest = future[0];
    if (!earliest) return;
    const requested = isWithinQuietHours(earliest.due, preferences)
      ? quietHoursEnd(earliest.due, preferences)
      : earliest.due;
    await this.port.createAlarm(NEXT_REVIEW_ALARM_NAME, requested.getTime());
  }

  private runRealReminderOperation(operation: () => Promise<void>): Promise<void> {
    const result = this.pendingRealReminderOperation.then(operation, operation);
    this.pendingRealReminderOperation = result.catch(() => undefined);
    return result;
  }

  private async scheduleDailyNext(now: Date, reminderTime: string): Promise<void> {
    const nextOccurrence = nextLocalReminderOccurrence(now, reminderTime);
    await this.port.createAlarm(REMINDER_ALARM_NAME, nextOccurrence.getTime());
  }
}

export function normalizeReminderPreferences(value: unknown): ReminderPreferences {
  if (!isRecord(value)) return { ...DEFAULT_REMINDER_PREFERENCES };
  return {
    reminderEnabled:
      typeof value.reminderEnabled === 'boolean'
        ? value.reminderEnabled
        : DEFAULT_REMINDER_PREFERENCES.reminderEnabled,
    reminderTime: isValidReminderTime(value.reminderTime)
      ? value.reminderTime
      : DEFAULT_REMINDER_PREFERENCES.reminderTime,
    notifyOnlyWhenDue:
      typeof value.notifyOnlyWhenDue === 'boolean'
        ? value.notifyOnlyWhenDue
        : DEFAULT_REMINDER_PREFERENCES.notifyOnlyWhenDue,
    nextDueReminderEnabled:
      typeof value.nextDueReminderEnabled === 'boolean'
        ? value.nextDueReminderEnabled
        : DEFAULT_REMINDER_PREFERENCES.nextDueReminderEnabled,
    reviewQuietHoursEnabled:
      typeof value.reviewQuietHoursEnabled === 'boolean'
        ? value.reviewQuietHoursEnabled
        : DEFAULT_REMINDER_PREFERENCES.reviewQuietHoursEnabled,
    reviewQuietHoursStart: isValidReminderTime(value.reviewQuietHoursStart)
      ? value.reviewQuietHoursStart
      : DEFAULT_REMINDER_PREFERENCES.reviewQuietHoursStart,
    reviewQuietHoursEnd: isValidReminderTime(value.reviewQuietHoursEnd)
      ? value.reviewQuietHoursEnd
      : DEFAULT_REMINDER_PREFERENCES.reviewQuietHoursEnd,
    groupReviewNotificationCount:
      typeof value.groupReviewNotificationCount === 'boolean'
        ? value.groupReviewNotificationCount
        : DEFAULT_REMINDER_PREFERENCES.groupReviewNotificationCount,
  };
}

export function normalizeReminderState(value: unknown): ReminderState {
  if (!isRecord(value)) return { ...DEFAULT_REMINDER_STATE };
  return {
    lastEvaluationLocalDate: isLocalDateKey(value.lastEvaluationLocalDate)
      ? value.lastEvaluationLocalDate
      : null,
    lastNotificationLocalDate: isLocalDateKey(value.lastNotificationLocalDate)
      ? value.lastNotificationLocalDate
      : null,
    lastDueCohortDigest:
      typeof value.lastDueCohortDigest === 'string' &&
      /^v1-[0-9a-f]{8}$/.test(value.lastDueCohortDigest)
        ? value.lastDueCohortDigest
        : null,
    lastNextNotificationAt: isIsoDate(value.lastNextNotificationAt)
      ? new Date(value.lastNextNotificationAt).toISOString()
      : null,
  };
}

export function dueCohortDigest(entries: readonly ReviewScheduleEntry[]): string {
  const source = [...entries]
    .sort(
      (left, right) => left.due.getTime() - right.due.getTime() || left.id.localeCompare(right.id),
    )
    .map((entry) => `${entry.id}\u0000${entry.due.getTime()}`)
    .join('\u0001');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function isWithinQuietHours(
  date: Date,
  preferences: Pick<
    ReminderPreferences,
    'reviewQuietHoursEnabled' | 'reviewQuietHoursStart' | 'reviewQuietHoursEnd'
  >,
): boolean {
  if (!preferences.reviewQuietHoursEnabled) return false;
  const start = minutesSinceMidnight(preferences.reviewQuietHoursStart);
  const end = minutesSinceMidnight(preferences.reviewQuietHoursEnd);
  if (start === end) return false;
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function quietHoursEnd(
  date: Date,
  preferences: Pick<ReminderPreferences, 'reviewQuietHoursStart' | 'reviewQuietHoursEnd'>,
): Date {
  const start = minutesSinceMidnight(preferences.reviewQuietHoursStart);
  const end = minutesSinceMidnight(preferences.reviewQuietHoursEnd);
  const [endHours, endMinutes] = parseReminderTime(preferences.reviewQuietHoursEnd);
  const result = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    endHours,
    endMinutes,
    0,
    0,
  );
  const current = date.getHours() * 60 + date.getMinutes();
  if ((start > end && current >= start) || result.getTime() <= date.getTime()) {
    result.setDate(result.getDate() + 1);
  }
  return result;
}

export function isValidReminderTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hoursText, minutesText] = value.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function hasReachedLocalReminderTime(now: Date, reminderTime: string): boolean {
  return localReminderOccurrence(now, reminderTime).getTime() <= now.getTime();
}

export function nextLocalReminderOccurrence(now: Date, reminderTime: string): Date {
  const candidate = localReminderOccurrence(now, reminderTime);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function normalizeReviewSchedule(value: ReviewSchedule, now: Date): ReviewSchedule {
  const nowTime = now.getTime();
  const entries = [...value.due, ...value.future]
    .map((entry) => {
      if (
        typeof entry.id !== 'string' ||
        entry.id.length === 0 ||
        !(entry.due instanceof Date) ||
        Number.isNaN(entry.due.getTime())
      ) {
        throw new Error('Review schedule entries must contain an ID and valid due Date.');
      }
      return { id: entry.id, due: new Date(entry.due) };
    })
    .sort(
      (left, right) => left.due.getTime() - right.due.getTime() || left.id.localeCompare(right.id),
    );
  return {
    due: entries.filter((entry) => entry.due.getTime() <= nowTime),
    future: entries.filter((entry) => entry.due.getTime() > nowTime),
  };
}

function groupedReviewMessage(count: number): string {
  return `${count} 条学习 Moment 已准备好复习。`;
}

function localReminderOccurrence(now: Date, reminderTime: string): Date {
  const [hours, minutes] = parseReminderTime(reminderTime);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
}

function parseReminderTime(value: string): [number, number] {
  if (!isValidReminderTime(value)) {
    throw new Error(`Invalid local reminder time: ${value}`);
  }
  const [hoursText, minutesText] = value.split(':');
  return [Number(hoursText), Number(minutesText)];
}

function minutesSinceMidnight(value: string): number {
  const [hours, minutes] = parseReminderTime(value);
  return hours * 60 + minutes;
}

function isLocalDateKey(value: unknown): value is string {
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

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
