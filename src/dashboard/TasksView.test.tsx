import { installDraftMemoryPort } from '../testing/draft-port';
import { DraftRepository } from '../database/drafts';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DailyTask, TaskCompletion, TaskDaySummary, VideoLearningItem } from '../database';
import { createPracticeTaskDraft } from './TaskForm';
import { TasksView, type TaskDashboardRepository, type TaskEditorRequest } from './TasksView';
import { TASK_CELEBRATION_MS } from '../shared/task-celebration';
import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import {
  applyTaskCompletionReward,
  applyTaskCompletionReversal,
  applyTaskCreationReward,
  DEFAULT_ALLOWANCE,
  TASK_CREATION_REWARD,
  TASK_REWARD,
} from '../shared/allowance';
import { REFRESH_REVEAL_DELAY_MS } from '../shared/use-delayed-flag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date(2026, 6, 22, 12, 0, 0);
type AtomicResult = Awaited<
  ReturnType<NonNullable<TaskDashboardRepository['changeTaskCompletionAtomic']>>
>;
const today = '2026-07-22';

describe('TasksView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installDraftMemoryPort();
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    container.remove();
    vi.useRealTimers();
  });

  it('uses one todo list for daily, weekday and one-off entries with the current reward', async () => {
    const daily = task('daily-todo', '每天阅读');
    const weekly = task('weekly-todo', '每周整理', {
      recurrence: 'selected_weekdays',
      selectedWeekdays: [3],
    });
    const once = task('one-off-todo', '今天办一件事', {
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: today,
    });
    const entries = [daily, weekly, once];
    const repository = fakeRepository({
      tasks: entries,
      summary: {
        localDate: today,
        total: entries.length,
        completed: 0,
        remaining: entries.length,
        occurrences: entries.map((entry) => ({ task: entry, localDate: today, completion: null })),
      },
    });
    await render(repository);
    expect(container.querySelector('#tasks-heading')?.textContent).toBe('待办');
    // The amounts are unchanged; the page just no longer spells them out.
    expect(TASK_REWARD).toBe(5);
    expect(TASK_CREATION_REWARD).toBe(5);
    expect(container.textContent).not.toContain('创建 +5 元');
    expect(filterSelect('类型').options[0]?.textContent).toBe('全部');
    expect(filterSelect('优先级').options[0]?.textContent).toBe('全部');
    expect(textButton('添加待办')).toBeDefined();
    const todayIds = [...container.querySelectorAll<HTMLElement>('[data-task-id]')]
      .map((row) => row.dataset.taskId)
      .sort();
    expect(todayIds).toEqual(entries.map((entry) => entry.id).sort());
    await act(async () => textButton('全部进行中')?.click());
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-task-id]')]
        .map((row) => row.dataset.taskId)
        .sort(),
    ).toEqual(todayIds);
    expect(repository.createTask).not.toHaveBeenCalled();
  });

  it('ignores late queries and retains existing tasks when refresh fails', async () => {
    const staleTask = task('old', 'Old result');
    const currentTask = task('new', 'Latest result');
    const repository = fakeRepository({ tasks: [currentTask], summary: taskSummary(currentTask) });
    let resolve!: (value: TaskDaySummary) => void;
    vi.mocked(repository.getTaskDaySummary).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const clock = () => now;
    await act(async () =>
      root.render(
        <TasksView
          revision={0}
          onChanged={() => undefined}
          taskRepository={repository}
          clock={clock}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <TasksView
          revision={1}
          onChanged={() => undefined}
          taskRepository={repository}
          clock={clock}
        />,
      ),
    );
    await act(async () => resolve(taskSummary(staleTask)));
    expect(container.textContent).toContain('Latest result');
    expect(container.textContent).not.toContain('Old result');
    vi.mocked(repository.getTaskDaySummary).mockRejectedValueOnce(new Error('refresh failed'));
    await act(async () =>
      root.render(
        <TasksView
          revision={2}
          onChanged={() => undefined}
          taskRepository={repository}
          clock={clock}
        />,
      ),
    );
    expect(container.textContent).toContain('Latest result');
    expect(container.textContent).toContain('refresh failed');
    await act(async () => textButton('重新加载待办')!.click());
    expect(container.textContent).not.toContain('refresh failed');
  });

  it('shows Today counts and keeps complete and undo actions date-scoped', async () => {
    const routine = task('routine-1', 'Daily warm-up');
    const practice = task('practice-1', 'Practise one angle', {
      kind: 'practice',
      linkedLearningItemId: 'learning-1',
    });
    const completion = completed(practice.id);
    const repository = fakeRepository({
      tasks: [routine, practice],
      completions: [completion],
      summary: taskSummary(routine, practice, completion),
      items: [learningItem()],
    });
    await render(repository);

    expect(repository.listItems).toHaveBeenCalledWith({ includeReviewHistory: false });

    expect(container.textContent).toContain('2全部');
    expect(container.textContent).toContain('1已完成');
    expect(container.textContent).toContain('1剩余');
    expect(container.querySelector('.task-summary')?.textContent).not.toContain('零花钱');
    expect(container.textContent).toContain('关联 Angle setup');

    await act(async () => {
      ariaButton('完成 Daily warm-up')?.click();
      await Promise.resolve();
    });
    expect(repository.completeTaskForDateWithResult).toHaveBeenCalledWith(routine.id, today);
    // Spoken by the hidden status line only; no visible result line or banner.
    expect(
      container.querySelector('.tasks-refresh-slot .sr-only[role="status"]')?.textContent,
    ).toBe(`今天的待办都完成了，+${TASK_REWARD} 元零花钱。`);
    expect(container.querySelector('.notice')).toBeNull();

    await act(async () => {
      ariaButton('撤销 Practise one angle')?.click();
      await Promise.resolve();
    });
    expect(repository.undoTaskCompletion).toHaveBeenCalledWith(practice.id, today);
  });

  it('supports sections, filters, archive, restore, history undo, and confirmed deletion', async () => {
    const routine = task('routine-1', 'Daily warm-up');
    const practice = task('practice-1', 'Practise one angle', {
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-23',
      linkedLearningItemId: 'missing-item',
      priority: 'high',
    });
    const archived = task('archived-1', 'Archived routine', { archived: true });
    const completion = completed(routine.id);
    const repository = fakeRepository({
      tasks: [routine, practice, archived],
      completions: [completion],
      summary: taskSummary(routine),
    });
    await render(repository);

    await act(async () => textButton('即将到来')?.click());
    expect(container.textContent).toContain('Practise one angle');
    expect(container.textContent).toContain('关联的学习条目不可用');

    await act(async () => {
      const kind = filterSelect('类型');
      setControlValue(kind, 'practice');
    });
    expect(container.textContent).not.toContain('Daily warm-up');
    expect(container.textContent).toContain('Practise one angle');

    await act(async () => {
      const kind = filterSelect('类型');
      setControlValue(kind, 'all');
      textButton('全部进行中')?.click();
    });
    const spoken = () =>
      container.querySelector('.tasks-refresh-slot .sr-only[role="status"]')?.textContent;
    await act(async () => {
      firstTextButton('归档')?.click();
      await Promise.resolve();
    });
    expect(repository.archiveTask).toHaveBeenCalledWith(expect.any(String), true);
    expect(spoken()).toBe('待办已归档。');
    expect(container.querySelector('.notice')).toBeNull();

    await act(async () => textButton('已归档')?.click());
    await act(async () => {
      textButton('取消归档')?.click();
      await Promise.resolve();
    });
    expect(repository.archiveTask).toHaveBeenCalledWith(archived.id, false);
    expect(spoken()).toBe('已取消归档。');
    expect(container.querySelector('.notice')).toBeNull();

    await act(async () => textButton('完成记录')?.click());
    expect(container.textContent).toContain('安排日期：');
    // Everything in this section is finished, so no row repeats 已完成.
    expect(container.querySelector('.task-section-content')?.textContent).not.toContain('已完成');
    expect(container.querySelector('.task-section-content .pill')).toBeNull();
    await act(async () => {
      textButton('撤销完成')?.click();
      await Promise.resolve();
    });
    expect(repository.undoTaskCompletion).toHaveBeenCalledWith(routine.id, today);

    await act(async () => textButton('全部进行中')?.click());
    await act(async () => {
      firstTextButton('删除')?.click();
      await Promise.resolve();
    });
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(repository.deleteTask).toHaveBeenCalled();
    expect(spoken()).toBe('已删除。');
    expect(container.querySelector('.notice')).toBeNull();
    // Whatever the 工作中 card held for that task goes with it.
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'valrecall.workingCard': expect.objectContaining({ current: null, notes: [] }),
    });
  });

  it('creates and edits tasks through the validated form', async () => {
    const routine = task('routine-1', 'Daily warm-up');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    await render(repository);

    await act(async () => textButton('添加待办')?.click());
    await act(async () => {
      const title = formField<HTMLInputElement>('标题', 'input');
      setControlValue(title, '  New routine  ');
    });
    await act(async () => {
      textButton('创建待办')?.click();
      await Promise.resolve();
    });
    expect(repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New routine',
        recurrence: 'specific_date',
        scheduledDate: today,
      }),
      expect.objectContaining({ id: expect.any(String), revision: expect.any(Number) }),
    );

    await act(async () => textButton('全部进行中')?.click());
    await act(async () => firstTextButton('编辑')?.click());
    await act(async () => {
      const title = formField<HTMLInputElement>('标题', 'input');
      setControlValue(title, 'Updated warm-up');
    });
    await act(async () => {
      textButton('保存待办')?.click();
      await Promise.resolve();
    });
    expect(repository.updateTask).toHaveBeenCalledWith(
      routine.id,
      expect.objectContaining({ title: 'Updated warm-up' }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(
      container.querySelector('.tasks-refresh-slot .sr-only[role="status"]')?.textContent,
    ).toBe('待办已更新。');
    expect(container.querySelector('.notice')).toBeNull();
  });

  it('shows a failed archive visibly, then clears it on the next success', async () => {
    const routine = task('routine-1', 'Daily warm-up');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    await render(repository);
    vi.mocked(repository.archiveTask).mockRejectedValueOnce(new Error('archive failed'));
    await act(async () => {
      firstTextButton('归档')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.notice.error')?.textContent).toContain('archive failed');
    await act(async () => {
      firstTextButton('归档')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.notice')).toBeNull();
    expect(
      container.querySelector('.tasks-refresh-slot .sr-only[role="status"]')?.textContent,
    ).toBe('待办已归档。');
  });

  it('keeps each row to what helps: no 普通 pill, and no date on the Today page', async () => {
    const normal = task('normal', 'Normal task', { scheduledTime: '09:30' });
    const high = task('high', 'High task', { priority: 'high' });
    const low = task('low', 'Low task', { priority: 'low' });
    const later = task('later', 'Later task', {
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-23',
    });
    const entries = [normal, high, low];
    await render(
      fakeRepository({
        tasks: [...entries, later],
        summary: {
          localDate: today,
          total: entries.length,
          completed: 0,
          remaining: entries.length,
          occurrences: entries.map((entry) => ({
            task: entry,
            localDate: today,
            completion: null,
          })),
        },
      }),
    );
    const pills = (id: string) =>
      [...container.querySelectorAll(`[data-task-id="${id}"] .pill`)].map(
        (pill) => pill.textContent,
      );
    expect(pills('normal')).toEqual(['重复待办', '09:30']);
    expect(pills('high')).toEqual(['重复待办', '高']);
    expect(pills('low')).toEqual(['重复待办', '低']);
    const date = (year: number, month: number, day: number) =>
      new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
        new Date(year, month - 1, day, 12),
      );
    expect(container.querySelector('[data-task-id="normal"]')?.textContent).not.toContain(
      date(2026, 7, 22),
    );
    // A row in 即将到来 still needs its date.
    await act(async () => textButton('即将到来')?.click());
    expect(container.querySelector('[data-task-id="later"]')?.textContent).toContain(
      date(2026, 7, 23),
    );
  });

  it('waits for learning items before opening a Library practice draft', async () => {
    const item = learningItem();
    let resolveItems: ((items: VideoLearningItem[]) => void) | undefined;
    const itemsPromise = new Promise<VideoLearningItem[]>((resolve) => {
      resolveItems = resolve;
    });
    const repository = fakeRepository({ items: [] });
    vi.mocked(repository.listItems).mockReturnValue(itemsPromise);
    const request: TaskEditorRequest = {
      key: 1,
      mode: 'create',
      initial: createPracticeTaskDraft(item, today),
    };

    await act(async () => {
      root.render(
        <TasksView
          revision={0}
          onChanged={() => undefined}
          editorRequest={request}
          taskRepository={repository}
          clock={() => now}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('正在加载待办');
    expect(container.textContent).not.toContain('关联的学习条目已不存在');

    await act(async () => {
      resolveItems?.([item]);
      await itemsPromise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('创建待办');
    expect(container.textContent).not.toContain('关联的学习条目已不存在');
    expect(formField<HTMLSelectElement>('关联学习条目（可选）', 'select').value).toBe(item.id);
  });

  it('stamps a committed completion for one celebration and cleans its timers', async () => {
    const routine = task('confirmation', 'Confirm this task');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    await render(repository);
    vi.useFakeTimers();

    await act(async () => {
      ariaButton('完成 Confirm this task')?.click();
      await Promise.resolve();
    });
    const row = () => container.querySelector('[data-task-id="confirmation"]');
    const seal = row()?.querySelector('.task-celebration-seal');
    expect(seal?.getAttribute('aria-hidden')).toBe('true');
    expect(seal?.getAttribute('data-celebration-origin')).toBeTruthy();
    // The result is spoken by the hidden status line, with Home's wording; nothing visible
    // appears above or beside the list.
    const spoken = container.querySelector('.tasks-refresh-slot [role="status"]');
    expect(spoken?.classList.contains('sr-only')).toBe(true);
    expect(spoken?.textContent).toBe(`今天的待办都完成了，+${TASK_REWARD} 元零花钱。`);
    expect(container.querySelector('.tasks-feedback-line')).toBeNull();
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(row()?.classList.contains('task-motion-completed')).toBe(false);

    await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.total - 1));
    expect(row()?.querySelector('.task-celebration-seal')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(row()?.querySelector('.task-celebration-seal')).toBeNull();

    await act(async () => {
      ariaButton('完成 Confirm this task')?.click();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root.render(<></>));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a warning visible and reveals only a slow refresh in its reserved slot', async () => {
    const routine = task('slow', 'Slow refresh');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    repository.changeTaskCompletionAtomic = vi.fn(async () => ({
      changed: true,
      reward: null,
      warning: '奖励暂未确认，请稍后查看零花钱。',
    }));
    await render(repository);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finish!: (summary: TaskDaySummary) => void;
    vi.mocked(repository.getTaskDaySummary).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      ariaButton('完成 Slow refresh')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.notice.warning')?.textContent).toBe(
      '奖励暂未确认，请稍后查看零花钱。',
    );
    expect(container.querySelector('.tasks-refresh-slot [role="status"]')?.textContent).toBe('');
    expect(container.textContent).not.toContain('正在刷新待办');
    await act(async () => vi.advanceTimersByTime(REFRESH_REVEAL_DELAY_MS));
    expect(container.querySelector('.tasks-refresh-slot')?.textContent).toContain('正在刷新待办');
    await act(async () => finish(taskSummary(routine)));
    expect(container.textContent).not.toContain('正在刷新待办');
  });

  it('flies the committed creation grant to the header wallet, in every section', async () => {
    const places = placeOnScreen({
      '[data-celebration-origin]': [300, 600],
      '[data-wallet-target="tasks-header"]': [900, 80],
      '[data-celebration-fallback]': [1000, 80],
    });
    try {
      const repository = fakeRepository({ summary: emptySummary() });
      const created: DailyTask[] = [];
      repository.createTaskWithReward = vi.fn(async (input) => {
        const saved = { ...task(input.id ?? 'created', input.title), ...input };
        created.push(saved);
        vi.mocked(repository.listTasks).mockResolvedValue([...created]);
        return {
          task: saved,
          reward: applyTaskCreationReward(
            { ...DEFAULT_ALLOWANCE, balance: 3 },
            today,
            now.toISOString(),
          ),
        };
      });
      await render(repository);
      const header = () =>
        container.querySelector('.tasks-wallet-chip [data-wallet-target="tasks-header"]');
      expect(header()?.textContent).toBe('—');
      await act(async () => textButton('添加待办')?.click());
      await act(async () => setControlValue(formField('标题', 'input'), '下周再做'));
      await act(async () => setControlValue(formField('日期', 'input'), '2026-07-29'));
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      await act(async () => {
        textButton('创建待办')?.click();
        await Promise.resolve();
      });
      expect(repository.createTask).not.toHaveBeenCalled();
      // A future todo lands in 即将到来, which has no summary wallet; the header chip is there.
      expect(
        container.querySelector('[data-task-section="upcoming"]')?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(header()?.textContent).toBe(String(3 + TASK_CREATION_REWARD));
      expect(container.querySelector('.notice')).toBeNull();
      expect(container.querySelector('.tasks-refresh-slot [role="status"]')?.textContent).toBe(
        `待办已创建，+${TASK_CREATION_REWARD} 元零花钱。`,
      );
      const row = container.querySelector<HTMLElement>(`[data-task-id="${created[0]?.id}"]`);
      expect(document.activeElement).toBe(row);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      const coin = document.body.querySelector<HTMLElement>('.task-coin-layer .task-coin');
      expect(coin?.style.getPropertyValue('--coin-x')).toBe('310px');
      expect(coin?.style.getPropertyValue('--coin-dx')).toBe('600px');
      // Never a completion seal and never any praise for a creation.
      expect(container.querySelector('.task-celebration-seal')).toBeNull();
      focus.mockRestore();
    } finally {
      places.mockRestore();
    }
  });

  it('creates a Library practice draft in 即将到来 with the coin landing on the header', async () => {
    const places = placeOnScreen({
      '[data-celebration-origin]': [300, 600],
      '[data-wallet-target]': [900, 80],
    });
    try {
      const item = learningItem();
      const repository = fakeRepository({ items: [item] });
      repository.createTaskWithReward = vi.fn(async (input) => {
        const saved = { ...task(input.id ?? 'practice', input.title), ...input };
        vi.mocked(repository.listTasks).mockResolvedValue([saved]);
        return { task: saved, reward: applyTaskCreationReward(DEFAULT_ALLOWANCE, today) };
      });
      await act(async () =>
        root.render(
          <TasksView
            revision={0}
            onChanged={() => undefined}
            editorRequest={{
              key: 1,
              mode: 'create',
              initial: createPracticeTaskDraft(item, today),
            }}
            taskRepository={repository}
            clock={() => now}
          />,
        ),
      );
      await act(async () => {
        textButton('创建待办')?.click();
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-task-section="upcoming"]')?.getAttribute('aria-selected'),
      ).toBe('true');
      expect(container.querySelectorAll('[data-wallet-target]')).toHaveLength(1);
      expect(document.body.querySelector('.task-coin-layer .task-coin')).not.toBeNull();
    } finally {
      places.mockRestore();
    }
  });

  it('shows no coin and a plain announcement when no grant was committed', async () => {
    const places = placeOnScreen({
      '[data-celebration-origin]': [300, 600],
      '[data-wallet-target]': [900, 80],
    });
    try {
      const repository = fakeRepository();
      await render(repository);
      await act(async () => textButton('添加待办')?.click());
      await act(async () => setControlValue(formField('标题', 'input'), '旧版仓库'));
      await act(async () => {
        textButton('创建待办')?.click();
        await Promise.resolve();
      });
      expect(repository.createTask).toHaveBeenCalledOnce();
      expect(container.querySelector('.tasks-refresh-slot [role="status"]')?.textContent).toBe(
        '待办已创建。',
      );
      expect(document.body.querySelector('.task-coin-layer')).toBeNull();
    } finally {
      places.mockRestore();
    }
  });

  it('shows the creation amount at the new row when a long list scrolls the wallet away', async () => {
    // The new row sits at the end of a long 即将到来 list: bringing it into view scrolls the
    // header chip off screen, and nothing else in that section is a wallet.
    const places = placeOnScreen({
      '[data-celebration-origin]': [300, 600],
      '[data-wallet-target="tasks-header"]': [900, -653],
    });
    try {
      const upcoming = Array.from({ length: 8 }, (_, index) =>
        task(`later-${index}`, `之后 ${index}`, {
          kind: 'one_off',
          recurrence: 'specific_date',
          scheduledDate: '2026-07-24',
        }),
      );
      const create = async (title: string) => {
        const repository = fakeRepository({ tasks: upcoming });
        repository.createTaskWithReward = vi.fn(async (input) => {
          const saved = { ...task(input.id ?? 'created', input.title), ...input };
          vi.mocked(repository.listTasks).mockResolvedValue([...upcoming, saved]);
          return { task: saved, reward: applyTaskCreationReward(DEFAULT_ALLOWANCE, today) };
        });
        await render(repository);
        await act(async () => textButton('添加待办')?.click());
        await act(async () => setControlValue(formField('标题', 'input'), title));
        await act(async () => setControlValue(formField('日期', 'input'), '2026-07-28'));
        await act(async () => {
          textButton('创建待办')?.click();
          await Promise.resolve();
        });
      };
      await create('六天后');
      const origin = container.querySelector<HTMLElement>('[data-celebration-origin]');
      // The coin starts at the title text itself, not the middle of the full-width heading.
      expect(origin?.tagName).toBe('SPAN');
      expect(origin?.parentElement?.tagName).toBe('H3');
      expect(origin?.textContent).toBe('六天后');
      const tag = document.body.querySelector<HTMLElement>('.task-coin-layer .task-coin-tag');
      expect(tag?.classList.contains('at-origin')).toBe(true);
      expect(tag?.textContent).toBe(`+${TASK_CREATION_REWARD} 元`);
      expect(tag?.style.getPropertyValue('--tag-x')).toBe('310px');
      expect(document.body.querySelector('.task-coin.is-rising')).not.toBeNull();

      // Reduced motion: no coin, but the static receipt still appears at the row.
      await act(async () => root.unmount());
      root = createRoot(container);
      vi.stubGlobal('matchMedia', () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      await create('安静模式');
      expect(document.body.querySelector('.task-coin')).toBeNull();
      expect(document.body.querySelector('.task-coin-tag.is-static.at-origin')?.textContent).toBe(
        `+${TASK_CREATION_REWARD} 元`,
      );
    } finally {
      vi.unstubAllGlobals();
      places.mockRestore();
    }
  });

  it('announces an identical warning again for the next result', async () => {
    const alpha = task('alpha', 'Alpha');
    const beta = task('beta', 'Beta');
    const repository = fakeRepository({ tasks: [alpha, beta], summary: taskSummary(alpha, beta) });
    const warning = '已完成，零花钱没更新，请到零花钱页核对。';
    repository.changeTaskCompletionAtomic = vi.fn(async () => ({
      changed: true,
      reward: null,
      warning,
    }));
    await render(repository);
    await act(async () => {
      ariaButton('完成 Alpha')?.click();
      await Promise.resolve();
    });
    const first = container.querySelector('.notice.warning');
    expect(first?.textContent).toBe(warning);
    await act(async () => {
      ariaButton('完成 Beta')?.click();
      await Promise.resolve();
    });
    const second = container.querySelector('.notice.warning');
    expect(second?.textContent).toBe(warning);
    // A new live node for the new result, so a screen reader speaks it again.
    expect(second).not.toBe(first);
    expect(first?.isConnected).toBe(false);
    expect(container.querySelectorAll('.notice')).toHaveLength(1);
  });

  it('speaks an undo, and says plainly when another device already reopened the todo', async () => {
    const routine = task('routine-1', 'Daily warm-up');
    const done = completed(routine.id);
    const repository = fakeRepository({
      tasks: [routine],
      completions: [done],
      summary: {
        ...taskSummary(routine),
        completed: 1,
        remaining: 0,
        occurrences: [{ task: routine, localDate: today, completion: done }],
      },
    });
    await render(repository);
    const spoken = () =>
      container.querySelector('.tasks-refresh-slot .sr-only[role="status"]')?.textContent;
    await act(async () => {
      ariaButton('撤销 Daily warm-up')?.click();
      await Promise.resolve();
    });
    expect(repository.undoTaskCompletion).toHaveBeenCalledWith(routine.id, today);
    expect(spoken()).toBe(`已撤销完成，零花钱 −${TASK_REWARD} 元。`);
    expect(container.querySelector('.notice')).toBeNull();

    // The phone reopened it first: nothing was undone here, and the line never says it was.
    vi.mocked(repository.undoTaskCompletion).mockResolvedValueOnce(false);
    await act(async () => {
      ariaButton('撤销 Daily warm-up')?.click();
      await Promise.resolve();
    });
    expect(spoken()).toBe('这项待办还没完成。');
    expect(container.querySelector('.notice')).toBeNull();
  });

  it('gives keyboard focus back to the row button after completing it', async () => {
    const routine = task('keyboard', 'Keyboard task');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    let finish!: () => void;
    repository.changeTaskCompletionAtomic = vi.fn(
      () =>
        new Promise<AtomicResult>((resolve) => {
          finish = () =>
            resolve({
              changed: true,
              reward: applyTaskCompletionReward(DEFAULT_ALLOWANCE, today, now.toISOString()),
              warning: null,
            });
        }),
    );
    await render(repository);
    // The refresh after the save shows the row completed, with its 撤销 button.
    vi.mocked(repository.getTaskDaySummary).mockResolvedValue({
      ...taskSummary(routine),
      completed: 1,
      remaining: 0,
      occurrences: [{ task: routine, localDate: today, completion: completed(routine.id) }],
    });
    const complete = ariaButton('完成 Keyboard task')!;
    complete.focus();
    await act(async () => complete.click());
    expect(complete.disabled).toBe(true);
    // Saving: the label holds still and the shared aria-busy spinner is the only change.
    expect(complete.textContent).toBe('完成');
    expect(complete.getAttribute('aria-busy')).toBe('true');
    expect(complete.querySelector('.motion-loading-indicator')).toBeNull();
    // A browser moves focus off a control once it is disabled (jsdom does not, so the
    // focus fixup is reproduced by focusing a node and removing it).
    const lost = document.createElement('button');
    document.body.append(lost);
    lost.focus();
    lost.remove();
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const undo = ariaButton('撤销 Keyboard task');
    expect(undo?.disabled).toBe(false);
    expect(document.activeElement).toBe(undo);
  });

  it('leaves focus alone when the person moved to another control meanwhile', async () => {
    const routine = task('keyboard', 'Keyboard task');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    let finish!: () => void;
    repository.changeTaskCompletionAtomic = vi.fn(
      () =>
        new Promise<AtomicResult>((resolve) => {
          finish = () => resolve({ changed: true, reward: null, warning: null });
        }),
    );
    await render(repository);
    const complete = ariaButton('完成 Keyboard task')!;
    complete.focus();
    await act(async () => complete.click());
    const tab = container.querySelector<HTMLButtonElement>('[data-task-section="upcoming"]')!;
    tab.focus();
    await act(async () => {
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ariaButton('完成 Keyboard task')?.disabled).toBe(false);
    expect(document.activeElement).toBe(tab);
  });

  it('shows one wallet number, in the header, before and after the balance loads', async () => {
    const routine = task('wallet', 'Wallet task');
    const repository = fakeRepository({ tasks: [routine], summary: taskSummary(routine) });
    let resolveAllowance: (state: typeof DEFAULT_ALLOWANCE) => void = () => undefined;
    const allowanceLoader = () =>
      new Promise<typeof DEFAULT_ALLOWANCE>((resolve) => {
        resolveAllowance = resolve;
      });
    await act(async () => {
      root.render(
        <TasksView
          revision={0}
          onChanged={() => undefined}
          taskRepository={repository}
          allowanceLoader={allowanceLoader}
          clock={() => now}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const wallet = () =>
      container.querySelector('.tasks-wallet-chip [data-wallet-target="tasks-header"]');
    expect(container.querySelectorAll('.task-summary > div')).toHaveLength(3);
    expect(container.querySelectorAll('[data-wallet-target]')).toHaveLength(1);
    expect(wallet()?.textContent).toBe('—');
    await act(async () => resolveAllowance({ ...DEFAULT_ALLOWANCE, balance: 12 }));
    expect(container.querySelectorAll('.task-summary > div')).toHaveLength(3);
    expect(container.querySelectorAll('[data-wallet-target]')).toHaveLength(1);
    expect(wallet()?.textContent).toBe('12');
  });

  it('opens an externally requested future edit in its own section and restores row focus on cancel', async () => {
    const future = task('future-edit', 'Future task', {
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-25',
    });
    const repo = fakeRepository({ tasks: [future] });
    await act(async () =>
      root.render(
        <TasksView
          revision={0}
          onChanged={() => undefined}
          taskRepository={repo}
          clock={() => now}
          editorRequest={{ key: 2, mode: 'edit', task: future }}
        />,
      ),
    );
    expect(document.activeElement?.id).toBe('task-form-heading');
    expect(
      container.querySelector('[data-task-section="upcoming"]')?.getAttribute('aria-selected'),
    ).toBe('true');
    await act(async () => textButton('取消')?.click());
    expect(repo.updateTask).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute('data-task-id')).toBe(future.id);
  });

  it('keeps input when retaining fails and opens a new independent draft after persistence', async () => {
    await render(fakeRepository());
    await act(async () => textButton('添加待办')!.click());
    await act(async () => setControlValue(formField('标题', 'input'), 'unsaved task'));
    vi.spyOn(DraftRepository.prototype, 'save').mockRejectedValueOnce(new Error('草稿写入失败'));
    await act(async () => textButton('添加待办')!.click());
    expect(formField<HTMLInputElement>('标题', 'input').value).toBe('unsaved task');
    await act(async () => textButton('添加待办')!.click());
    expect(formField<HTMLInputElement>('标题', 'input').value).toBe('');
    expect((await new DraftRepository().list('task-create'))[0]?.payload).toMatchObject({
      values: { title: 'unsaved task' },
    });
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('focuses the editor and gives every empty task section a stable state', async () => {
    await render(fakeRepository());

    expect(container.querySelector('.task-section-content .empty-state')).not.toBeNull();
    const empty = () => container.querySelector('.task-section-content .empty-state')?.textContent;
    expect(empty()).toBe('今天没有待办。');

    await act(async () => textButton('即将到来')?.click());
    expect(empty()).toBe('没有即将到来的待办。');
    await act(async () => textButton('全部进行中')?.click());
    expect(empty()).toBe('没有进行中的待办。');
    await act(async () => textButton('完成记录')?.click());
    expect(empty()).toBe('没有完成记录。');
    await act(async () => textButton('已归档')?.click());
    expect(empty()).toBe('没有已归档的待办。');

    // With a filter on, the sentence says why the section is empty.
    await act(async () => setControlValue(filterSelect('优先级'), 'high'));
    expect(empty()).toBe('没有符合筛选的已归档待办。');
    await act(async () => textButton('今天')?.click());
    expect(empty()).toBe('今天没有符合筛选的待办。');
    await act(async () => textButton('即将到来')?.click());
    expect(empty()).toBe('没有符合筛选的即将到来的待办。');
    await act(async () => textButton('全部进行中')?.click());
    expect(empty()).toBe('没有符合筛选的进行中待办。');
    await act(async () => textButton('完成记录')?.click());
    expect(empty()).toBe('没有符合筛选的完成记录。');

    await act(async () => textButton('添加待办')?.click());
    expect(document.activeElement?.id).toBe('task-form-heading');
  });

  it('counts due reviews in the bubble instead of saying they are done', async () => {
    const open = task('open-todo', '整理笔记');
    const suspended = { ...learningItem(), id: 'suspended', suspended: true };
    const later = {
      ...learningItem(),
      id: 'later',
      fsrsCard: { ...createEmptyCard(now), due: new Date(2026, 6, 23, 9) },
    };
    await render(
      fakeRepository({
        tasks: [open],
        summary: taskSummary(open),
        items: [learningItem(), suspended, later],
      }),
    );
    const companion = container.querySelector('.companion-tasks');
    expect(companion?.textContent).toContain('今天有 1 条复习和 1 项任务等你。');
    expect(companion?.textContent).not.toContain('复习已经完成');
    expect(companion?.getAttribute('data-companion-state')).toBe('due');
    expect(companion?.getAttribute('data-companion-pose')).toBe('head-talk');
    expect(companion?.querySelector('img')?.getAttribute('src')).toBe(
      companionArtPath(outfitForDate(today), 'head-talk', 'animated'),
    );
  });

  it('says only the todos are left when no review is due, and smiles when nothing is', async () => {
    const open = task('open-todo', '整理笔记');
    await render(fakeRepository({ tasks: [open], summary: taskSummary(open) }));
    expect(container.querySelector('.companion-tasks')?.textContent).toContain(
      '复习已经完成。还剩 1 项任务。',
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(fakeRepository());
    const companion = container.querySelector('.companion-tasks');
    expect(companion?.textContent).toContain('今天都跟上进度了。');
    expect(companion?.getAttribute('data-companion-state')).toBe('idle');
    expect(companion?.getAttribute('data-companion-pose')).toBe('head-smile');
  });

  async function render(repository: TaskDashboardRepository) {
    await act(async () => {
      root.render(
        <TasksView
          revision={0}
          onChanged={() => undefined}
          taskRepository={repository}
          clock={() => now}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Places matching elements on screen; everything else has no box, as in jsdom. */
  function placeOnScreen(places: Record<string, [number, number]>) {
    return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const entry = Object.entries(places).find(([selector]) => this.matches(selector));
      const [left, top] = entry?.[1] ?? [0, 0];
      const size = entry ? 20 : 0;
      return {
        left,
        top,
        x: left,
        y: top,
        width: size,
        height: size,
        right: left + size,
        bottom: top + size,
        toJSON: () => ({}),
      } as DOMRect;
    });
  }

  function textButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  }

  function firstTextButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((button) => button.textContent === label);
  }

  function ariaButton(label: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  }

  function filterSelect(label: string): HTMLSelectElement {
    return formField<HTMLSelectElement>(label, 'select', container.querySelector('.task-filters'));
  }

  function formField<T extends HTMLInputElement | HTMLSelectElement>(
    label: string,
    selector: string,
    scope: ParentNode | null = container,
  ): T {
    const wrapper = [...(scope?.querySelectorAll('label') ?? [])].find((entry) =>
      entry.querySelector('span')?.textContent?.includes(label),
    );
    const control = wrapper?.querySelector<T>(selector);
    if (!control) throw new Error(`Expected ${label} field.`);
    return control;
  }

  function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')?.set;
    setter?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  }
});

function fakeRepository({
  tasks = [],
  completions = [],
  summary = emptySummary(),
  items = [],
}: {
  tasks?: DailyTask[];
  completions?: TaskCompletion[];
  summary?: TaskDaySummary;
  items?: VideoLearningItem[];
} = {}): TaskDashboardRepository {
  const repository: TaskDashboardRepository = {
    listTasks: vi.fn().mockResolvedValue(tasks),
    listTaskCompletions: vi.fn().mockResolvedValue(completions),
    listItems: vi.fn().mockResolvedValue(items),
    getTaskDaySummary: vi.fn().mockResolvedValue(summary),
    createTask: vi
      .fn()
      .mockImplementation(async (input) => ({ ...task('created', input.title), ...input })),
    updateTask: vi.fn().mockImplementation(async (id, changes) => ({
      ...(tasks.find((candidate) => candidate.id === id) ?? task(id, 'Updated')),
      ...changes,
    })),
    archiveTask: vi.fn().mockImplementation(async (id, archived = true) => ({
      ...(tasks.find((candidate) => candidate.id === id) ?? task(id, 'Archived')),
      archived,
    })),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    completeTaskForDate: vi.fn().mockImplementation(async (taskId, localDate = today) => ({
      id: `completion-${taskId}`,
      taskId,
      localDate,
      completedAt: now.toISOString(),
    })),
    undoTaskCompletion: vi.fn().mockResolvedValue(true),
    completeTaskForDateWithResult: vi
      .fn()
      .mockImplementation(async (taskId, localDate = today) => ({
        created: true,
        completion: {
          id: `completion-${taskId}`,
          taskId,
          localDate,
          completedAt: now.toISOString(),
        },
      })),
  };
  repository.changeTaskCompletionAtomic = vi.fn(async (taskId, date, isCompleted, at) => {
    const changed = isCompleted
      ? (await repository.completeTaskForDateWithResult(taskId, date)).created
      : await repository.undoTaskCompletion(taskId, date);
    const reward =
      changed && date === today
        ? (isCompleted ? applyTaskCompletionReward : applyTaskCompletionReversal)(
            DEFAULT_ALLOWANCE,
            date,
            at.toISOString(),
          )
        : null;
    return { changed, reward, warning: null };
  });
  return repository;
}

function task(id: string, title: string, overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    id,
    schemaVersion: 1,
    title,
    notes: null,
    kind: 'routine',
    recurrence: 'daily',
    scheduledDate: null,
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function completed(taskId: string): TaskCompletion {
  return {
    id: `completion-${taskId}`,
    taskId,
    localDate: today,
    completedAt: now.toISOString(),
  };
}

function taskSummary(
  first?: DailyTask,
  second?: DailyTask,
  secondCompletion?: TaskCompletion,
): TaskDaySummary {
  const occurrences = [
    ...(first ? [{ task: first, localDate: today, completion: null }] : []),
    ...(second ? [{ task: second, localDate: today, completion: secondCompletion ?? null }] : []),
  ];
  const completedCount = occurrences.filter((entry) => entry.completion !== null).length;
  return {
    localDate: today,
    total: occurrences.length,
    completed: completedCount,
    remaining: occurrences.length - completedCount,
    occurrences,
  };
}

function emptySummary(): TaskDaySummary {
  return { localDate: today, total: 0, completed: 0, remaining: 0, occurrences: [] };
}

function learningItem(): VideoLearningItem {
  return {
    id: 'learning-1',
    schemaVersion: 2,
    platform: 'bilibili',
    sourceUrl: 'https://www.bilibili.com/video/BV1test',
    canonicalUrl: 'https://www.bilibili.com/video/BV1test',
    videoId: 'BV1test',
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
    coreLesson: 'Hold one angle.',
    mistakeToAvoid: '',
    recommendedAction: 'Hold one angle.',
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
