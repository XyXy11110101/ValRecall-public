import type { ValRecallPreferences } from '../shared/preferences';
import {
  normalizeDailyPlanState,
  type DailyPlanServicePort,
  type DailyPlanState,
} from './daily-plan-service';
import { companionNotificationIcon, createWithIconFallback } from './notification-icon';

export const DAILY_PLAN_STATE_STORAGE_KEY = 'valrecall.dailyPlanState';

export interface DailyPlanChromeApi {
  alarms: {
    create(name: string, alarmInfo: { when: number }): Promise<void> | void;
    clear(name: string): Promise<boolean>;
  };
  notifications: {
    create(
      notificationId: string,
      options: {
        type: 'basic';
        iconUrl: string;
        title: string;
        message: string;
      },
    ): Promise<string>;
  };
  runtime: {
    getURL(path: string): string;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

export interface DailyPlanChromeDependencies {
  loadPreferences(): Promise<ValRecallPreferences>;
  countDueReviews(now: Date): Promise<number>;
  countRemainingTasks(now: Date): Promise<number>;
  now?: () => Date;
}

export function createDailyPlanChromePort(
  api: DailyPlanChromeApi,
  dependencies: DailyPlanChromeDependencies,
): DailyPlanServicePort {
  const now = dependencies.now ?? (() => new Date());
  return {
    now,
    loadPreferences: dependencies.loadPreferences,
    async loadState() {
      const stored = await api.storage.local.get(DAILY_PLAN_STATE_STORAGE_KEY);
      return normalizeDailyPlanState(stored[DAILY_PLAN_STATE_STORAGE_KEY]);
    },
    async saveState(state: DailyPlanState) {
      await api.storage.local.set({ [DAILY_PLAN_STATE_STORAGE_KEY]: state });
    },
    countDueReviews: dependencies.countDueReviews,
    countRemainingTasks: dependencies.countRemainingTasks,
    async createAlarm(name: string, when: number) {
      await api.alarms.create(name, { when });
    },
    async clearAlarm(name: string) {
      await api.alarms.clear(name);
    },
    async createNotification(id, notification) {
      await createWithIconFallback(
        (iconPath) =>
          api.notifications.create(id, {
            type: 'basic',
            iconUrl: api.runtime.getURL(iconPath),
            title: notification.title,
            message: notification.message,
          }),
        await companionNotificationIcon('default', (key) => api.storage.local.get(key), now()),
      );
    },
  };
}
