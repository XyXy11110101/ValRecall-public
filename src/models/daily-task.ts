export const DAILY_TASK_SCHEMA_VERSION = 1 as const;
export const TASK_EXPORT_SCHEMA_VERSION = 2 as const;

export const DAILY_TASK_KINDS = ['routine', 'one_off', 'practice'] as const;
export const TASK_RECURRENCES = ['daily', 'selected_weekdays', 'specific_date'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;

export type DailyTaskKind = (typeof DAILY_TASK_KINDS)[number];
export type TaskRecurrence = (typeof TASK_RECURRENCES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface DailyTask {
  id: string;
  schemaVersion: typeof DAILY_TASK_SCHEMA_VERSION;
  title: string;
  notes: string | null;
  kind: DailyTaskKind;
  recurrence: TaskRecurrence;
  scheduledDate: string | null;
  scheduledTime: string | null;
  selectedWeekdays: number[];
  linkedLearningItemId: string | null;
  priority: TaskPriority;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCompletion {
  id: string;
  taskId: string;
  localDate: string;
  completedAt: string;
}

export interface TaskSkip {
  taskId: string;
  date: string;
  skippedAt: string;
}

export type PracticeTask = DailyTask & { kind: 'practice' };

export interface TaskOccurrence {
  task: DailyTask;
  localDate: string;
  completion: TaskCompletion | null;
}

export interface TaskDaySummary {
  localDate: string;
  total: number;
  completed: number;
  remaining: number;
  occurrences: TaskOccurrence[];
}

export type NewDailyTask = Pick<DailyTask, 'title' | 'kind' | 'recurrence'> &
  Partial<
    Omit<DailyTask, 'schemaVersion' | 'title' | 'kind' | 'recurrence' | 'createdAt' | 'updatedAt'>
  > & {
    createdAt?: string;
    updatedAt?: string;
  };

export type DailyTaskUpdate = Partial<
  Omit<DailyTask, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>
>;

export interface ListTasksOptions {
  status?: 'all' | 'active' | 'archived';
  kind?: DailyTaskKind;
  priority?: TaskPriority;
}

export interface ValRecallTaskExport {
  application: 'ValRecall';
  schemaVersion: typeof TASK_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  tasks: DailyTask[];
  taskCompletions: TaskCompletion[];
  taskSkips: TaskSkip[];
}

export interface TaskImportResult {
  tasks: number;
  taskCompletions: number;
}

export function localDateKey(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('A valid local date is required.');
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isLocalDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const parsed = utcCalendarDate(year, month, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function isTaskTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hoursText, minutesText] = value.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

export function weekdayForLocalDate(localDate: string): number {
  const { year, month, day } = calendarParts(localDate);
  return utcCalendarDate(year, month, day).getUTCDay();
}

export function addLocalCalendarDays(localDate: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error('Calendar-day offset must be an integer.');
  const { year, month, day } = calendarParts(localDate);
  const date = utcCalendarDate(year, month, day);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateKey(date);
}

export function isTaskScheduledOnDate(task: DailyTask, localDate: string): boolean {
  if (!isLocalDateKey(localDate) || task.archived) return false;
  if (task.recurrence === 'daily') return true;
  if (task.recurrence === 'selected_weekdays') {
    return task.selectedWeekdays.includes(weekdayForLocalDate(localDate));
  }
  return task.scheduledDate === localDate;
}

export function nextScheduledDate(task: DailyTask, onOrAfter: string): string | null {
  if (!isLocalDateKey(onOrAfter) || task.archived) return null;
  if (task.recurrence === 'specific_date') {
    return task.scheduledDate !== null && task.scheduledDate >= onOrAfter
      ? task.scheduledDate
      : null;
  }
  if (task.recurrence === 'daily') return onOrAfter;
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = addLocalCalendarDays(onOrAfter, offset);
    if (task.selectedWeekdays.includes(weekdayForLocalDate(candidate))) return candidate;
  }
  return null;
}

export function taskValidationIssues(task: DailyTask): string[] {
  const issues: string[] = [];
  if (typeof task.id !== 'string' || !task.id.trim()) issues.push('Task id is required.');
  if (task.schemaVersion !== DAILY_TASK_SCHEMA_VERSION) {
    issues.push(`Task schema version must be ${DAILY_TASK_SCHEMA_VERSION}.`);
  }
  if (typeof task.title !== 'string' || !task.title.trim()) issues.push('Task title is required.');
  if (task.notes !== null && typeof task.notes !== 'string')
    issues.push('Task notes must be text.');
  if (!isDailyTaskKind(task.kind)) issues.push('Task kind is not supported.');
  if (!isTaskRecurrence(task.recurrence)) issues.push('Task recurrence is not supported.');
  if (!isTaskPriority(task.priority)) issues.push('Task priority is not supported.');
  if (typeof task.archived !== 'boolean') issues.push('Task archived state must be true or false.');
  if (task.scheduledTime !== null && !isTaskTime(task.scheduledTime)) {
    issues.push('Task time must use HH:mm local time.');
  }
  const selectedWeekdays = Array.isArray(task.selectedWeekdays) ? task.selectedWeekdays : [];
  if (
    !Array.isArray(task.selectedWeekdays) ||
    selectedWeekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    new Set(selectedWeekdays).size !== selectedWeekdays.length
  ) {
    issues.push('Selected weekdays must contain unique integers from 0 through 6.');
  }
  if (task.recurrence === 'daily') {
    if (task.scheduledDate !== null) issues.push('Daily tasks cannot have a specific date.');
    if (selectedWeekdays.length > 0) issues.push('Daily tasks cannot select weekdays.');
  }
  if (task.recurrence === 'selected_weekdays') {
    if (task.scheduledDate !== null) {
      issues.push('Selected-weekday tasks cannot have a specific date.');
    }
    if (selectedWeekdays.length === 0) {
      issues.push('Selected-weekday tasks require at least one weekday.');
    }
  }
  if (task.recurrence === 'specific_date') {
    if (!isLocalDateKey(task.scheduledDate)) {
      issues.push('One-off tasks require a valid local scheduled date.');
    }
    if (selectedWeekdays.length > 0) {
      issues.push('Specific-date tasks cannot select weekdays.');
    }
  }
  if (task.kind === 'routine' && task.recurrence === 'specific_date') {
    issues.push('Routine tasks must recur daily or on selected weekdays.');
  }
  if (task.kind === 'one_off' && task.recurrence !== 'specific_date') {
    issues.push('One-off tasks require a specific-date recurrence.');
  }
  if (task.kind !== 'practice' && task.linkedLearningItemId !== null) {
    issues.push('Only practice tasks can link to a learning item.');
  }
  if (
    task.linkedLearningItemId !== null &&
    (typeof task.linkedLearningItemId !== 'string' || !task.linkedLearningItemId.trim())
  ) {
    issues.push('Linked learning item id cannot be empty.');
  }
  if (!isIsoDateTime(task.createdAt)) issues.push('Task createdAt must be a valid date-time.');
  if (!isIsoDateTime(task.updatedAt)) issues.push('Task updatedAt must be a valid date-time.');
  return issues;
}

export function taskCompletionValidationIssues(completion: TaskCompletion): string[] {
  const issues: string[] = [];
  if (typeof completion.id !== 'string' || !completion.id.trim()) {
    issues.push('Task completion id is required.');
  }
  if (typeof completion.taskId !== 'string' || !completion.taskId.trim()) {
    issues.push('Task completion task id is required.');
  }
  if (!isLocalDateKey(completion.localDate)) {
    issues.push('Task completion local date must use YYYY-MM-DD.');
  }
  if (!isIsoDateTime(completion.completedAt)) {
    issues.push('Task completion completedAt must be a valid date-time.');
  }
  return issues;
}

export function cloneDailyTask(task: DailyTask): DailyTask {
  return { ...task, selectedWeekdays: [...task.selectedWeekdays] };
}

export function cloneTaskCompletion(completion: TaskCompletion): TaskCompletion {
  return { ...completion };
}

export function sortTaskOccurrences(occurrences: readonly TaskOccurrence[]): TaskOccurrence[] {
  const priorityOrder: Readonly<Record<TaskPriority, number>> = { high: 0, normal: 1, low: 2 };
  return [...occurrences].sort((left, right) => {
    const leftTime = left.task.scheduledTime ?? '99:99';
    const rightTime = right.task.scheduledTime ?? '99:99';
    return (
      leftTime.localeCompare(rightTime) ||
      priorityOrder[left.task.priority] - priorityOrder[right.task.priority] ||
      left.task.title.localeCompare(right.task.title) ||
      left.task.id.localeCompare(right.task.id)
    );
  });
}

export function isDailyTaskKind(value: unknown): value is DailyTaskKind {
  return typeof value === 'string' && (DAILY_TASK_KINDS as readonly string[]).includes(value);
}

export function isTaskRecurrence(value: unknown): value is TaskRecurrence {
  return typeof value === 'string' && (TASK_RECURRENCES as readonly string[]).includes(value);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

function calendarParts(localDate: string): { year: number; month: number; day: number } {
  if (!isLocalDateKey(localDate)) throw new Error(`Invalid local calendar date: ${localDate}`);
  const [yearText, monthText, dayText] = localDate.split('-');
  return { year: Number(yearText), month: Number(monthText), day: Number(dayText) };
}

function utcCalendarDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function utcDateKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}
