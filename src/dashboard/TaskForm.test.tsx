import { installDraftMemoryPort } from '../testing/draft-port';
import { DraftRepository } from '../database/drafts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DailyTask, VideoLearningItem } from '../database';
import {
  createDefaultTaskDraft,
  createPracticeTaskDraft,
  TaskForm,
  validateTaskForm,
} from './TaskForm';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-07-22T12:00:00.000Z');

describe('TaskForm', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installDraftMemoryPort();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it.each([
    {
      label: 'daily',
      values: { kind: 'routine', recurrence: 'daily', scheduledDate: null, selectedWeekdays: [] },
    },
    {
      label: 'weekdays',
      values: {
        kind: 'routine',
        recurrence: 'selected_weekdays',
        scheduledDate: null,
        selectedWeekdays: [1, 3],
      },
    },
    {
      label: 'one-off',
      values: {
        kind: 'one_off',
        recurrence: 'specific_date',
        scheduledDate: '2026-07-22',
        selectedWeekdays: [],
      },
    },
  ] as const)('keeps $label scheduling in the same todo form and model', async ({ values }) => {
    const onSubmit = vi.fn();
    render(
      {
        ...createDefaultTaskDraft(),
        ...values,
        selectedWeekdays: [...values.selectedWeekdays],
        title: '同一份待办',
      },
      onSubmit,
    );
    expect(container.querySelector('#task-form-heading')?.textContent).toBe('创建待办');
    expect(container.textContent).not.toContain('创建 +5 元');
    expect(field<HTMLInputElement>('标题', 'input').placeholder).toBe('');
    expect(container.querySelector('.task-form-options')?.hasAttribute('open')).toBe(false);
    await act(async () => textButton('创建待办')?.click());
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        ...values,
        selectedWeekdays: [...values.selectedWeekdays],
        title: '同一份待办',
      }),
      expect.objectContaining({ id: expect.any(String), expectedState: expect.any(String) }),
    );
  });

  it('keeps the submit label steady while saving and leaves the shared spinner to aria-busy', async () => {
    await act(async () =>
      root.render(
        <TaskForm
          initial={createDefaultTaskDraft('2026-07-22')}
          learningItems={[]}
          defaultLocalDate="2026-07-22"
          submitLabel="创建待办"
          busy
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />,
      ),
    );
    const submit = textButton('创建待办');
    expect(submit).toBeDefined();
    expect(submit?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).not.toContain('正在保存');
  });

  it('requires a title and at least one selected weekday', async () => {
    const onSubmit = vi.fn();
    render(createDefaultTaskDraft(), onSubmit);

    await act(async () => textButton('创建待办')?.click());
    expect(container.textContent).toContain('请填写标题。');
    expect(onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      const title = field<HTMLInputElement>('标题', 'input');
      setControlValue(title, 'Read setup notes');
      const recurrence = field<HTMLSelectElement>('重复', 'select');
      setControlValue(recurrence, 'selected_weekdays');
    });
    await act(async () => textButton('创建待办')?.click());

    expect(container.textContent).toContain('请至少选择一个星期。');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('normalizes a valid weekday task before submission', async () => {
    const onSubmit = vi.fn();
    render(createDefaultTaskDraft(), onSubmit);

    await act(async () => {
      const title = field<HTMLInputElement>('标题', 'input');
      setControlValue(title, '  Practise movement  ');
      const recurrence = field<HTMLSelectElement>('重复', 'select');
      setControlValue(recurrence, 'selected_weekdays');
    });
    await act(async () => {
      const monday = [
        ...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((input) => input.parentElement?.textContent?.includes('一'));
      monday?.click();
    });
    await act(async () => textButton('创建待办')?.click());

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Practise movement',
        kind: 'routine',
        recurrence: 'selected_weekdays',
        selectedWeekdays: [1],
      }),
      expect.objectContaining({ id: expect.any(String), expectedState: expect.any(String) }),
    );
  });

  it('prefills an editable, linked Practice task for tomorrow', async () => {
    const item = learningItem();
    const draft = createPracticeTaskDraft(item, '2026-07-22');
    const onSubmit = vi.fn();
    render(draft, onSubmit, [item]);

    expect(draft).toMatchObject({
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-23',
      linkedLearningItemId: item.id,
    });
    expect(field<HTMLInputElement>('标题', 'input').value).toContain('Hold one angle');
    expect(field<HTMLSelectElement>('关联学习条目（可选）', 'select').value).toBe(item.id);

    await act(async () => {
      const title = field<HTMLInputElement>('标题', 'input');
      setControlValue(title, 'Explain this setup aloud');
      textButton('创建待办')?.click();
    });
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Explain this setup aloud',
        linkedLearningItemId: item.id,
      }),
      expect.objectContaining({ id: expect.any(String), expectedState: expect.any(String) }),
    );
  });

  it('clears an unavailable imported learning-item link safely', async () => {
    const initial: DailyTask = {
      ...createDefaultTaskDraft(),
      id: 'practice-missing-link',
      schemaVersion: 1,
      title: 'Practise safely',
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-22',
      linkedLearningItemId: 'missing-item',
      archived: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const onSubmit = vi.fn();
    render(initial, onSubmit);

    expect(container.textContent).toContain('关联的学习条目已不存在');
    await act(async () => textButton('创建待办')?.click());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ linkedLearningItemId: null }),
      expect.objectContaining({ id: expect.any(String), expectedState: expect.any(String) }),
    );
  });

  it('validates a one-off date and an optional local time', () => {
    expect(
      validateTaskForm({
        ...createDefaultTaskDraft(),
        title: 'One-off',
        kind: 'one_off',
        recurrence: 'specific_date',
        scheduledDate: null,
        scheduledTime: '25:10',
      }),
    ).toEqual(expect.arrayContaining(['时间必须使用 HH:mm。', '请选择有效的指定日期。']));
  });

  it('defaults to today once, submits Enter outside composition and keeps optional input', async () => {
    const onSubmit = vi.fn();
    render(createDefaultTaskDraft('2026-07-22'), onSubmit);
    const title = field<HTMLInputElement>('标题', 'input');
    await act(async () => setControlValue(title, '读完这一章'));
    await act(async () =>
      title.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }),
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () =>
      title.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 229 }),
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () =>
      title.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '读完这一章',
        kind: 'one_off',
        recurrence: 'specific_date',
        scheduledDate: '2026-07-22',
      }),
      expect.objectContaining({ id: expect.any(String), expectedState: expect.any(String) }),
    );
    const options = container.querySelector('details')!;
    await act(async () => {
      options.open = true;
    });
    const notes = field<HTMLTextAreaElement>('备注', 'textarea');
    await act(async () => setControlValue(notes, '一段备注\n继续写'));
    await act(async () => {
      options.open = false;
      options.open = true;
    });
    expect(notes.value).toBe('一段备注\n继续写');
    await act(async () =>
      notes.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('keeps input after draft failure and closes only after the latest input is retained', async () => {
    const onCancel = vi.fn();
    await act(async () =>
      root.render(
        <TaskForm
          initial={createDefaultTaskDraft('2026-07-22')}
          defaultLocalDate="2026-07-22"
          learningItems={[]}
          onSubmit={() => undefined}
          onCancel={onCancel}
        />,
      ),
    );
    await act(async () =>
      setControlValue(field<HTMLInputElement>('标题', 'input'), '保留这份草稿'),
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    vi.spyOn(DraftRepository.prototype, 'save').mockRejectedValueOnce(new Error('草稿写入失败'));
    await act(async () => textButton('取消')?.click());
    expect(onCancel).not.toHaveBeenCalled();
    expect(field<HTMLInputElement>('标题', 'input').value).toBe('保留这份草稿');
    expect(confirm).not.toHaveBeenCalled();
    await act(async () => textButton('取消')?.click());
    expect(onCancel).toHaveBeenCalledOnce();
    expect((await new DraftRepository().list('task-create'))[0]?.payload).toMatchObject({
      values: { title: '保留这份草稿' },
    });
    confirm.mockRestore();
  });

  function render(
    initial: Parameters<typeof TaskForm>[0]['initial'],
    onSubmit: ReturnType<typeof vi.fn>,
    items: VideoLearningItem[] = [],
  ) {
    act(() => {
      root.render(
        <TaskForm
          initial={initial}
          learningItems={items}
          defaultLocalDate="2026-07-22"
          submitLabel="创建待办"
          onSubmit={onSubmit}
          onCancel={() => undefined}
        />,
      );
    });
  }

  function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    label: string,
    selector: string,
  ): T {
    const wrapper = [...container.querySelectorAll('label')].find((entry) =>
      entry.querySelector('span')?.textContent?.includes(label),
    );
    const control = wrapper?.querySelector<T>(selector);
    if (!control) throw new Error(`Expected ${label} field.`);
    return control;
  }

  function textButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  }

  function setControlValue(
    control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    value: string,
  ): void {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set;
    setter?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  }
});

function learningItem(): VideoLearningItem {
  return {
    id: 'learning-item-1',
    schemaVersion: 2,
    platform: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    videoId: 'abcdefghijk',
    videoTitle: 'Angle setup',
    uploader: null,
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: '',
    situation: '',
    coreLesson: 'Hold one angle at a time.',
    mistakeToAvoid: '',
    recommendedAction: 'Hold one angle at a time.',
    reason: '',
    recallPrompt: 'What should you do?',
    referenceAnswer: 'Hold one angle.',
    tags: [],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
}
