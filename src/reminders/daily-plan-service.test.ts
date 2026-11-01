import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildDailyPlanMessage,
  DAILY_PLAN_ALARM_NAME,
  DAILY_PLAN_NOTIFICATION_ID,
  DAILY_PLAN_TEST_NOTIFICATION_ID,
  DailyPlanService,
  DEFAULT_DAILY_PLAN_PREFERENCES,
  DEFAULT_DAILY_PLAN_STATE,
  normalizeDailyPlanPreferences,
  normalizeDailyPlanState,
  type DailyPlanPreferences,
  type DailyPlanServicePort,
  type DailyPlanState,
} from './daily-plan-service';

function createPort(overrides: Partial<DailyPlanServicePort> = {}): DailyPlanServicePort {
  const preferences: DailyPlanPreferences = { ...DEFAULT_DAILY_PLAN_PREFERENCES };
  let state: DailyPlanState = { ...DEFAULT_DAILY_PLAN_STATE };
  return {
    now: () => new Date(2026, 6, 22, 9, 0),
    loadPreferences: async () => preferences,
    loadState: async () => state,
    saveState: async (next) => {
      state = next;
    },
    countDueReviews: async () => 7,
    countRemainingTasks: async () => 4,
    createAlarm: async () => undefined,
    clearAlarm: async () => undefined,
    createNotification: async () => undefined,
    ...overrides,
  };
}

