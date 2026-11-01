import type { LearningItemType } from '../models/learning-item';
import {
  DEFAULT_SHORT_TERM_REVIEW_MODE,
  isShortTermReviewMode,
  type ShortTermReviewMode,
} from '../fsrs/config';
import {
  DEFAULT_DAILY_PLAN_PREFERENCES,
  normalizeDailyPlanPreferences,
  type DailyPlanPreferences,
} from '../reminders/daily-plan-service';
import {
  DEFAULT_REMINDER_PREFERENCES,
  normalizeReminderPreferences,
  type ReminderPreferences,
} from '../reminders/reminder-service';

export interface ValRecallPreferences extends ReminderPreferences, DailyPlanPreferences {
  defaultItemType: LearningItemType;
  pauseAfterReopen: boolean;
  showExtractionDiagnostics: boolean;
  shortTermReviewMode: ShortTermReviewMode;
}

export const DEFAULT_PREFERENCES: ValRecallPreferences = {
  defaultItemType: 'Understand',
  pauseAfterReopen: true,
  showExtractionDiagnostics: false,
  shortTermReviewMode: DEFAULT_SHORT_TERM_REVIEW_MODE,
  ...DEFAULT_REMINDER_PREFERENCES,
  ...DEFAULT_DAILY_PLAN_PREFERENCES,
};

export const PREFERENCES_STORAGE_KEY = 'valrecall.preferences';

export async function loadPreferences(): Promise<ValRecallPreferences> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return { ...DEFAULT_PREFERENCES };
  const stored: unknown = (await chrome.storage.local.get(PREFERENCES_STORAGE_KEY))[
    PREFERENCES_STORAGE_KEY
  ];
  const record = isRecord(stored) ? stored : {};
  const reminders = normalizeReminderPreferences(record);
  const dailyPlan = normalizeDailyPlanPreferences(record);
  return {
    defaultItemType:
      typeof record.defaultItemType === 'string' &&
      ['Avoid', 'Do', 'Notice', 'Understand'].includes(record.defaultItemType)
        ? (record.defaultItemType as LearningItemType)
        : DEFAULT_PREFERENCES.defaultItemType,
    pauseAfterReopen:
      typeof record.pauseAfterReopen === 'boolean'
        ? record.pauseAfterReopen
        : DEFAULT_PREFERENCES.pauseAfterReopen,
    showExtractionDiagnostics:
      typeof record.showExtractionDiagnostics === 'boolean'
        ? record.showExtractionDiagnostics
        : DEFAULT_PREFERENCES.showExtractionDiagnostics,
    shortTermReviewMode: isShortTermReviewMode(record.shortTermReviewMode)
      ? record.shortTermReviewMode
      : DEFAULT_PREFERENCES.shortTermReviewMode,
    ...reminders,
    ...dailyPlan,
  };
}

export async function savePreferences(preferences: ValRecallPreferences): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local)
    throw new Error('当前环境不能保存扩展设置，请在已安装的 Edge 扩展中操作。');
  await chrome.storage.local.set({ [PREFERENCES_STORAGE_KEY]: preferences });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
