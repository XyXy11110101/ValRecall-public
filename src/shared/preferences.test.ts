import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(stored: unknown = undefined) {
  const get = vi.fn(async () => ({ 'valrecall.preferences': stored }));
  const set = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { get, set };
}

describe('ValRecall preferences', () => {
  it('does not report successful persistence without extension storage', async () => {
    vi.stubGlobal('chrome', undefined);
    await expect(savePreferences(DEFAULT_PREFERENCES)).rejects.toThrow('不能保存扩展设置');
  });
  it('uses enabled, 20:00, due-only reminder defaults when no preference exists', async () => {
    stubStorage();

    await expect(loadPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toMatchObject({
      reminderEnabled: true,
      reminderTime: '20:00',
      notifyOnlyWhenDue: true,
      nextDueReminderEnabled: true,
      reviewQuietHoursEnabled: false,
      reviewQuietHoursStart: '22:00',
      reviewQuietHoursEnd: '08:00',
      groupReviewNotificationCount: true,
      dailyPlanReminderEnabled: true,
      dailyPlanReminderTime: '09:00',
      includeReviewsInDailyPlan: true,
      includeTasksInDailyPlan: true,
      shortTermReviewMode: 'standard',
    });
  });

  it('preserves explicit reminder values and validates every stored boundary', async () => {
    stubStorage({
      defaultItemType: 'Do',
      pauseAfterReopen: false,
      showExtractionDiagnostics: true,
      shortTermReviewMode: 'light',
      reminderEnabled: false,
      reminderTime: '06:45',
      notifyOnlyWhenDue: false,
      nextDueReminderEnabled: false,
      reviewQuietHoursEnabled: true,
      reviewQuietHoursStart: '21:30',
      reviewQuietHoursEnd: '07:15',
      groupReviewNotificationCount: false,
      dailyPlanReminderEnabled: false,
      dailyPlanReminderTime: '07:15',
      includeReviewsInDailyPlan: false,
      includeTasksInDailyPlan: false,
    });

    await expect(loadPreferences()).resolves.toEqual({
      defaultItemType: 'Do',
      pauseAfterReopen: false,
      showExtractionDiagnostics: true,
      shortTermReviewMode: 'light',
      reminderEnabled: false,
      reminderTime: '06:45',
      notifyOnlyWhenDue: false,
      nextDueReminderEnabled: false,
      reviewQuietHoursEnabled: true,
      reviewQuietHoursStart: '21:30',
      reviewQuietHoursEnd: '07:15',
      groupReviewNotificationCount: false,
      dailyPlanReminderEnabled: false,
      dailyPlanReminderTime: '07:15',
      includeReviewsInDailyPlan: false,
      includeTasksInDailyPlan: false,
    });
  });

  it('falls back field by field for malformed stored values', async () => {
    stubStorage({
      defaultItemType: 'Delete',
      pauseAfterReopen: 'false',
      showExtractionDiagnostics: 1,
      shortTermReviewMode: 'instant',
      reminderEnabled: 'yes',
      reminderTime: '6:45',
      notifyOnlyWhenDue: null,
      nextDueReminderEnabled: 'yes',
      reviewQuietHoursEnabled: 1,
      reviewQuietHoursStart: '9:00',
      reviewQuietHoursEnd: '25:00',
      groupReviewNotificationCount: 'yes',
      dailyPlanReminderEnabled: 'yes',
      dailyPlanReminderTime: '25:00',
      includeReviewsInDailyPlan: 1,
      includeTasksInDailyPlan: null,
    });

    await expect(loadPreferences()).resolves.toEqual(DEFAULT_PREFERENCES);
  });

  it('saves the complete typed preference object locally', async () => {
    const { set } = stubStorage();
    const preferences = {
      ...DEFAULT_PREFERENCES,
      reminderEnabled: false,
      reminderTime: '09:10',
    };

    await savePreferences(preferences);

    expect(set).toHaveBeenCalledWith({ 'valrecall.preferences': preferences });
  });
});
