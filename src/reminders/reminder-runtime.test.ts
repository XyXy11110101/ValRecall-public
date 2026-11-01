import { describe, expect, it, vi } from 'vitest';

import type { OpenDashboardResponse } from '../models/messages';
import { PREFERENCES_STORAGE_KEY } from '../shared/preferences';
import {
  DAILY_PLAN_ALARM_NAME,
  DAILY_PLAN_NOTIFICATION_ID,
  DAILY_PLAN_TEST_NOTIFICATION_ID,
} from './daily-plan-service';
import {
  NEXT_REVIEW_ALARM_NAME,
  NEXT_REVIEW_NOTIFICATION_ID,
  REMINDER_ALARM_NAME,
  REVIEW_NOTIFICATION_ID,
  TEST_NOTIFICATION_ID,
} from './reminder-service';
import {
  registerReminderRuntime,
  type ReminderRuntimeApi,
  type ReminderRuntimeDependencies,
} from './reminder-runtime';

interface Listeners {
  installed?: () => void;
  startup?: () => void;
  alarm?: (alarm: { name: string }) => void;
  notification?: (notificationId: string) => void;
  notificationButton?: (notificationId: string, buttonIndex: number) => void;
  storage?: (changes: Record<string, unknown>, areaName: string) => void;
}

function register() {
  const listeners: Listeners = {};
  const api: ReminderRuntimeApi = {
    alarms: {
      onAlarm: { addListener: (listener) => (listeners.alarm = listener) },
    },
    notifications: {
      onClicked: { addListener: (listener) => (listeners.notification = listener) },
      onButtonClicked: {
        addListener: (listener) => (listeners.notificationButton = listener),
      },
    },
    runtime: {
      onInstalled: { addListener: (listener) => (listeners.installed = listener) },
      onStartup: { addListener: (listener) => (listeners.startup = listener) },
    },
    storage: {
      onChanged: { addListener: (listener) => (listeners.storage = listener) },
    },
  };
  const dependencies: ReminderRuntimeDependencies = {
    service: {
      reconcile: vi.fn(async () => undefined),
      handleAlarm: vi.fn(async () => undefined),
    },
    dailyPlanService: {
      reconcile: vi.fn(async () => undefined),
      handleAlarm: vi.fn(async () => undefined),
    },
    openReviewDashboard: vi.fn(async (): Promise<OpenDashboardResponse> => ({ ok: true })),
    openHomeDashboard: vi.fn(async (): Promise<OpenDashboardResponse> => ({ ok: true })),
    warn: vi.fn(),
  };
  registerReminderRuntime(api, dependencies);
  return { listeners, dependencies };
}

describe('registerReminderRuntime', () => {
  it('reconciles on worker evaluation, install, startup, and preference changes', async () => {
    const { listeners, dependencies } = register();

    listeners.installed?.();
    listeners.startup?.();
    listeners.storage?.({ unrelated: {} }, 'local');
    listeners.storage?.({ [PREFERENCES_STORAGE_KEY]: {} }, 'sync');
    listeners.storage?.({ [PREFERENCES_STORAGE_KEY]: {} }, 'local');

    await vi.waitFor(() => expect(dependencies.service.reconcile).toHaveBeenCalledTimes(4));
    expect(dependencies.dailyPlanService.reconcile).toHaveBeenCalledTimes(4);
  });

  it('routes the two named alarms to separate services', async () => {
    const { listeners, dependencies } = register();

    listeners.alarm?.({ name: 'unrelated' });
    listeners.alarm?.({ name: REMINDER_ALARM_NAME });
    listeners.alarm?.({ name: NEXT_REVIEW_ALARM_NAME });
    listeners.alarm?.({ name: DAILY_PLAN_ALARM_NAME });

    await vi.waitFor(() =>
      expect(dependencies.service.handleAlarm).toHaveBeenCalledWith(REMINDER_ALARM_NAME),
    );
    expect(dependencies.service.handleAlarm).toHaveBeenCalledWith(NEXT_REVIEW_ALARM_NAME);
    expect(dependencies.service.handleAlarm).toHaveBeenCalledTimes(2);
    expect(dependencies.dailyPlanService.handleAlarm).toHaveBeenCalledWith(DAILY_PLAN_ALARM_NAME);
    expect(dependencies.dailyPlanService.handleAlarm).toHaveBeenCalledTimes(1);
  });

  it('opens Review for review notifications and Home for the Daily Plan only', async () => {
    const { listeners, dependencies } = register();

    listeners.notification?.('another-notification');
    listeners.notification?.(REVIEW_NOTIFICATION_ID);
    listeners.notification?.(TEST_NOTIFICATION_ID);
    listeners.notification?.(NEXT_REVIEW_NOTIFICATION_ID);
    listeners.notification?.(DAILY_PLAN_NOTIFICATION_ID);
    listeners.notification?.(DAILY_PLAN_TEST_NOTIFICATION_ID);

    listeners.notificationButton?.(NEXT_REVIEW_NOTIFICATION_ID, 0);
    listeners.notificationButton?.(NEXT_REVIEW_NOTIFICATION_ID, 1);

    await vi.waitFor(() => expect(dependencies.openReviewDashboard).toHaveBeenCalledTimes(4));
    expect(dependencies.openHomeDashboard).toHaveBeenCalledTimes(2);
  });

  it('contains reminder failures and reports them without an unhandled rejection', async () => {
    const { listeners, dependencies } = register();
    vi.mocked(dependencies.service.handleAlarm).mockRejectedValueOnce(new Error('db failed'));
    vi.mocked(dependencies.openReviewDashboard).mockRejectedValueOnce(new Error('tab failed'));
    vi.mocked(dependencies.dailyPlanService.handleAlarm).mockRejectedValueOnce(
      new Error('task db failed'),
    );
    vi.mocked(dependencies.openHomeDashboard).mockRejectedValueOnce(new Error('home failed'));

    listeners.alarm?.({ name: REMINDER_ALARM_NAME });
    listeners.alarm?.({ name: DAILY_PLAN_ALARM_NAME });
    listeners.notification?.(REVIEW_NOTIFICATION_ID);
    listeners.notification?.(DAILY_PLAN_NOTIFICATION_ID);

    await vi.waitFor(() => expect(dependencies.warn).toHaveBeenCalledTimes(4));
  });
});
