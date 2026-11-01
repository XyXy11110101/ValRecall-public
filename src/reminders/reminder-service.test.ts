import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_REMINDER_PREFERENCES,
  DEFAULT_REMINDER_STATE,
  dueCohortDigest,
  hasReachedLocalReminderTime,
  isWithinQuietHours,
  localDateKey,
  NEXT_REVIEW_ALARM_NAME,
  NEXT_REVIEW_NOTIFICATION_ID,
  nextLocalReminderOccurrence,
  normalizeReminderPreferences,
  normalizeReminderState,
  quietHoursEnd,
  REMINDER_ALARM_NAME,
  ReminderService,
  REVIEW_NOTIFICATION_ID,
  TEST_NOTIFICATION_ID,
  type ReminderPreferences,
  type ReminderServicePort,
  type ReminderState,
  type ReviewSchedule,
} from './reminder-service';

interface FakePort extends ReminderServicePort {
  state: ReminderState;
  preferences: ReminderPreferences;
  schedule: ReviewSchedule;
}

function entry(id: string, due: Date) {
  return { id, due: new Date(due) };
}

function createPort(
  options: {
    now?: Date;
    preferences?: Partial<ReminderPreferences>;
    state?: Partial<ReminderState>;
    schedule?: ReviewSchedule;
    alarmTime?: number | null;
  } = {},
): FakePort {
  const now = options.now ?? new Date(2026, 6, 21, 19, 30);
  const port: FakePort = {
    state: { ...DEFAULT_REMINDER_STATE, ...options.state },
    preferences: { ...DEFAULT_REMINDER_PREFERENCES, ...options.preferences },
    schedule: options.schedule ?? { due: [], future: [] },
    now: vi.fn(() => new Date(now)),
    loadPreferences: vi.fn(async () => ({ ...port.preferences })),
    loadState: vi.fn(async () => ({ ...port.state })),
    saveState: vi.fn(async (state) => {
      port.state = { ...state };
    }),
    loadReviewSchedule: vi.fn(async () => ({
      due: port.schedule.due.map((value) => entry(value.id, value.due)),
      future: port.schedule.future.map((value) => entry(value.id, value.due)),
    })),
    createAlarm: vi.fn(async () => undefined),
    clearAlarm: vi.fn(async () => undefined),
    getAlarmTime: vi.fn(async () => options.alarmTime ?? null),
    getNotificationPermission: vi.fn(async () => 'granted' as const),
    createNotification: vi.fn(async () => undefined),
  };
  return port;
}

describe('reminder preference and state guards', () => {
  it('uses every safe default for missing or invalid values', () => {
    expect(normalizeReminderPreferences(undefined)).toEqual(DEFAULT_REMINDER_PREFERENCES);
    expect(
      normalizeReminderPreferences({
        reminderEnabled: 'yes',
        reminderTime: '25:90',
        notifyOnlyWhenDue: 1,
        nextDueReminderEnabled: 'yes',
        reviewQuietHoursEnabled: 1,
        reviewQuietHoursStart: '8:00',
        reviewQuietHoursEnd: '99:00',
        groupReviewNotificationCount: 'yes',
      }),
    ).toEqual(DEFAULT_REMINDER_PREFERENCES);
  });

  it('preserves valid false values and validates legacy plus cohort state', () => {
    expect(
      normalizeReminderPreferences({
        reminderEnabled: false,
        reminderTime: '07:05',
        notifyOnlyWhenDue: false,
        nextDueReminderEnabled: false,
        reviewQuietHoursEnabled: true,
        reviewQuietHoursStart: '21:30',
        reviewQuietHoursEnd: '07:15',
        groupReviewNotificationCount: false,
      }),
    ).toEqual({
      reminderEnabled: false,
      reminderTime: '07:05',
      notifyOnlyWhenDue: false,
      nextDueReminderEnabled: false,
      reviewQuietHoursEnabled: true,
      reviewQuietHoursStart: '21:30',
      reviewQuietHoursEnd: '07:15',
      groupReviewNotificationCount: false,
    });
    expect(
      normalizeReminderState({
        lastEvaluationLocalDate: '2026-02-30',
        lastNotificationLocalDate: '2026-07-21',
        lastDueCohortDigest: 'v1-12ab34cd',
        lastNextNotificationAt: '2026-07-21T20:00:00.000Z',
      }),
    ).toEqual({
      lastEvaluationLocalDate: null,
      lastNotificationLocalDate: '2026-07-21',
      lastDueCohortDigest: 'v1-12ab34cd',
      lastNextNotificationAt: '2026-07-21T20:00:00.000Z',
    });
  });
});

