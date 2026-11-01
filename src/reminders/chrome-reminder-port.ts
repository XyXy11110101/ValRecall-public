import type { LearningItem } from '../database';
import type { ValRecallPreferences } from '../shared/preferences';
import {
  normalizeReminderState,
  type ReminderNotification,
  type ReminderServicePort,
  type ReminderState,
} from './reminder-service';
import { companionNotificationIcon, createWithIconFallback } from './notification-icon';

export const REMINDER_STATE_STORAGE_KEY = 'valrecall.reminderState';

export interface ReminderChromeApi {
  alarms: {
    create(name: string, alarmInfo: { when: number }): Promise<void> | void;
    clear(name: string): Promise<boolean>;
    get(name: string): Promise<{ scheduledTime: number } | undefined>;
  };
  notifications: {
    create(
      notificationId: string,
      options: {
        type: 'basic';
        iconUrl: string;
        title: string;
        message: string;
        buttons?: Array<{ title: string }>;
      },
    ): Promise<string>;
  };
  permissions: {
    contains(permissions: { permissions: Array<'notifications'> }): Promise<boolean>;
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

export interface ChromeReminderDependencies {
  loadPreferences(): Promise<ValRecallPreferences>;
  listItems(): Promise<LearningItem[]>;
  now?: () => Date;
}

export function createChromeReminderPort(
  api: ReminderChromeApi,
  dependencies: ChromeReminderDependencies,
): ReminderServicePort {
  const now = dependencies.now ?? (() => new Date());
  return {
    now,
    loadPreferences: dependencies.loadPreferences,
    async loadState() {
      const stored = await api.storage.local.get(REMINDER_STATE_STORAGE_KEY);
      return normalizeReminderState(stored[REMINDER_STATE_STORAGE_KEY]);
    },
    async saveState(state: ReminderState) {
      await api.storage.local.set({ [REMINDER_STATE_STORAGE_KEY]: state });
    },
    async loadReviewSchedule(now: Date) {
      const nowTime = now.getTime();
      const entries = (await dependencies.listItems())
        .filter((item) => !item.suspended)
        .map((item) => ({
          id: item.id,
          due: new Date(item.fsrsCard.due),
        }))
        .sort(
          (left, right) =>
            left.due.getTime() - right.due.getTime() || left.id.localeCompare(right.id),
        );
      return {
        due: entries.filter((entry) => entry.due.getTime() <= nowTime),
        future: entries.filter((entry) => entry.due.getTime() > nowTime),
      };
    },
    async createAlarm(name: string, when: number) {
      await api.alarms.create(name, { when });
    },
    async clearAlarm(name: string) {
      await api.alarms.clear(name);
    },
    async getAlarmTime(name: string) {
      const alarm = await api.alarms.get(name);
      return alarm?.scheduledTime ?? null;
    },
    async getNotificationPermission() {
      try {
        return (await api.permissions.contains({ permissions: ['notifications'] }))
          ? 'granted'
          : 'denied';
      } catch {
        return 'unavailable';
      }
    },
    async createNotification(id: string, notification: ReminderNotification) {
      await createWithIconFallback(
        (iconPath) =>
          api.notifications.create(id, {
            type: 'basic',
            iconUrl: api.runtime.getURL(iconPath),
            title: notification.title,
            message: notification.message,
            ...(notification.buttons
              ? { buttons: notification.buttons.map((title) => ({ title })) }
              : {}),
          }),
        await companionNotificationIcon('reminder', (key) => api.storage.local.get(key), now()),
      );
    },
  };
}
