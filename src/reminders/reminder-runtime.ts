import type { OpenDashboardResponse } from '../models/messages';
import { PREFERENCES_STORAGE_KEY } from '../shared/preferences';
import {
  DAILY_PLAN_ALARM_NAME,
  DAILY_PLAN_NOTIFICATION_ID,
  DAILY_PLAN_TEST_NOTIFICATION_ID,
  type DailyPlanService,
} from './daily-plan-service';
import {
  NEXT_REVIEW_ALARM_NAME,
  NEXT_REVIEW_NOTIFICATION_ID,
  REMINDER_ALARM_NAME,
  REVIEW_NOTIFICATION_ID,
  TEST_NOTIFICATION_ID,
  type ReminderService,
} from './reminder-service';

export interface ReminderRuntimeApi {
  alarms: {
    onAlarm: {
      addListener(listener: (alarm: { name: string }) => void): void;
    };
  };
  notifications: {
    onClicked: {
      addListener(listener: (notificationId: string) => void): void;
    };
    onButtonClicked: {
      addListener(listener: (notificationId: string, buttonIndex: number) => void): void;
    };
  };
  runtime: {
    onInstalled: {
      addListener(listener: () => void): void;
    };
    onStartup: {
      addListener(listener: () => void): void;
    };
  };
  storage: {
    onChanged: {
      addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
    };
  };
}

export interface ReminderRuntimeDependencies {
  service: Pick<ReminderService, 'reconcile' | 'handleAlarm'>;
  dailyPlanService: Pick<DailyPlanService, 'reconcile' | 'handleAlarm'>;
  openReviewDashboard(): Promise<OpenDashboardResponse>;
  openHomeDashboard(): Promise<OpenDashboardResponse>;
  warn?: (message: string, error?: unknown) => void;
}

/** Registers wake-up events and performs the service-worker-evaluation reconciliation. */
export function registerReminderRuntime(
  api: ReminderRuntimeApi,
  dependencies: ReminderRuntimeDependencies,
): void {
  const warn = dependencies.warn ?? console.warn;
  const reconcile = () => {
    void dependencies.service
      .reconcile()
      .catch((error: unknown) => warn('[ValRecall] Reminder reconciliation failed.', error));
    void dependencies.dailyPlanService
      .reconcile()
      .catch((error: unknown) => warn('[ValRecall] Daily Plan reconciliation failed.', error));
  };

  api.runtime.onInstalled.addListener(reconcile);
  api.runtime.onStartup.addListener(reconcile);
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && PREFERENCES_STORAGE_KEY in changes) reconcile();
  });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === REMINDER_ALARM_NAME || alarm.name === NEXT_REVIEW_ALARM_NAME) {
      void dependencies.service
        .handleAlarm(alarm.name)
        .catch((error: unknown) => warn('[ValRecall] Review reminder check failed.', error));
      return;
    }
    if (alarm.name === DAILY_PLAN_ALARM_NAME) {
      void dependencies.dailyPlanService
        .handleAlarm(alarm.name)
        .catch((error: unknown) => warn('[ValRecall] Daily Plan check failed.', error));
    }
  });
  api.notifications.onClicked.addListener((notificationId) => {
    if (
      notificationId === DAILY_PLAN_NOTIFICATION_ID ||
      notificationId === DAILY_PLAN_TEST_NOTIFICATION_ID
    ) {
      void openNotificationDestination(dependencies.openHomeDashboard, 'Home', warn);
      return;
    }
    if (
      notificationId === REVIEW_NOTIFICATION_ID ||
      notificationId === NEXT_REVIEW_NOTIFICATION_ID ||
      notificationId === TEST_NOTIFICATION_ID
    ) {
      void openNotificationDestination(dependencies.openReviewDashboard, 'Review', warn);
    }
  });
  api.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (
      buttonIndex === 0 &&
      (notificationId === REVIEW_NOTIFICATION_ID ||
        notificationId === NEXT_REVIEW_NOTIFICATION_ID ||
        notificationId === TEST_NOTIFICATION_ID)
    ) {
      void openNotificationDestination(dependencies.openReviewDashboard, 'Review', warn);
    }
  });

  reconcile();
}

async function openNotificationDestination(
  openDashboard: () => Promise<OpenDashboardResponse>,
  destination: 'Home' | 'Review',
  warn: (message: string, error?: unknown) => void,
): Promise<void> {
  try {
    const response = await openDashboard();
    if (!response.ok) {
      warn(`[ValRecall] Reminder could not open ${destination}.`, response.error);
    }
  } catch (error) {
    warn(`[ValRecall] Reminder could not open ${destination}.`, error);
  }
}