describe('DailyPlanService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses isolated identifiers and creates a privacy-safe count-only notification', async () => {
    const createNotification = vi.fn<DailyPlanServicePort['createNotification']>(
      async () => undefined,
    );
    const createAlarm = vi.fn<DailyPlanServicePort['createAlarm']>(async () => undefined);
    const service = new DailyPlanService(createPort({ createNotification, createAlarm }));

    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);

    expect(createNotification).toHaveBeenCalledWith(DAILY_PLAN_NOTIFICATION_ID, {
      title: 'ValRecall 每日计划',
      message: '今天有 4 项任务、7 条复习等你。',
    });
    const notification = createNotification.mock.calls[0]?.[1];
    expect(Object.keys(notification ?? {}).sort()).toEqual(['message', 'title']);
    expect(JSON.stringify(notification)).not.toMatch(/notes|subtitle|https?:\/\//i);
    expect(createAlarm).toHaveBeenCalledWith(
      DAILY_PLAN_ALARM_NAME,
      new Date(2026, 6, 23, 9, 0).getTime(),
    );
  });

  it('does nothing for unrelated alarms', async () => {
    const createNotification = vi.fn(async () => undefined);
    await new DailyPlanService(createPort({ createNotification })).handleAlarm(
      'valrecall.daily-review',
    );
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('sends an isolated count-only test without changing alarm or deduplication state', async () => {
    const loadState = vi.fn(async () => ({ ...DEFAULT_DAILY_PLAN_STATE }));
    const saveState = vi.fn(async () => undefined);
    const createAlarm = vi.fn(async () => undefined);
    const createNotification = vi.fn(async () => undefined);
    const service = new DailyPlanService(
      createPort({ loadState, saveState, createAlarm, createNotification }),
    );

    await service.sendTestNotification();

    expect(createNotification).toHaveBeenCalledWith(DAILY_PLAN_TEST_NOTIFICATION_ID, {
      title: 'ValRecall 每日计划测试',
      message: '今天有 4 项任务、7 条复习等你。',
    });
    expect(loadState).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(createAlarm).not.toHaveBeenCalled();
  });

  it('prevents duplicate same-day notifications, including concurrent evaluations', async () => {
    const createNotification = vi.fn(async () => undefined);
    const service = new DailyPlanService(createPort({ createNotification }));

    await Promise.all([service.reconcile(), service.reconcile(), service.reconcile()]);

    expect(createNotification).toHaveBeenCalledOnce();
  });

  it('does not query an excluded source and preserves explicit false settings', async () => {
    const countDueReviews = vi.fn(async () => 9);
    const countRemainingTasks = vi.fn(async () => 1);
    const createNotification = vi.fn(async () => undefined);
    const preferences: DailyPlanPreferences = {
      dailyPlanReminderEnabled: true,
      dailyPlanReminderTime: '09:00',
      includeReviewsInDailyPlan: false,
      includeTasksInDailyPlan: true,
    };
    const service = new DailyPlanService(
      createPort({
        loadPreferences: async () => preferences,
        countDueReviews,
        countRemainingTasks,
        createNotification,
      }),
    );

    await service.reconcile();

    expect(countDueReviews).not.toHaveBeenCalled();
    expect(countRemainingTasks).toHaveBeenCalledOnce();
    expect(createNotification).toHaveBeenCalledWith(
      DAILY_PLAN_NOTIFICATION_ID,
      expect.objectContaining({ message: '今天有 1 项任务等你。' }),
    );
    expect(normalizeDailyPlanPreferences(preferences)).toEqual(preferences);
  });

  it('clears its own alarm when disabled without touching the review alarm', async () => {
    const clearAlarm = vi.fn(async () => undefined);
    const createNotification = vi.fn(async () => undefined);
    await new DailyPlanService(
      createPort({
        loadPreferences: async () => ({
          ...DEFAULT_DAILY_PLAN_PREFERENCES,
          dailyPlanReminderEnabled: false,
        }),
        clearAlarm,
        createNotification,
      }),
    ).reconcile();

    expect(clearAlarm).toHaveBeenCalledWith(DAILY_PLAN_ALARM_NAME);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('reschedules after a count or notification failure', async () => {
    const createAlarm = vi.fn<DailyPlanServicePort['createAlarm']>(async () => undefined);
    const service = new DailyPlanService(
      createPort({
        countRemainingTasks: async () => {
          throw new Error('database unavailable');
        },
        createAlarm,
      }),
    );

    await expect(service.handleAlarm(DAILY_PLAN_ALARM_NAME)).rejects.toThrow(
      'database unavailable',
    );
    expect(createAlarm).toHaveBeenCalledOnce();
  });

  it('schedules the next local wall-clock occurrence across DST-sensitive dates', async () => {
    const now = new Date(2026, 2, 28, 23, 0);
    const createAlarm = vi.fn<DailyPlanServicePort['createAlarm']>(async () => undefined);
    await new DailyPlanService(createPort({ now: () => now, createAlarm })).reconcile();

    const scheduled = new Date(createAlarm.mock.calls[0]?.[1] ?? 0);
    expect(scheduled.getFullYear()).toBe(2026);
    expect(scheduled.getMonth()).toBe(2);
    expect(scheduled.getDate()).toBe(29);
    expect(scheduled.getHours()).toBe(9);
    expect(scheduled.getMinutes()).toBe(0);
  });
});

/** A port with a clock, a reminder time and counts a test can change as the day goes on. */
function dayPort(state: DailyPlanState = { ...DEFAULT_DAILY_PLAN_STATE }) {
  const day = {
    hour: 10,
    minute: 0,
    time: '09:00',
    enabled: true,
    tasks: 0,
    reviews: 0,
    state,
  };
  const createNotification = vi.fn<DailyPlanServicePort['createNotification']>(
    async () => undefined,
  );
  const createAlarm = vi.fn<DailyPlanServicePort['createAlarm']>(async () => undefined);
  const saveState = vi.fn(async (next: DailyPlanState) => {
    day.state = next;
  });
  const service = new DailyPlanService(
    createPort({
      now: () => new Date(2026, 6, 22, day.hour, day.minute),
      loadPreferences: async () => ({
        ...DEFAULT_DAILY_PLAN_PREFERENCES,
        dailyPlanReminderEnabled: day.enabled,
        dailyPlanReminderTime: day.time,
      }),
      loadState: async () => day.state,
      saveState,
      countDueReviews: async () => day.reviews,
      countRemainingTasks: async () => day.tasks,
      createAlarm,
      createNotification,
    }),
  );
  return { day, service, createNotification, createAlarm, saveState };
}

describe('Daily Plan through a day, public edition', () => {
  beforeEach(() => vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true));
  afterEach(() => vi.unstubAllGlobals());

  it('stays quiet when a first task follows a passed reminder time', async () => {
    const { day, service, createNotification } = dayPort();
    await service.reconcile();
    day.tasks = 1;
    day.minute = 5;
    await service.reconcile();
    await service.reconcile();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('fires once at a time moved later, after 0/0 and then tasks', async () => {
    const { day, service, createNotification, createAlarm } = dayPort();
    await service.reconcile();
    day.tasks = 2;
    day.time = '20:00';
    await service.reconcile();
    expect(createNotification).not.toHaveBeenCalled();
    expect(createAlarm).toHaveBeenLastCalledWith(
      DAILY_PLAN_ALARM_NAME,
      new Date(2026, 6, 22, 20, 0).getTime(),
    );

    day.hour = 20;
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(createNotification).toHaveBeenCalledOnce();
    expect(createNotification.mock.calls[0]?.[1].message).toBe('今天有 2 项任务、0 条复习等你。');
    expect(createAlarm).toHaveBeenLastCalledWith(
      DAILY_PLAN_ALARM_NAME,
      new Date(2026, 6, 23, 20, 0).getTime(),
    );
  });

  it('never sends twice in a day, however it is evaluated', async () => {
    const { day, service, createNotification } = dayPort();
    day.tasks = 1;
    await service.reconcile();
    await service.reconcile();
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    day.time = '21:00';
    await service.reconcile();
    day.hour = 21;
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    await service.reconcile();
    expect(createNotification).toHaveBeenCalledOnce();
  });

  it('stays quiet at the moved time if there is still nothing, and after it', async () => {
    const { day, service, createNotification } = dayPort();
    await service.reconcile();
    day.time = '20:00';
    day.hour = 20;
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(createNotification).not.toHaveBeenCalled();
    expect(day.state.lastEvaluationLocalDate).toBe('2026-07-22');
    day.tasks = 1;
    day.minute = 1;
    await service.reconcile();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not fire at once when the time moves to one already passed', async () => {
    const { day, service, createNotification, createAlarm } = dayPort();
    await service.reconcile();
    day.tasks = 1;
    day.time = '09:30';
    await service.reconcile();
    expect(createNotification).not.toHaveBeenCalled();
    expect(createAlarm).toHaveBeenLastCalledWith(
      DAILY_PLAN_ALARM_NAME,
      new Date(2026, 6, 23, 9, 30).getTime(),
    );
  });

  it('leaves the mark alone when an alarm fires while the reminder is off', async () => {
    const { day, service, createNotification } = dayPort();
    await service.reconcile();
    day.enabled = false;
    day.tasks = 1;
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(day.state.lastEvaluationLocalDate).toBe('2026-07-22');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('still schedules the next alarm when today cannot be looked at again', async () => {
    const { day, service, createNotification, createAlarm, saveState } = dayPort();
    await service.reconcile();
    day.tasks = 1;
    day.hour = 20;
    day.time = '20:00';
    saveState.mockRejectedValueOnce(new Error('quota'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(warn).toHaveBeenCalledOnce();
    expect(createNotification).not.toHaveBeenCalled();
    expect(createAlarm).toHaveBeenLastCalledWith(
      DAILY_PLAN_ALARM_NAME,
      new Date(2026, 6, 23, 20, 0).getTime(),
    );
    warn.mockRestore();
  });
});

describe('Daily Plan through a day, without the public flag', () => {
  it('sends on the first evaluation, even at 0/0, and never again that day', async () => {
    const { day, service, createNotification } = dayPort();
    await service.reconcile();
    expect(createNotification).toHaveBeenCalledOnce();
    day.tasks = 1;
    day.time = '20:00';
    await service.reconcile();
    day.hour = 20;
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(createNotification).toHaveBeenCalledOnce();
  });

  it('keeps an evaluated day closed to a later alarm', async () => {
    const { day, service, createNotification, saveState } = dayPort({
      lastEvaluationLocalDate: '2026-07-22',
      lastNotificationLocalDate: null,
    });
    day.tasks = 1;
    day.hour = 20;
    day.time = '20:00';
    await service.handleAlarm(DAILY_PLAN_ALARM_NAME);
    expect(createNotification).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });
});

describe('DailyPlanService, public edition', () => {
  beforeEach(() => vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', true));
  afterEach(() => vi.unstubAllGlobals());

  it('sends nothing when tasks and reviews are both 0, and does not re-evaluate today', async () => {
    const createNotification = vi.fn(async () => undefined);
    const countDueReviews = vi.fn(async () => 0);
    const saveState = vi.fn(async () => undefined);
    let state: DailyPlanState = { ...DEFAULT_DAILY_PLAN_STATE };
    const service = new DailyPlanService(
      createPort({
        createNotification,
        countDueReviews,
        countRemainingTasks: async () => 0,
        loadState: async () => state,
        saveState: async (next) => {
          state = next;
          await saveState();
        },
      }),
    );

    await service.reconcile();
    await service.reconcile();

    expect(createNotification).not.toHaveBeenCalled();
    expect(countDueReviews).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledOnce();
    expect(state.lastEvaluationLocalDate).toBe('2026-07-22');
    expect(state.lastNotificationLocalDate).toBeNull();
  });

  it.each([
    [1, 0],
    [0, 1],
  ])('still notifies with %i reviews and %i tasks', async (reviews, tasks) => {
    const createNotification = vi.fn(async () => undefined);
    await new DailyPlanService(
      createPort({
        createNotification,
        countDueReviews: async () => reviews,
        countRemainingTasks: async () => tasks,
      }),
    ).reconcile();

    expect(createNotification).toHaveBeenCalledOnce();
  });
});

describe('Daily Plan with nothing to do, without the public flag', () => {
  it('still notifies when tasks and reviews are both 0', async () => {
    const createNotification = vi.fn(async () => undefined);
    await new DailyPlanService(
      createPort({
        createNotification,
        countDueReviews: async () => 0,
        countRemainingTasks: async () => 0,
      }),
    ).reconcile();

    expect(createNotification).toHaveBeenCalledOnce();
  });
});

describe('Daily Plan normalization and copy', () => {
  it('defaults fields individually and never overwrites valid explicit false values', () => {
    expect(
      normalizeDailyPlanPreferences({
        dailyPlanReminderEnabled: false,
        dailyPlanReminderTime: '08:15',
        includeReviewsInDailyPlan: false,
        includeTasksInDailyPlan: false,
      }),
    ).toEqual({
      dailyPlanReminderEnabled: false,
      dailyPlanReminderTime: '08:15',
      includeReviewsInDailyPlan: false,
      includeTasksInDailyPlan: false,
    });
    expect(normalizeDailyPlanPreferences({ dailyPlanReminderTime: '99:99' })).toEqual(
      DEFAULT_DAILY_PLAN_PREFERENCES,
    );
  });

  it('normalizes state and rejects impossible local dates', () => {
    expect(
      normalizeDailyPlanState({
        lastEvaluationLocalDate: '2026-02-29',
        lastNotificationLocalDate: '2026-07-22',
      }),
    ).toEqual({
      lastEvaluationLocalDate: null,
      lastNotificationLocalDate: '2026-07-22',
    });
  });

  it.each([
    [
      { reviewCount: 0, taskCount: 0, includeReviews: true, includeTasks: true },
      '今天有 0 项任务、0 条复习等你。',
    ],
    [
      { reviewCount: 1, taskCount: 0, includeReviews: true, includeTasks: false },
      '今天有 1 条复习等你。',
    ],
    [
      { reviewCount: 0, taskCount: 2, includeReviews: false, includeTasks: true },
      '今天有 2 项任务等你。',
    ],
    [
      { reviewCount: 99, taskCount: 99, includeReviews: false, includeTasks: false },
      '今天的每日计划已准备好。',
    ],
  ] as const)('builds grammatical count-only copy', (counts, expected) => {
    expect(buildDailyPlanMessage(counts)).toBe(expected);
  });
});