describe('local reminder and quiet-hour calculations', () => {
  it('uses local wall-clock dates instead of adding 24 hours', () => {
    const before = new Date(2026, 6, 21, 19, 30);
    const after = new Date(2026, 6, 21, 20, 1);
    expect(nextLocalReminderOccurrence(before, '20:00')).toEqual(new Date(2026, 6, 21, 20, 0));
    expect(nextLocalReminderOccurrence(after, '20:00')).toEqual(new Date(2026, 6, 22, 20, 0));
    expect(hasReachedLocalReminderTime(before, '20:00')).toBe(false);
    expect(hasReachedLocalReminderTime(after, '20:00')).toBe(true);
    expect(localDateKey(after)).toBe('2026-07-21');
  });

  it('defers an overnight quiet-hour instant to the next local end', () => {
    const preferences = {
      reviewQuietHoursEnabled: true,
      reviewQuietHoursStart: '22:00',
      reviewQuietHoursEnd: '08:00',
    };
    const late = new Date(2026, 6, 21, 23, 30);
    const morning = new Date(2026, 6, 22, 7, 30);
    expect(isWithinQuietHours(late, preferences)).toBe(true);
    expect(isWithinQuietHours(morning, preferences)).toBe(true);
    expect(quietHoursEnd(late, preferences)).toEqual(new Date(2026, 6, 22, 8, 0));
    expect(quietHoursEnd(morning, preferences)).toEqual(new Date(2026, 6, 22, 8, 0));
  });
});

describe('ReminderService daily reminder compatibility', () => {
  it('clears the daily alarm when disabled', async () => {
    const port = createPort({
      preferences: { reminderEnabled: false, nextDueReminderEnabled: false },
    });
    await new ReminderService(port).reconcile();
    expect(port.clearAlarm).toHaveBeenCalledWith(REMINDER_ALARM_NAME);
    expect(port.clearAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME);
    expect(port.loadReviewSchedule).not.toHaveBeenCalled();
  });

  it('notifies at the daily time and schedules tomorrow', async () => {
    const now = new Date(2026, 6, 21, 21, 15);
    const port = createPort({
      now,
      preferences: { nextDueReminderEnabled: false },
      schedule: { due: [entry('a', new Date(2026, 6, 21, 20, 0))], future: [] },
    });
    await new ReminderService(port).reconcile();
    expect(port.createNotification).toHaveBeenCalledWith(REVIEW_NOTIFICATION_ID, {
      title: 'ValRecall 复习',
      message: '今天有 1 条学习内容到期。',
      buttons: ['开始复习'],
    });
    expect(port.createAlarm).toHaveBeenCalledWith(
      REMINDER_ALARM_NAME,
      new Date(2026, 6, 22, 20, 0).getTime(),
    );
  });

  it('does not duplicate a cohort already announced by next-due', async () => {
    const due = [entry('a', new Date(2026, 6, 21, 18, 0))];
    const port = createPort({
      now: new Date(2026, 6, 21, 19, 0),
      preferences: { reminderEnabled: false },
      schedule: { due, future: [] },
    });
    const service = new ReminderService(port);
    await service.reconcile();
    port.preferences = {
      ...port.preferences,
      reminderEnabled: true,
      reminderTime: '20:00',
    };
    vi.mocked(port.now).mockReturnValue(new Date(2026, 6, 21, 20, 0));
    await service.handleAlarm(REMINDER_ALARM_NAME);
    expect(port.createNotification).toHaveBeenCalledTimes(1);
    expect(port.createNotification).toHaveBeenCalledWith(
      NEXT_REVIEW_NOTIFICATION_ID,
      expect.any(Object),
    );
  });
});

