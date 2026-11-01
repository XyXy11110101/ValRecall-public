import { useDurableDraft } from '../shared/use-durable-draft';
import { DraftRecovery } from '../shared/DraftRecovery';
import { editState } from '../database/edit-commit';
import type { DraftRepository, DraftToken } from '../database/drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { requestEditorLeaveAsync, useEditProtection } from '../shared/edit-protection';

import type { DailyTask, DailyTaskKind, TaskPriority, TaskRecurrence } from '../models/daily-task';
import {
  addLocalCalendarDays,
  isLocalDateKey,
  isTaskTime,
  localDateKey,
} from '../models/daily-task';
import { learningItemTitle, type LearningItem } from '../database';
import { Notice } from '../shared/components';

export interface TaskFormValues {
  title: string;
  notes: string | null;
  kind: DailyTaskKind;
  recurrence: TaskRecurrence;
  scheduledDate: string | null;
  scheduledTime: string | null;
  selectedWeekdays: number[];
  linkedLearningItemId: string | null;
  priority: TaskPriority;
}

export type TaskFormDraft = TaskFormValues;

export interface TaskFormCommit {
  id: string;
  draft?: DraftToken;
  expectedState: string;
}
export function readTaskFormValues(value: unknown): TaskFormValues {
  if (!value || typeof value !== 'object' || value instanceof Blob || Array.isArray(value))
    throw new Error('任务草稿格式无效。');
  const row = value as Record<string, unknown>;
  if (
    typeof row.title !== 'string' ||
    !(row.notes === null || typeof row.notes === 'string') ||
    !['one_off', 'routine', 'practice'].includes(String(row.kind)) ||
    !['specific_date', 'daily', 'selected_weekdays'].includes(String(row.recurrence)) ||
    !['scheduledDate', 'scheduledTime', 'linkedLearningItemId'].every(
      (key) => row[key] === null || typeof row[key] === 'string',
    ) ||
    !Array.isArray(row.selectedWeekdays) ||
    !row.selectedWeekdays.every(
      (day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
    ) ||
    !['low', 'normal', 'high'].includes(String(row.priority))
  )
    throw new Error('任务草稿格式无效。');
  return value as unknown as TaskFormValues;
}
export interface TaskFormProps {
  initial: DailyTask | TaskFormDraft;
  learningItems: readonly LearningItem[];
  defaultLocalDate: string;
  submitLabel?: string;
  busy?: boolean;
  draftId?: string;
  draftRepository?: DraftRepository;
  onSubmit(
    values: TaskFormValues,
    commit: TaskFormCommit,
  ): boolean | void | Promise<boolean | void>;
  onCancel(): void;
  onOptionsOpen?(): void;
}

const WEEKDAYS = [
  { value: 0, label: '日' },
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
] as const;

export function createDefaultTaskDraft(today = localDateKey(new Date())): TaskFormDraft {
  return {
    title: '',
    notes: null,
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: today,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
  };
}

export function createPracticeTaskDraft(item: LearningItem, todayLocalDate: string): TaskFormDraft {
  const lesson = (item.recommendedAction || item.coreLesson || item.recallPrompt).trim();
  const conciseLesson = lesson.replace(/\s+/g, ' ').slice(0, 96);
  return {
    title: conciseLesson ? `练习：${conciseLesson}` : `练习 ${learningItemTitle(item)}`,
    notes:
      item.sourceType === 'text'
        ? `来自文字 Moment：${learningItemTitle(item)}。`
        : item.sourceType === 'image'
          ? `来自图片 Moment：${learningItemTitle(item)}。`
          : item.timestampDisplay
            ? `来自 ${item.videoTitle}，${item.timestampDisplay}。`
            : `来自视频 Moment：${item.videoTitle}。`,
    kind: 'practice',
    recurrence: 'specific_date',
    scheduledDate: addLocalCalendarDays(todayLocalDate, 1),
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: item.id,
    priority: 'normal',
  };
}

export function TaskForm({
  initial,
  learningItems,
  defaultLocalDate,
  submitLabel = '保存待办',
  busy = false,
  onSubmit,
  onCancel,
  onOptionsOpen,
  draftId: initialDraftId,
  draftRepository,
}: TaskFormProps) {
  const availableItemIds = useMemo(
    () => new Set(learningItems.map((item) => item.id)),
    [learningItems],
  );
  const initialMissingLink =
    initial.linkedLearningItemId !== null && !availableItemIds.has(initial.linkedLearningItemId);
  const [values, setValues] = useState<TaskFormValues>(() => ({
    title: initial.title,
    notes: initial.notes,
    kind: initial.kind,
    recurrence: initial.recurrence,
    scheduledDate: initial.scheduledDate,
    scheduledTime: initial.scheduledTime,
    selectedWeekdays: [...initial.selectedWeekdays],
    linkedLearningItemId: initialMissingLink ? null : initial.linkedLearningItemId,
    priority: initial.priority,
  }));
  const [issues, setIssues] = useState<string[]>([]);
  const dateDraft = useRef(initial.scheduledDate ?? defaultLocalDate);
  const baseline = useRef(JSON.stringify(values));
  const submitFocus = useRef<HTMLElement | null>(null);
  const [draftId, setDraftId] = useState<string>(() => initialDraftId ?? crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const [expectedState, setExpectedState] = useState(() => editState(initial));
  const editingId = 'id' in initial ? initial.id : null;
  const payload = useMemo(
    () => ({ id: draftId, targetId: editingId, expectedState, values: { ...values } }),
    [draftId, editingId, expectedState, values],
  );
  const dirty =
    JSON.stringify(values) !== baseline.current || (!editingId && values.title.length > 0);
  const durable = useDurableDraft({
    id: draftId,
    scope: editingId ? 'task:' + editingId : 'task-create',
    summary: values.title || '未完成任务',
    payload,
    dirty,
    ...(draftRepository ? { repository: draftRepository } : {}),
    onRestore(value, row) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value instanceof Blob ||
        value.id !== row.id ||
        value.targetId !== editingId ||
        typeof value.expectedState !== 'string'
      )
        throw new Error('任务草稿的编辑目标不一致。');
      const restored = readTaskFormValues(value.values);
      setValues(restored);
      setDraftId(row.id);
      setExpectedState(value.expectedState);
      baseline.current = '';
      setIssues([]);
      dateDraft.current = restored.scheduledDate ?? defaultLocalDate;
    },
  });
  useEditProtection({
    dirty: dirty && !durable.retained,
    busy: busy || saving,
    prepareLeave: durable.prepareLeave,
    draftVersion: durable.version,
  });
  useEffect(() => {
    if (busy) return;
    if (submitFocus.current?.isConnected && document.activeElement === document.body) {
      submitFocus.current.focus({ preventScroll: true });
    }
    submitFocus.current = null;
  }, [busy]);

  async function submit() {
    if (busy || locked.current) return;
    const normalized: TaskFormValues = {
      ...values,
      title: values.title.trim(),
      notes: values.notes?.trim() ? values.notes.trim() : null,
      scheduledDate: values.recurrence === 'specific_date' ? values.scheduledDate : null,
      scheduledTime: values.scheduledTime || null,
      selectedWeekdays:
        values.recurrence === 'selected_weekdays'
          ? [...values.selectedWeekdays].sort((left, right) => left - right)
          : [],
      linkedLearningItemId:
        values.kind === 'practice' &&
        values.linkedLearningItemId !== null &&
        availableItemIds.has(values.linkedLearningItemId)
          ? values.linkedLearningItemId
          : null,
    };
    const nextIssues = validateTaskForm(normalized);
    setIssues(nextIssues);
    if (nextIssues.length === 0) {
      submitFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      locked.current = true;
      setSaving(true);
      try {
        const token = await durable.flush();
        const saved = await onSubmit(normalized, {
          id: draftId,
          expectedState,
          ...(token ? { draft: token } : {}),
        });
        if (saved) durable.markCommitted();
      } catch (failure) {
        setIssues([failure instanceof Error ? failure.message : '草稿未能保存，请重试。']);
      } finally {
        locked.current = false;
        setSaving(false);
      }
    }
  }

  function changeRecurrence(recurrence: TaskRecurrence) {
    setIssues([]);
    if (values.scheduledDate) dateDraft.current = values.scheduledDate;
    setValues((current) => ({
      ...current,
      recurrence,
      kind:
        current.kind === 'practice'
          ? 'practice'
          : recurrence === 'specific_date'
            ? 'one_off'
            : 'routine',
      scheduledDate: recurrence === 'specific_date' ? dateDraft.current : null,
    }));
  }

  async function cancel() {
    if (busy || locked.current || !(await requestEditorLeaveAsync())) return;
    onCancel();
  }

  return (
    <section className="stack task-form" aria-labelledby="task-form-heading">
      <DraftRecovery draft={durable} disabled={busy || saving} />
      <fieldset className="reading-fields stack" disabled={busy || saving}>
        <h3 id="task-form-heading" tabIndex={-1}>
          {submitLabel === '创建待办' ? '创建待办' : '编辑待办'}
        </h3>
        {initialMissingLink && <Notice tone="warning">关联的学习条目已不存在。</Notice>}
        {issues.length > 0 && <Notice tone="error">{issues.join(' ')}</Notice>}
        <label className="field">
          <span>标题</span>
          <input
            required
            value={values.title}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (!event.nativeEvent.isComposing && event.keyCode !== 229) submit();
            }}
            onChange={(event) =>
              setValues((current) => ({ ...current, title: event.target.value }))
            }
          />
        </label>
        <div className="field-grid task-schedule-fields">
          {values.recurrence === 'specific_date' && (
            <label className="field">
              <span>指定日期</span>
              <input
                type="date"
                required
                value={values.scheduledDate ?? ''}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setValues((current) => ({ ...current, scheduledDate: value || null }));
                }}
              />
            </label>
          )}
          <label className="field">
            <span>重复</span>
            <select
              value={values.recurrence}
              onChange={(event) => changeRecurrence(event.target.value as TaskRecurrence)}
            >
              <option value="specific_date">不重复</option>
              <option value="daily">每天</option>
              <option value="selected_weekdays">选定星期</option>
            </select>
          </label>
        </div>
        {values.recurrence === 'selected_weekdays' && (
          <fieldset className="task-weekdays">
            <legend>星期</legend>
            <div className="cluster">
              {WEEKDAYS.map((weekday) => (
                <label key={weekday.value}>
                  <input
                    type="checkbox"
                    checked={values.selectedWeekdays.includes(weekday.value)}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        selectedWeekdays: event.target.checked
                          ? [...current.selectedWeekdays, weekday.value]
                          : current.selectedWeekdays.filter((value) => value !== weekday.value),
                      }))
                    }
                  />
                  <span>{weekday.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <details
          className="task-form-options"
          onToggle={(event) => {
            if (event.currentTarget.open) onOptionsOpen?.();
          }}
        >
          <summary>更多选项</summary>
          <div className="stack">
            <label className="field">
              <span>备注</span>
              <textarea
                value={values.notes ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, notes: event.target.value || null }))
                }
              />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>优先级</span>
                <select
                  value={values.priority}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      priority: event.target.value as TaskPriority,
                    }))
                  }
                >
                  <option value="low">低</option>
                  <option value="normal">普通</option>
                  <option value="high">高</option>
                </select>
              </label>
              <label className="field">
                <span>计划时间（可选）</span>
                <input
                  type="time"
                  value={values.scheduledTime ?? ''}
                  onInput={(event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({ ...current, scheduledTime: value || null }));
                  }}
                />
              </label>
            </div>
            <label className="field">
              <span>关联学习条目（可选）</span>
              <select
                value={values.linkedLearningItemId ?? ''}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    kind: event.target.value ? 'practice' : current.kind,
                    linkedLearningItemId: event.target.value || null,
                  }))
                }
              >
                <option value="">不关联学习条目</option>
                {learningItems.map((item) => (
                  <option value={item.id} key={item.id}>
                    {learningItemTitle(item)}
                  </option>
                ))}
              </select>
            </label>
            {values.kind === 'practice' && <p className="muted small">学习练习</p>}
          </div>
        </details>
        <div className="cluster form-actions">
          <button className="button" type="button" aria-busy={busy || saving} onClick={submit}>
            {submitLabel}
          </button>
          <button className="button secondary" type="button" onClick={cancel}>
            取消
          </button>
        </div>
      </fieldset>
    </section>
  );
}

export function validateTaskForm(values: TaskFormValues): string[] {
  const issues: string[] = [];
  if (!values.title.trim()) issues.push('请填写标题。');
  if (values.scheduledTime !== null && !isTaskTime(values.scheduledTime)) {
    issues.push('时间必须使用 HH:mm。');
  }
  if (values.recurrence === 'selected_weekdays' && values.selectedWeekdays.length === 0) {
    issues.push('请至少选择一个星期。');
  }
  if (values.recurrence === 'specific_date' && !isLocalDateKey(values.scheduledDate)) {
    issues.push('请选择有效的指定日期。');
  }
  if (values.kind === 'routine' && values.recurrence === 'specific_date') {
    issues.push('重复待办需要选择每天或选定星期。');
  }
  if (values.kind === 'one_off' && values.recurrence !== 'specific_date') {
    issues.push('一次性待办需要指定日期。');
  }
  return issues;
}
