import { describe, expect, it, vi } from 'vitest';

import { companionIconPath, outfitForDate } from '../companion/wardrobe';
import { COMPANION_WARDROBE_STORAGE_KEY } from '../companion/wardrobe-preference';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import {
  createDailyPlanChromePort,
  DAILY_PLAN_STATE_STORAGE_KEY,
  type DailyPlanChromeApi,
} from './daily-plan-chrome-port';

function chromeApi(stored: Record<string, unknown> = {}): {
  api: DailyPlanChromeApi;
  createAlarm: ReturnType<typeof vi.fn>;
  clearAlarm: ReturnType<typeof vi.fn>;
  createNotification: ReturnType<typeof vi.fn>;
  setStorage: ReturnType<typeof vi.fn>;
} {
  const createAlarm = vi.fn(async () => undefined);
  const clearAlarm = vi.fn(async () => true);
  const createNotification = vi.fn(async (id: string) => id);
  const setStorage = vi.fn(async () => undefined);
  return {
    api: {
      alarms: { create: createAlarm, clear: clearAlarm },
      notifications: { create: createNotification },
      runtime: { getURL: (path) => `chrome-extension://fixture/${path}` },
      storage: {
        local: {
          get: async () => stored,
          set: setStorage,
        },
      },
    },
    createAlarm,
    clearAlarm,
    createNotification,
    setStorage,
  };
}

describe('createDailyPlanChromePort', () => {
  it('keeps storage, alarm, and notification channels isolated', async () => {
    const fixture = chromeApi({
      [DAILY_PLAN_STATE_STORAGE_KEY]: {
        lastEvaluationLocalDate: '2026-07-22',
        lastNotificationLocalDate: null,
      },
    });
    const countDueReviews = vi.fn(async () => 3);
    const countRemainingTasks = vi.fn(async () => 2);
    const port = createDailyPlanChromePort(fixture.api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      countDueReviews,
      countRemainingTasks,
      now: () => new Date(2026, 6, 22, 8, 0),
    });

    await expect(port.loadState()).resolves.toEqual({
      lastEvaluationLocalDate: '2026-07-22',
      lastNotificationLocalDate: null,
    });
    await port.saveState({
      lastEvaluationLocalDate: '2026-07-22',
      lastNotificationLocalDate: '2026-07-22',
    });
    await port.createAlarm('valrecall.daily-plan', 1234);
    await port.clearAlarm('valrecall.daily-plan');
    await port.createNotification('valrecall.daily-plan-reminder', {
      title: 'ValRecall daily plan',
      message: '2 tasks and 3 reviews are ready today.',
    });

    expect(fixture.setStorage).toHaveBeenCalledWith({
      [DAILY_PLAN_STATE_STORAGE_KEY]: {
        lastEvaluationLocalDate: '2026-07-22',
        lastNotificationLocalDate: '2026-07-22',
      },
    });
    expect(fixture.createAlarm).toHaveBeenCalledWith('valrecall.daily-plan', { when: 1234 });
    expect(fixture.clearAlarm).toHaveBeenCalledWith('valrecall.daily-plan');
    expect(fixture.createNotification).toHaveBeenCalledWith('valrecall.daily-plan-reminder', {
      type: 'basic',
      iconUrl: `chrome-extension://fixture/${companionIconPath(outfitForDate('2026-07-22'), 'default')}`,
      title: 'ValRecall daily plan',
      message: '2 tasks and 3 reviews are ready today.',
    });
  });

  it('shows the pinned outfit on the daily plan and keeps the plan if the icon fails', async () => {
    const fixture = chromeApi({
      [COMPANION_WARDROBE_STORAGE_KEY]: { version: 1, mode: 'pinned', outfit: 'outfit11' },
    });
    fixture.createNotification
      .mockRejectedValueOnce(new Error('Unable to download all specified images.'))
      .mockResolvedValueOnce('valrecall.daily-plan-reminder');
    const port = createDailyPlanChromePort(fixture.api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      countDueReviews: async () => 0,
      countRemainingTasks: async () => 1,
      now: () => new Date(2026, 6, 22, 8, 0),
    });

    await port.createNotification('valrecall.daily-plan-reminder', {
      title: 'ValRecall daily plan',
      message: '1 task is ready today.',
    });

    expect(
      fixture.createNotification.mock.calls.map((call) => (call[1] as { iconUrl: string }).iconUrl),
    ).toEqual([
      'chrome-extension://fixture/assets/companion/chibi/outfit11/icon-default-128.png',
      'chrome-extension://fixture/icons/icon128.png',
    ]);
  });

  it('passes only the requested time to independent count providers', async () => {
    const fixture = chromeApi();
    const now = new Date(2026, 6, 22, 8, 45);
    const countDueReviews = vi.fn(async () => 5);
    const countRemainingTasks = vi.fn(async () => 4);
    const port = createDailyPlanChromePort(fixture.api, {
      loadPreferences: async () => DEFAULT_PREFERENCES,
      countDueReviews,
      countRemainingTasks,
      now: () => now,
    });

    await expect(port.countDueReviews(now)).resolves.toBe(5);
    await expect(port.countRemainingTasks(now)).resolves.toBe(4);
    expect(countDueReviews).toHaveBeenCalledWith(now);
    expect(countRemainingTasks).toHaveBeenCalledWith(now);
    expect(port.now()).toBe(now);
  });
});
