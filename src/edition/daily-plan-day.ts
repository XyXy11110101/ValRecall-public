import type { DailyPlanServicePort } from '../reminders/daily-plan-service';
import { localDateKey } from '../reminders/reminder-service';

/**
 * In this edition an empty day sends nothing, but the day stays marked as evaluated. That keeps a
 * wake-up quiet: someone who adds a first task after the reminder time has passed gets no surprise
 * catch-up notice. A wake-up is not a time anyone chose.
 *
 * The alarm is. It only fires at the time the user set, so it looks at today again unless a notice
 * already went out. Then a reminder moved later today still fires, at most once a day.
 *
 * A failed read or write leaves the day marked, so the worst case is a missed notice, never a
 * second one, and the caller still schedules the next alarm.
 */
export async function reopenDayForAlarm(
  port: Pick<DailyPlanServicePort, 'now' | 'loadPreferences' | 'loadState' | 'saveState'>,
): Promise<void> {
  try {
    const { dailyPlanReminderEnabled } = await port.loadPreferences();
    if (!dailyPlanReminderEnabled) return;
    const today = localDateKey(port.now());
    const state = await port.loadState();
    if (state.lastEvaluationLocalDate !== today || state.lastNotificationLocalDate === today) {
      return;
    }
    await port.saveState({ ...state, lastEvaluationLocalDate: null });
  } catch (error) {
    console.warn('[ValRecall] The Daily Plan alarm could not look at today again.', error);
  }
}