describe('ReminderService next-due scheduling and notification', () => {
  it('clears/replaces one named alarm with the earliest active future due', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const earliest = new Date('2026-07-21T12:10:00.123Z');
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: {
        due: [],
        future: [entry('later', new Date('2026-07-22T12:00:00Z')), entry('first', earliest)],
      },
    });
    await new ReminderService(port).reconcile();
    expect(port.clearAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME);
    expect(port.createAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME, earliest.getTime());
    expect(
      vi.mocked(port.createAlarm).mock.calls.filter(([name]) => name === NEXT_REVIEW_ALARM_NAME),
    ).toHaveLength(1);
  });

  it('leaves no next-due alarm when no active cards exist', async () => {
    const port = createPort({ preferences: { reminderEnabled: false } });
    await new ReminderService(port).reconcile();
    expect(port.clearAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME);
    expect(port.createAlarm).not.toHaveBeenCalled();
  });

  it.each([
    [1, '1 条学习 Moment 已准备好复习。'],
    [3, '3 条学习 Moment 已准备好复习。'],
  ])('creates one privacy-safe grouped notification for %s due items', async (count, message) => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const due = Array.from({ length: count }, (_, index) =>
      entry(`private-id-${index}`, new Date(now.getTime() - index)),
    );
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: { due, future: [] },
    });
    await new ReminderService(port).reconcile();
    expect(port.createNotification).toHaveBeenCalledOnce();
    expect(port.createNotification).toHaveBeenCalledWith(NEXT_REVIEW_NOTIFICATION_ID, {
      title: 'ValRecall 复习已就绪',
      message,
      buttons: ['开始复习'],
    });
    const serialized = JSON.stringify(vi.mocked(port.createNotification).mock.calls);
    expect(serialized).not.toContain('private-id');
    expect(serialized).not.toContain('question');
    expect(serialized).not.toContain('answer');
  });

  it('deduplicates restarts but announces a materially new due cohort', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: { due: [entry('a', now)], future: [] },
    });
    const firstWorker = new ReminderService(port);
    await firstWorker.reconcile();
    await new ReminderService(port).reconcile();
    expect(port.createNotification).toHaveBeenCalledTimes(1);

    port.schedule = {
      due: [entry('a', now), entry('b', now)],
      future: [],
    };
    await new ReminderService(port).reconcile();
    expect(port.createNotification).toHaveBeenCalledTimes(2);
  });

  it('does not create an overdue alarm loop and schedules the next future cohort', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const future = new Date('2026-07-21T12:10:00.000Z');
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: {
        due: [entry('old', new Date(now.getTime() - 60_000))],
        future: [entry('future', future)],
      },
    });
    await new ReminderService(port).handleAlarm(NEXT_REVIEW_ALARM_NAME);
    expect(port.createAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME, future.getTime());
    const nextCalls = vi
      .mocked(port.createAlarm)
      .mock.calls.filter(([name]) => name === NEXT_REVIEW_ALARM_NAME);
    expect(nextCalls).toEqual([[NEXT_REVIEW_ALARM_NAME, future.getTime()]]);
  });

  it('suppresses next-due work when disabled', async () => {
    const port = createPort({
      preferences: { reminderEnabled: false, nextDueReminderEnabled: false },
      schedule: { due: [entry('a', new Date())], future: [] },
    });
    await new ReminderService(port).reconcile();
    expect(port.loadReviewSchedule).not.toHaveBeenCalled();
    expect(port.createNotification).not.toHaveBeenCalled();
  });

  it('defers due notification during quiet hours without polling', async () => {
    const now = new Date(2026, 6, 21, 23, 30);
    const port = createPort({
      now,
      preferences: {
        reminderEnabled: false,
        reviewQuietHoursEnabled: true,
        reviewQuietHoursStart: '22:00',
        reviewQuietHoursEnd: '08:00',
      },
      schedule: { due: [entry('a', now)], future: [] },
    });
    await new ReminderService(port).reconcile();
    expect(port.createNotification).not.toHaveBeenCalled();
    expect(port.createAlarm).toHaveBeenCalledWith(
      NEXT_REVIEW_ALARM_NAME,
      new Date(2026, 6, 22, 8, 0).getTime(),
    );
    expect(port.loadReviewSchedule).toHaveBeenCalledOnce();
  });

  it('supports a count-hidden grouped notification without per-card alerts', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const port = createPort({
      now,
      preferences: {
        reminderEnabled: false,
        groupReviewNotificationCount: false,
      },
      schedule: { due: [entry('a', now), entry('b', now)], future: [] },
    });
    await new ReminderService(port).reconcile();
    expect(port.createNotification).toHaveBeenCalledWith(
      NEXT_REVIEW_NOTIFICATION_ID,
      expect.objectContaining({ message: '学习 Moment 已准备好复习。' }),
    );
    expect(port.createNotification).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent startup checks into one notification', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: { due: [entry('a', now)], future: [] },
    });
    let releaseFirstRead!: () => void;
    vi.mocked(port.loadState).mockImplementationOnce(
      () =>
        new Promise<ReminderState>((resolve) => {
          releaseFirstRead = () => resolve({ ...port.state });
        }),
    );
    const service = new ReminderService(port);
    const worker = service.reconcile();
    const startup = service.reconcile();
    await vi.waitFor(() => expect(port.loadState).toHaveBeenCalledTimes(1));
    releaseFirstRead();
    await Promise.all([worker, startup]);
    expect(port.createNotification).toHaveBeenCalledTimes(1);
  });

  it('clears an old digest after the due count returns to zero', async () => {
    const due = entry('a', new Date('2026-07-21T11:00:00.000Z'));
    const port = createPort({
      preferences: { reminderEnabled: false },
      state: { lastDueCohortDigest: dueCohortDigest([due]) },
    });
    await new ReminderService(port).reconcile();
    expect(port.state.lastDueCohortDigest).toBeNull();
  });

  it('replaces the next alarm after a successful rating moves a due card to the future', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const nextDue = new Date('2026-07-21T12:10:00.123Z');
    const port = createPort({
      now,
      preferences: { reminderEnabled: false },
      schedule: { due: [entry('rated', now)], future: [] },
    });
    const service = new ReminderService(port);
    await service.reconcile();
    port.schedule = { due: [], future: [entry('rated', nextDue)] };

    await service.reconcile();

    expect(port.state.lastDueCohortDigest).toBeNull();
    expect(port.createAlarm).toHaveBeenLastCalledWith(NEXT_REVIEW_ALARM_NAME, nextDue.getTime());
  });

  it('reports next alarm and notification permission without touching cards', async () => {
    const alarmTime = new Date('2026-07-21T12:10:00.000Z').getTime();
    const port = createPort({ alarmTime });
    await expect(new ReminderService(port).getStatus()).resolves.toEqual({
      nextReviewReminderAt: '2026-07-21T12:10:00.000Z',
      notificationPermission: 'granted',
    });
    expect(port.loadReviewSchedule).not.toHaveBeenCalled();
  });

  it('uses a separate test notification and ignores unrelated alarms', async () => {
    const port = createPort();
    const service = new ReminderService(port);
    await service.sendTestNotification();
    await service.handleAlarm('another-extension-alarm');
    expect(port.createNotification).toHaveBeenCalledWith(TEST_NOTIFICATION_ID, {
      title: 'ValRecall 提醒测试',
      message: '点击开始复习。',
      buttons: ['开始复习'],
    });
    expect(port.loadPreferences).not.toHaveBeenCalled();
  });
});
