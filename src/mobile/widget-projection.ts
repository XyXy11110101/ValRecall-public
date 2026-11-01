import {
  mobileTaskProjection,
  mobileVisibleTasks,
  type MobileState,
} from '../database/mobile-repository';
import { addLocalCalendarDays, type TaskPriority } from '../models/daily-task';
import { buildHomeTaskOverview } from '../models/task-overview';
import { dateInTimeZone, isTimeZone } from '../sync/protocol';
import { groupMobileTasks, type MobileTaskRow } from './task-presentation';

export const WIDGET_DAY_COUNT = 14;
export const WIDGET_PROJECTION_VERSION = 2;
/** Today scrolls through every open task; later days only need a short preview. */
export const WIDGET_TODAY_ROW_LIMIT = 50;
export const WIDGET_LATER_ROW_LIMIT = 20;
/** Native accepts 256 KiB after Kotlin re-serialises the JSON; stay well below it. */
export const WIDGET_BYTE_BUDGET = 200 * 1024;
const WIDGET_TITLE_LIMIT = 160;

export interface WidgetRow {
  taskId: string;
  occurrenceDate: string;
  title: string;
  scheduledTime: string | null;
  pending: boolean;
  priority: TaskPriority;
}

export interface WidgetDay {
  date: string;
  /** Open occurrences (today's and overdue); `rows` holds the first of them in phone order. */
  total: number;
  overdue: number;
  /** Completions made on this date, for the "2/6" progress (same rule as 今天完成). */
  completed: number;
  rows: WidgetRow[];
  next: WidgetRow | null;
}

export type WidgetUnavailableReason = 'not-ready' | 'read-error' | 'workspace-changed';

/** A disposable display cache. Task mutations and settlement remain in the repository. */
export type WidgetProjection =
  | {
      version: 2;
      status: 'ready';
      reason: null;
      epoch: string;
      timeZone: string;
      generatedAt: string;
      sourceSnapshotAt: string;
      days: WidgetDay[];
    }
  | {
      version: 2;
      status: 'unavailable';
      reason: WidgetUnavailableReason;
      epoch: null;
      timeZone: null;
      generatedAt: string;
      sourceSnapshotAt: null;
      days: [];
    };

export function unavailableWidgetProjection(
  reason: WidgetUnavailableReason,
  now: Date,
): WidgetProjection {
  return {
    version: WIDGET_PROJECTION_VERSION,
    status: 'unavailable',
    reason,
    epoch: null,
    timeZone: null,
    generatedAt: now.toISOString(),
    sourceSnapshotAt: null,
    days: [],
  };
}

/** Kotlin String.length counts UTF-16 units; keep complete code points within its limit. */
function widgetTitle(title: string): string {
  if (title.length <= WIDGET_TITLE_LIMIT) return title;
  let preview = '';
  for (const character of title) {
    if (preview.length + character.length > WIDGET_TITLE_LIMIT - 1) break;
    preview += character;
  }
  return preview + '…';
}

function widgetRow(row: MobileTaskRow): WidgetRow {
  return {
    taskId: row.task.id,
    occurrenceDate: row.date,
    title: widgetTitle(row.task.title),
    scheduledTime: row.task.scheduledTime,
    pending: row.pending,
    priority: row.task.priority,
  };
}

export function buildWidgetProjection(state: MobileState | null, now: Date): WidgetProjection {
  if (!state) return unavailableWidgetProjection('not-ready', now);
  const { snapshot } = state;
  if (!snapshot || snapshot.version !== 2) return unavailableWidgetProjection('not-ready', now);
  if (state.epoch !== snapshot.epoch) return unavailableWidgetProjection('workspace-changed', now);
  if (!isTimeZone(snapshot.timeZone)) return unavailableWidgetProjection('read-error', now);

  const today = dateInTimeZone(now, snapshot.timeZone);
  const tasks = mobileVisibleTasks(state).map(({ task }) => task);
  const { completions, skips } = mobileTaskProjection(state);
  const days = Array.from({ length: WIDGET_DAY_COUNT }, (_, offset): WidgetDay => {
    const date = addLocalCalendarDays(today, offset);
    const { open, completed } = groupMobileTasks(state, date);
    let next: WidgetRow | null = null;
    if (!open.length) {
      // Reuse the bounded scheduling search, including completions/skips beyond this cache window.
      const overview = buildHomeTaskOverview(tasks, completions, skips, date);
      const nextDate = overview.upcoming[0]?.localDate;
      if (nextDate) {
        const first = groupMobileTasks(state, nextDate).open[0];
        if (first) next = widgetRow(first);
      }
    }
    return {
      date,
      total: open.length,
      overdue: open.filter((row) => row.date < date).length,
      completed: completed.filter(
        (row) =>
          row.completedAt !== undefined &&
          dateInTimeZone(new Date(row.completedAt), snapshot.timeZone) === date,
      ).length,
      rows: open
        .slice(0, offset === 0 ? WIDGET_TODAY_ROW_LIMIT : WIDGET_LATER_ROW_LIMIT)
        .map(widgetRow),
      next,
    };
  });
  const projection: WidgetProjection = {
    version: WIDGET_PROJECTION_VERSION,
    status: 'ready',
    reason: null,
    epoch: snapshot.epoch,
    timeZone: snapshot.timeZone,
    generatedAt: now.toISOString(),
    sourceSnapshotAt: snapshot.generatedAt,
    days,
  };
  return fitWidgetProjection(projection);
}

/**
 * A conservative size of the payload after Kotlin re-serialises it: org.json writes `/` as
 * `\/`, and the JVM build also escapes U+0080–U+00A0 and U+2000–U+2100 as six-byte escapes.
 */
export function widgetPayloadBytes(value: unknown): number {
  const json = JSON.stringify(value);
  let extra = 0;
  for (const character of json) {
    const code = character.codePointAt(0)!;
    if (character === '/') extra += 1;
    else if (code >= 0x80 && code <= 0xa0) extra += 4;
    else if (code >= 0x2000 && code <= 0x2100) extra += 3;
  }
  return new TextEncoder().encode(json).length + extra;
}

/** Trims preview rows (later days first) until the payload fits; counts never change. */
export function fitWidgetProjection(
  projection: WidgetProjection,
  budget = WIDGET_BYTE_BUDGET,
): WidgetProjection {
  if (projection.status !== 'ready' || widgetPayloadBytes(projection) <= budget) return projection;
  const limited = (today: number, later: number): WidgetProjection => ({
    ...projection,
    days: projection.days.map((day, index) => ({
      ...day,
      rows: day.rows.slice(0, index === 0 ? today : later),
    })),
  });
  for (const later of [10, 5, 0]) {
    const candidate = limited(WIDGET_TODAY_ROW_LIMIT, later);
    if (widgetPayloadBytes(candidate) <= budget) return candidate;
  }
  for (const today of [25, 10, 5]) {
    const candidate = limited(today, 0);
    if (widgetPayloadBytes(candidate) <= budget) return candidate;
  }
  return limited(1, 0);
}
