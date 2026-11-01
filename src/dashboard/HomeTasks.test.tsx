import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeTasks, type HomeTaskWriter } from './HomeTasks';
import { createDefaultTaskDraft } from './TaskForm';
import { buildHomeTaskOverview } from '../models/task-overview';
import { TASK_CELEBRATION_MS } from '../shared/task-celebration';
import { applyTaskCreationReward, DEFAULT_ALLOWANCE } from '../shared/allowance';
import { requestEditorLeave, requestEditorLeaveAsync } from '../shared/edit-protection';
import type { DailyTask } from '../database';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const today = '2026-10-20';
const empty = () => buildHomeTaskOverview([], [], [], today);
function task(id: string, date = today): DailyTask {
  return {
    ...createDefaultTaskDraft(date),
    id,
    title: id,
    schemaVersion: 1,
    archived: false,
    createdAt: new Date(2026, 9, 20).toISOString(),
    updatedAt: new Date(2026, 9, 20).toISOString(),
  };
}
describe('Home task workspace', () => {
  let root: Root;
  let container: HTMLDivElement;
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
  const noop = () => undefined;
  function button(text: string) {
    const el = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!el) throw new Error(`Missing ${text}`);
    return el;
  }
  function input(value: string) {
    const el = container.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('shows today and upcoming before overdue without changing the overdue occurrence', async () => {
    const overdue = { ...task('old', '2026-10-18'), priority: 'high' as const };
    const onToggle = vi.fn().mockResolvedValue(true);
    await act(async () =>
      root.render(
        <HomeTasks
          overview={buildHomeTaskOverview(
            [overdue, task('later', '2026-10-22'), task('today')],
            [],
            [],
            today,
          )}
          unavailable={false}
          busy={false}
          writer={{ createTask: vi.fn() }}
          onToggle={onToggle}
          onCreated={noop}
          onEdit={noop}
          onManage={noop}
        />,
      ),
    );
    expect([...container.querySelectorAll('.home-task-group h4')].map((row) => row.id)).toEqual([
      'home-task-today',
      'home-task-upcoming',
      'home-task-overdue',
    ]);
    expect(
      [...container.querySelectorAll('[data-task-id]')].map((row) =>
        row.getAttribute('data-task-id'),
      ),
    ).toEqual(['today', 'later', 'old']);
    expect(container.querySelector('[data-task-id="later"] button[aria-label^="完成"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="完成 old"]')?.click(),
    );
    expect(onToggle).toHaveBeenCalledExactlyOnceWith({
      task: overdue,
      localDate: '2026-10-18',
      completion: null,
    });
  });

  it('renders 100 unfinished tasks without truncation and never offers future completion', async () => {
    const tasks = Array.from({ length: 100 }, (_, i) =>
      task(`Task-${i}`, i > 70 ? '2026-10-22' : today),
    );
    const onToggle = vi.fn().mockResolvedValue(true);
    await act(async () =>
      root.render(
        <HomeTasks
          overview={buildHomeTaskOverview(tasks, [], [], today)}
          unavailable={false}
          busy={false}
          writer={{ createTask: vi.fn() }}
          onToggle={onToggle}
          onCreated={noop}
          onEdit={noop}
          onManage={noop}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-task-id]')).toHaveLength(100);
    expect(container.querySelectorAll('button[aria-label^="完成"]')).toHaveLength(71);
    expect(
      container.querySelector('[data-task-id="Task-99"] button')?.getAttribute('aria-label'),
    ).toBe('编辑 Task-99');
  });

  it('keeps failed input, retries one identity, then focuses a future task after refresh', async () => {
    const created = vi.fn();
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (values) => ({ ...task(values.id), ...values }));
    const writer: HomeTaskWriter = { createTask };
    const render = (tasks: DailyTask[] = []) =>
      root.render(
        <HomeTasks
          overview={buildHomeTaskOverview(tasks, [], [], today)}
          unavailable={false}
          busy={false}
          writer={writer}
          onToggle={async () => true}
          onCreated={created}
          onEdit={noop}
          onManage={noop}
        />,
      );
    await act(async () => render());
    await act(async () => button('添加待办').click());
    input('需要重试的任务');
    const date = container.querySelector<HTMLInputElement>('input[type="date"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        date,
        '2026-10-22',
      );
      date.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      button('创建待办').click();
      await Promise.resolve();
    });
    expect(container.querySelector('input')?.value).toBe('需要重试的任务');
    expect(created).not.toHaveBeenCalled();
    await act(async () => {
      button('创建待办').click();
      button('创建待办').click();
      await Promise.resolve();
    });
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[0]?.[0].id).toBe(createTask.mock.calls[1]?.[0].id);
    const saved = created.mock.calls[0]?.[0] as DailyTask;
    await act(async () => render([saved]));
    expect(container.querySelector('.task-form')).toBeNull();
    expect(document.activeElement?.getAttribute('data-task-id')).toBe(saved.id);
    expect(document.activeElement?.getAttribute('data-group')).toBe('upcoming');
  });

  it('briefly marks only the row a confirmed create produced', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const created = vi.fn();
      const createTask = vi.fn(async (values: DailyTask) => ({ ...task(values.id), ...values }));
      const render = (tasks: DailyTask[]) =>
        root.render(
          <HomeTasks
            overview={buildHomeTaskOverview(tasks, [], [], today)}
            unavailable={false}
            busy={false}
            writer={{ createTask }}
            onToggle={async () => true}
            onCreated={created}
            onEdit={noop}
            onManage={noop}
          />,
        );
      await act(async () => render([task('existing')]));
      await act(async () => button('添加待办').click());
      input('刚创建的任务');
      await act(async () => {
        button('创建待办').click();
        await Promise.resolve();
      });
      const saved = created.mock.calls[0]?.[0] as DailyTask;
      await act(async () => render([task('existing'), saved]));
      const row = container.querySelector(`[data-task-id="${saved.id}"]`);
      expect(row?.classList.contains('home-task-arrived')).toBe(true);
      expect(document.activeElement).toBe(row);
      expect(container.querySelector('[data-task-id="existing"]')?.className).toBe('');
      await act(async () => vi.advanceTimersByTime(1600));
      expect(container.querySelector('.home-task-arrived')).toBeNull();
      expect(document.activeElement).toBe(row);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the committed grant up and keeps only a failed save visible in the list', async () => {
    const created = vi.fn();
    const reward = applyTaskCreationReward(DEFAULT_ALLOWANCE, today);
    const createTaskWithReward = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (values: DailyTask) => ({
        task: { ...task(values.id), ...values },
        reward,
      }));
    await act(async () =>
      root.render(
        <HomeTasks
          overview={empty()}
          unavailable={false}
          busy={false}
          writer={{ createTask: vi.fn(), createTaskWithReward }}
          onToggle={async () => true}
          onCreated={created}
          onEdit={noop}
          onManage={noop}
        />,
      ),
    );
    await act(async () => button('添加待办').click());
    input('有奖励的任务');
    await act(async () => {
      button('创建待办').click();
      await Promise.resolve();
    });
    expect(container.querySelector('.home-task-scroll .notice.error')?.textContent).toContain(
      'disk full',
    );
    await act(async () => {
      button('创建待办').click();
      await Promise.resolve();
    });
    expect(created).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: '有奖励的任务' }),
      reward,
    );
    // Success is announced by Home's hidden status line, never as an in-list banner.
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.textContent).not.toContain('待办已创建');
  });

  it('marks the new row as the creation coin origin without stamping or folding it', async () => {
    const creation = {
      id: 'al-9',
      taskId: 'fresh',
      localDate: today,
      amount: 5,
      kind: 'created' as const,
      praise: '',
    };
    const later = { ...creation, id: 'al-10', taskId: 'later' };
    const render = (celebration: typeof creation) =>
      root.render(
        <HomeTasks
          overview={buildHomeTaskOverview(
            [task('fresh'), task('later', '2026-10-25'), task('other')],
            [],
            [],
            today,
          )}
          unavailable={false}
          busy={false}
          writer={{ createTask: vi.fn() }}
          celebration={celebration}
          onToggle={async () => true}
          onCreated={noop}
          onEdit={noop}
          onManage={noop}
        />,
      );
    await act(async () => render(creation));
    const check = container.querySelector('[aria-label="完成 fresh"]');
    expect(check?.getAttribute('data-celebration-origin')).toBe('al-9');
    expect(container.querySelectorAll('[data-celebration-origin]')).toHaveLength(1);
    expect(container.querySelector('.is-completing, .home-task-ghost')).toBeNull();
    expect(container.querySelector('.home-task-progress.is-celebrating')).toBeNull();
    expect(button('添加待办').dataset.celebrationFallback).toBe('task-create');
    await act(async () => render(later));
    expect(
      container
        .querySelector('[data-task-id="later"] .home-task-future-mark')
        ?.getAttribute('data-celebration-origin'),
    ).toBe('al-10');
  });

  const todayRows = () => [
    ...container.querySelectorAll('#home-task-today ~ .home-task-group-body > ol > li'),
  ];
  const celebrationFor = (taskId: string, id = `al-${taskId}`) => ({
    id,
    taskId,
    localDate: today,
    amount: 5,
    kind: 'rewarded' as const,
    praise: '你又完成一件啦！',
  });
  const doneOn = (taskId: string) => ({
    id: `done-${taskId}`,
    taskId,
    localDate: today,
    completedAt: new Date(2026, 9, 20, 12).toISOString(),
  });
  function taskProps(onToggle: (row: unknown) => Promise<boolean>) {
    return {
      unavailable: false,
      busy: false,
      writer: { createTask: vi.fn() },
      onToggle,
      onCreated: noop,
      onEdit: noop,
      onManage: noop,
    };
  }

  it('lets a finished row complete in its slot, then fold away, without stealing focus', async () => {
    vi.useFakeTimers();
    try {
      const [a, b, c] = [task('a'), task('b'), task('c')];
      const onToggle = vi.fn().mockResolvedValue(true);
      const props = taskProps(onToggle);
      const before = buildHomeTaskOverview([a, b, c], [], [], today);
      await act(async () => root.render(<HomeTasks {...props} overview={before} />));
      const check = container.querySelector<HTMLButtonElement>('[aria-label="完成 b"]')!;
      check.focus();
      await act(async () => check.click());
      expect(onToggle).toHaveBeenCalledOnce();
      expect(check.dataset.celebrationKey).toBe(`b:${today}`);

      await act(async () =>
        root.render(<HomeTasks {...props} overview={before} celebration={celebrationFor('b')} />),
      );
      expect(container.querySelector('[data-task-id="b"]')?.classList).toContain('is-completing');

      const after = buildHomeTaskOverview([a, b, c], [doneOn('b')], [], today);
      await act(async () =>
        root.render(<HomeTasks {...props} overview={after} celebration={celebrationFor('b')} />),
      );
      expect(todayRows()).toHaveLength(3);
      const ghost = todayRows()[1]!;
      expect(ghost.classList.contains('home-task-ghost')).toBe(true);
      expect(ghost.getAttribute('aria-hidden')).toBe('true');
      expect(ghost.hasAttribute('inert')).toBe(true);
      expect(ghost.hasAttribute('data-task-id')).toBe(false);
      expect(document.activeElement?.getAttribute('data-occurrence')).toBe(`today:c:${today}`);
      expect(container.querySelector('.home-task-progress')?.textContent).toBe('今天 1/3');

      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.rowHold));
      // The same DOM node keeps its animation and only changes phase.
      expect(ghost.isConnected).toBe(true);
      expect(ghost.classList.contains('is-collapsing')).toBe(true);
      await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.rowCollapse));
      expect(container.querySelector('.home-task-ghost')).toBeNull();
      expect(todayRows()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps each quick completion folding on its own, so the list never jumps', async () => {
    vi.useFakeTimers();
    try {
      const [a, b, c] = [task('a'), task('b'), task('c')];
      const props = taskProps(vi.fn().mockResolvedValue(true));
      let overview = buildHomeTaskOverview([a, b, c], [], [], today);
      await act(async () => root.render(<HomeTasks {...props} overview={overview} />));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="完成 a"]')!.click(),
      );
      overview = buildHomeTaskOverview([a, b, c], [doneOn('a')], [], today);
      await act(async () =>
        root.render(<HomeTasks {...props} overview={overview} celebration={celebrationFor('a')} />),
      );
      await act(async () => vi.advanceTimersByTime(300));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="完成 b"]')!.click(),
      );
      // A's folding row is still in place while B starts its own moment.
      expect(todayRows()).toHaveLength(3);
      overview = buildHomeTaskOverview([a, b, c], [doneOn('a'), doneOn('b')], [], today);
      await act(async () =>
        root.render(<HomeTasks {...props} overview={overview} celebration={celebrationFor('b')} />),
      );
      expect(todayRows().map((row) => row.classList.contains('home-task-ghost'))).toEqual([
        true,
        true,
        false,
      ]);
      await act(async () =>
        vi.advanceTimersByTime(TASK_CELEBRATION_MS.rowHold + TASK_CELEBRATION_MS.rowCollapse),
      );
      expect(todayRows()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a finishing row at once when its completion is undone', async () => {
    vi.useFakeTimers();
    try {
      const [a, b] = [task('a'), task('b')];
      const onToggle = vi.fn().mockResolvedValue(true);
      const props = taskProps(onToggle);
      const before = buildHomeTaskOverview([a, b], [], [], today);
      await act(async () => root.render(<HomeTasks {...props} overview={before} />));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="完成 a"]')!.click(),
      );
      const after = buildHomeTaskOverview([a, b], [doneOn('a')], [], today);
      await act(async () =>
        root.render(<HomeTasks {...props} overview={after} celebration={celebrationFor('a')} />),
      );
      expect(container.querySelector('.home-task-ghost')).not.toBeNull();
      await act(async () => {
        container.querySelector<HTMLDetailsElement>('.home-task-completed-group')!.open = true;
      });
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="撤销 a"]')!.click(),
      );
      expect(container.querySelector('.home-task-ghost')).toBeNull();
      await act(async () =>
        root.render(<HomeTasks {...props} overview={before} celebration={celebrationFor('a')} />),
      );
      const reopened = container.querySelector('[data-task-id="a"]');
      expect(reopened?.classList.contains('is-completing')).toBe(false);
      expect(container.querySelector<HTMLButtonElement>('[aria-label="完成 a"]')!.disabled).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the empty line beneath the last folding row so the group shrinks once', async () => {
    vi.useFakeTimers();
    try {
      const only = task('only');
      const props = taskProps(vi.fn().mockResolvedValue(true));
      await act(async () =>
        root.render(
          <HomeTasks {...props} overview={buildHomeTaskOverview([only], [], [], today)} />,
        ),
      );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="完成 only"]')!.click(),
      );
      await act(async () =>
        root.render(
          <HomeTasks
            {...props}
            overview={buildHomeTaskOverview([only], [doneOn('only')], [], today)}
            celebration={{ ...celebrationFor('only'), kind: 'all-done' }}
          />,
        ),
      );
      const body = container.querySelector('#home-task-today ~ .home-task-group-body');
      expect(body?.querySelector('.home-task-ghost')).not.toBeNull();
      expect(body?.querySelector('.home-task-all-done')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the all-done state once nothing is left for today', async () => {
    const only = task('only');
    const completion = {
      id: 'done-only',
      taskId: 'only',
      localDate: today,
      completedAt: new Date(2026, 9, 20, 12).toISOString(),
    };
    await act(async () =>
      root.render(
        <HomeTasks
          overview={buildHomeTaskOverview([only], [completion], [], today)}
          unavailable={false}
          busy={false}
          writer={{ createTask: vi.fn() }}
          onToggle={async () => true}
          onCreated={noop}
          onEdit={noop}
          onManage={noop}
        />,
      ),
    );
    expect(container.querySelector('.home-task-all-done')?.textContent).toBe(
      '今天的待办都完成了 ✓',
    );
    expect(container.querySelector('.home-task-progress')?.classList).toContain('is-all-done');
    expect(container.querySelector('.home-task-progress')?.textContent).toBe('今天 1/1');
  });

  it('does not turn a failed first read into zero tasks', async () => {
    await act(async () =>
      root.render(
        <HomeTasks
          overview={empty()}
          unavailable
          busy={false}
          writer={{ createTask: vi.fn() }}
          onToggle={async () => true}
          onCreated={noop}
          onEdit={noop}
          onManage={noop}
        />,
      ),
    );
    expect(container.textContent).toContain('待办没加载出来');
    expect(container.querySelector('.home-task-counts')?.textContent).toContain('—');
    expect(container.textContent).not.toContain('没有逾期任务');
  });

  describe('工作中 card', () => {
    const daily = (id: string): DailyTask => ({
      ...task(id),
      kind: 'routine',
      recurrence: 'daily',
      scheduledDate: null,
    });
    const rowOf = (t: DailyTask, localDate = today) => ({ task: t, localDate, completion: null });

    /** A tiny stand-in for HomeView: holds the current task and note, and redraws. */
    function harness(tasks: DailyTask[], options: { reducedList?: boolean } = {}) {
      let current: string | null = null;
      const notes = new Map<string, string>();
      let list = tasks;
      let overview = buildHomeTaskOverview(list, [], [], today);
      let celebration: ReturnType<typeof celebrationFor> | null = null;
      let saves = 0;
      const onToggle = vi.fn().mockResolvedValue(true);
      const onEdit = vi.fn();
      const plan = {
        onApply: vi.fn(async (row: ReturnType<typeof rowOf>, action: never) => ({
          action,
          taskId: row.task.id,
          title: row.task.title,
          localDate: row.localDate,
          previousDate: row.task.scheduledDate,
        })),
        onUndo: vi.fn().mockResolvedValue(true),
        onRestore: vi.fn().mockResolvedValue(true),
      };
      const render = () => {
        const row =
          [...overview.today, ...overview.overdue].find((entry) => entry.task.id === current) ??
          null;
        return root.render(
          <HomeTasks
            overview={overview}
            unavailable={false}
            busy={false}
            writer={{ createTask: vi.fn() }}
            celebration={celebration}
            onToggle={onToggle}
            onCreated={noop}
            onEdit={onEdit}
            onManage={noop}
            plan={plan as never}
            working={
              options.reducedList
                ? undefined
                : {
                    row,
                    note: row ? (notes.get(row.task.id) ?? '') : '',
                    onStart: async (next) => {
                      current = next.task.id;
                      render();
                    },
                    onPutDown: async () => {
                      current = null;
                      render();
                    },
                    onSaveNote: async (next, text) => {
                      notes.set(next.task.id, text.trim());
                      render();
                    },
                    onSaveTaskNotes,
                  }
            }
          />,
        );
      };
      // Like HomeView: the saved task replaces its row, with a newer version.
      const onSaveTaskNotes = vi.fn(async (taskId: string, value: string | null) => {
        saves += 1;
        const saved: DailyTask = {
          ...list.find((entry) => entry.id === taskId)!,
          notes: value,
          updatedAt: new Date(2026, 9, 20, 13, 0, saves).toISOString(),
        };
        list = list.map((entry) => (entry.id === taskId ? saved : entry));
        overview = buildHomeTaskOverview(list, [], [], today);
        render();
        return saved;
      });
      return {
        onToggle,
        onEdit,
        onSaveTaskNotes,
        plan,
        notes,
        render: () => act(async () => render()),
        setCurrent: (id: string | null) => {
          current = id;
        },
        setOverview: (next: typeof overview) => {
          overview = next;
        },
        setCelebration: (next: typeof celebration) => {
          celebration = next;
        },
        /** A row changed somewhere else: another window, the phone or the edit form. */
        changeElsewhere: (id: string, changes: Partial<DailyTask>) => {
          list = list.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry));
          overview = buildHomeTaskOverview(list, [], [], today);
        },
      };
    }
    const click = (label: string) =>
      act(async () => {
        const target = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
        if (!target) throw new Error(`Missing ${label}`);
        target.click();
      });
    const clickText = (text: string) => act(async () => button(text).click());
    const visibleRows = () =>
      [...container.querySelectorAll<HTMLElement>('[data-task-id]')]
        .filter((row) => !row.closest('[hidden]'))
        .map((row) => row.dataset.taskId);
    const card = () => container.querySelector<HTMLElement>('.home-working-card');
    const openList = () =>
      act(async () =>
        container.querySelector<HTMLButtonElement>('.home-working-rest-toggle')!.click(),
      );

    const nextLine = () => container.querySelector<HTMLButtonElement>('.home-working-next');
    const nextInput = () => container.querySelector<HTMLInputElement>('.home-working-next-input');
    const typeNext = (value: string) =>
      act(() => {
        const el = nextInput()!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const keyOnNext = (key: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        nextInput()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
      });
    /** Opens the line, types and presses Enter: the whole of writing a next step. */
    async function writeNext(text: string) {
      await act(async () => nextLine()!.click());
      await typeNext(text);
      await keyOnNext('Enter');
    }

    const leaveAsync = async () => {
      let left = false;
      await act(async () => {
        left = await requestEditorLeaveAsync();
      });
      return left;
    };
    const reloadAsks = async () => {
      const unload = new Event('beforeunload', { cancelable: true });
      await act(async () => window.dispatchEvent(unload));
      return unload.defaultPrevented;
    };
    const press = () =>
      act(async () => {
        window.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      });
    const release = () =>
      act(async () => {
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      });
    const notesField = () =>
      container.querySelector<HTMLTextAreaElement>('#home-working-notes-input');
    const notesStatus = () => container.querySelector('.home-working-notes-status')?.textContent;
    const typeNotes = (value: string) =>
      act(() => {
        const el = notesField()!;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          el,
          value,
        );
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

    it('offers 开始 on today and overdue only, and nothing without the controls', async () => {
      const test = harness([task('a'), task('late', '2026-10-18'), task('later', '2026-10-22')]);
      await test.render();
      expect(container.querySelector('[aria-label="开始 a"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="开始 late"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="开始 later"]')).toBeNull();
      expect(card()).toBeNull();
      expect(container.querySelector('.home-working-rest-toggle')).toBeNull();
    });

    it('starting moves the row into the card, collapses the rest and focuses the check', async () => {
      const test = harness([task('a'), task('b'), task('c')]);
      await test.render();
      await click('开始 b');
      expect(card()?.textContent).toContain('b');
      expect(visibleRows()).toEqual(['b']);
      expect(document.activeElement?.getAttribute('aria-label')).toBe('完成 b');
      // Nothing opens by itself: the next step waits for a click.
      expect(nextInput()).toBeNull();
      expect(nextLine()?.textContent).toBe('+ 下一步');
      const toggle = container.querySelector<HTMLButtonElement>('.home-working-rest-toggle')!;
      expect(toggle.textContent).toContain('今天还有 2 项');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      await act(async () => toggle.click());
      expect(visibleRows()).toEqual(['b', 'a', 'c']);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.textContent).toBe('收起');
    });

    it('counts only the rows a group draws, leaving out the one on the card', async () => {
      const test = harness([task('a'), task('b'), task('late', '2026-10-18')]);
      await test.render();
      await click('开始 a');
      await openList();
      const heading = container.querySelector('#home-task-today')!;
      expect(heading.querySelector('span')?.textContent).toBe('1');
      expect(heading.closest('section')?.querySelectorAll('[data-task-id]')).toHaveLength(1);
      expect(container.querySelector('#home-task-overdue span')?.textContent).toBe('1');
      await openList();
      expect(container.querySelector('.home-working-rest-toggle')?.textContent).toBe(
        '今天还有 2 项',
      );
      // The overdue row on the card leaves its group empty, so the group goes.
      await click('先放下 a');
      await click('开始 late');
      await openList();
      expect(container.querySelector('#home-task-today span')?.textContent).toBe('2');
      expect(container.querySelector('#home-task-overdue')).toBeNull();
    });

    it('ignores the second click of a double-click, whatever has moved under the pointer', async () => {
      const test = harness([task('a')]);
      await test.render();
      await click('开始 a');
      const putDown = () => container.querySelector<HTMLButtonElement>('[aria-label="先放下 a"]')!;
      const clickWith = (detail: number) =>
        act(async () => {
          putDown().dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
        });
      const pressed = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
      await act(async () => putDown().dispatchEvent(pressed));
      expect(pressed.defaultPrevented).toBe(true);
      await clickWith(2);
      await clickWith(3);
      expect(card()).not.toBeNull();
      expect(document.activeElement).toBe(card()?.querySelector('.home-task-check'));
      // A first press takes focus as usual, and a first click goes through.
      const first = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1 });
      await act(async () => putDown().dispatchEvent(first));
      expect(first.defaultPrevented).toBe(false);
      await clickWith(1);
      expect(card()).toBeNull();
    });

    it('never counts a keyboard or screen reader activation as a double-click', async () => {
      const test = harness([task('a')]);
      await test.render();
      // Both are clicks with a count of zero.
      await click('开始 a');
      expect(card()).not.toBeNull();
      await click('先放下 a');
      expect(card()).toBeNull();
    });

    it('never changes the counts when a card starts', async () => {
      const test = harness([task('only')]);
      await test.render();
      const counts = () => container.querySelector('.home-task-counts')?.textContent;
      const before = counts();
      await click('开始 only');
      expect(counts()).toBe(before);
      expect(container.querySelector('.home-working-rest-toggle')?.textContent).toContain(
        '其余待办',
      );
    });

    it('completes with the round check alone, keeping one celebration origin on the card', async () => {
      const late = task('late', '2026-10-18');
      const test = harness([late, task('b')]);
      await test.render();
      await click('开始 late');
      expect(container.querySelectorAll('[data-celebration-key="late:2026-10-18"]')).toHaveLength(
        1,
      );
      expect(
        card()?.querySelector('.home-task-check[data-celebration-key="late:2026-10-18"]'),
      ).not.toBeNull();
      expect([...card()!.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
        '完成',
      );
      await click('完成 late');
      expect(test.onToggle).toHaveBeenCalledExactlyOnceWith(rowOf(late, '2026-10-18'));
    });

    it('switches in one click, saving what was written first', async () => {
      const test = harness([task('a'), task('b')]);
      await test.render();
      await click('开始 a');
      await openList();
      await click('开始 b');
      // Nothing was written, so nothing asks how to come back.
      expect(card()?.textContent).toContain('b');
      expect(test.notes.has('a')).toBe(false);
      expect(nextLine()?.textContent).toBe('+ 下一步');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('完成 b');

      await act(async () => nextLine()!.click());
      await typeNext('写小标题');
      await typeNotes('第三节先写结论');
      await openList();
      await click('开始 a');
      expect(test.notes.get('b')).toBe('写小标题');
      expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('b', '第三节先写结论');
      expect(card()?.textContent).toContain('a');
      expect(nextInput()).toBeNull();
    });

    it('keeps the card when a switch cannot save what was written', async () => {
      const test = harness([task('a'), task('b')]);
      await test.render();
      await click('开始 a');
      test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
      await typeNotes('第三节先写结论');
      await openList();
      await click('开始 b');
      expect(card()?.textContent).toContain('a');
      expect(notesField()?.value).toBe('第三节先写结论');
      expect(notesStatus()).toBe('没保存，请重试');
    });

    it('puts down from the row, keeps the next step, and focuses the returned row', async () => {
      const test = harness([task('a'), task('b')]);
      await test.render();
      await click('开始 a');
      expect(container.querySelector('.home-task-actions [aria-label="先放下 a"]')).not.toBeNull();
      // Only the card has it.
      await openList();
      expect(container.querySelector('[aria-label="先放下 b"]')).toBeNull();
      await writeNext('写小标题');
      await click('先放下 a');
      expect(card()).toBeNull();
      expect(test.notes.get('a')).toBe('写小标题');
      expect(visibleRows()).toEqual(['a', 'b']);
      expect(document.activeElement?.getAttribute('data-task-id')).toBe('a');
      await click('开始 a');
      expect(nextLine()?.textContent).toBe('下一步：写小标题');
    });

    it('offers plan actions by recurrence and an in-place undo until the next action', async () => {
      const once = task('once');
      const routine = daily('routine');
      const test = harness([once, routine]);
      await test.render();
      await click('更多 routine');
      expect(container.querySelector('[aria-label="今天不做 routine"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="不做了 routine"]')).toBeNull();
      await click('更多 once');
      expect(container.querySelector('[aria-label="今天不做 routine"]')).toBeNull();
      await click('改到明天 once');
      expect(test.plan.onApply).toHaveBeenCalledExactlyOnceWith(rowOf(once), 'move-tomorrow');
      expect(container.querySelector('.home-task-undo')?.textContent).toContain('已改到明天');
      await click('撤销 once');
      expect(test.plan.onUndo).toHaveBeenCalledOnce();
      expect(container.querySelector('.home-task-undo')).toBeNull();
    });

    it('keeps 编辑 inside ⋯ on a row with a menu, first, and closes the menu when picked', async () => {
      const test = harness([task('once'), daily('routine')]);
      await test.render();
      expect(container.querySelector('[aria-label="编辑 once"]')).toBeNull();
      expect(container.querySelector('.home-task-actions .home-task-edit')).toBeNull();

      await click('更多 routine');
      expect(
        [...container.querySelectorAll('.home-task-plan button')].map((entry) => entry.textContent),
      ).toEqual(['编辑', '今天不做']);
      await click('更多 once');
      expect(
        [...container.querySelectorAll('.home-task-plan button')].map((entry) => entry.textContent),
      ).toEqual(['编辑', '改到明天', '不做了']);

      await click('编辑 once');
      expect(test.onEdit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'once' }));
      expect(container.querySelector('.home-task-plan')).toBeNull();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('更多 once');
    });

    it('moves 编辑 on the card too, saving the note first', async () => {
      const test = harness([task('a')]);
      await test.render();
      await click('开始 a');
      expect(card()?.querySelector('[aria-label="编辑 a"]')).toBeNull();
      await typeNotes('第三节先写结论');
      await click('更多 a');
      expect(card()?.querySelector('.home-task-plan button')?.textContent).toBe('编辑');
      await click('编辑 a');
      expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节先写结论');
      expect(test.onEdit).toHaveBeenCalledOnce();
      expect(test.onSaveTaskNotes.mock.invocationCallOrder[0]).toBeLessThan(
        test.onEdit.mock.invocationCallOrder[0]!,
      );
      expect(container.querySelector('.home-task-plan')).toBeNull();
    });

    it('closes the menu with Esc and hands focus back to ⋯', async () => {
      const test = harness([task('a')]);
      await test.render();
      await click('更多 a');
      await act(async () =>
        container
          .querySelector('[aria-label="编辑 a"]')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(container.querySelector('.home-task-plan')).toBeNull();
      expect(document.activeElement?.getAttribute('aria-label')).toBe('更多 a');
    });

    it('closes with Esc straight after opening, while focus is still on ⋯', async () => {
      const test = harness([task('a')]);
      await test.render();
      const more = container.querySelector<HTMLButtonElement>('[aria-label="更多 a"]')!;
      more.focus();
      await click('更多 a');
      expect(container.querySelector('.home-task-plan')).not.toBeNull();
      await act(async () =>
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(container.querySelector('.home-task-plan')).toBeNull();
      expect(document.activeElement).toBe(more);
      await act(async () =>
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(container.querySelector('.home-task-plan')).toBeNull();
    });

    it('keeps the plain 编辑 on rows with no menu: a menu of one would only add a click', async () => {
      const onEdit = vi.fn();
      const done = task('done');
      const overview = {
        ...buildHomeTaskOverview([task('later', '2026-10-22')], [], [], today),
        completed: [
          {
            task: done,
            localDate: today,
            completion: { taskId: 'done', localDate: today, completedAt: today },
          },
        ],
      } as ReturnType<typeof buildHomeTaskOverview>;
      await act(async () =>
        root.render(
          <HomeTasks
            overview={overview}
            unavailable={false}
            busy={false}
            writer={{ createTask: vi.fn() }}
            onToggle={vi.fn()}
            onCreated={noop}
            onEdit={onEdit}
            onManage={noop}
            plan={{
              onApply: vi.fn(),
              onUndo: vi.fn(),
              onRestore: vi.fn(),
            }}
          />,
        ),
      );
      expect(container.querySelector('[aria-label="更多 later"]')).toBeNull();
      expect(container.querySelector('[aria-label="更多 done"]')).toBeNull();
      await click('编辑 later');
      expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'later' }));
      expect(container.querySelector('[aria-label="编辑 done"]')).not.toBeNull();

      // No plan controls at all: the same plain button, today's rows included.
      await act(async () =>
        root.render(
          <HomeTasks
            overview={buildHomeTaskOverview([task('a')], [], [], today)}
            unavailable={false}
            busy={false}
            writer={{ createTask: vi.fn() }}
            onToggle={vi.fn()}
            onCreated={noop}
            onEdit={onEdit}
            onManage={noop}
          />,
        ),
      );
      expect(container.querySelector('[aria-label="更多 a"]')).toBeNull();
      expect(container.querySelector('.home-task-actions [aria-label="编辑 a"]')).not.toBeNull();
    });

    it('can still edit when the list could not be read, though the plan items cannot run', async () => {
      const onEdit = vi.fn();
      const render = (busy: boolean) =>
        act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              readBlocked
              busy={busy}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={onEdit}
              onManage={noop}
              plan={{ onApply: vi.fn(), onUndo: vi.fn(), onRestore: vi.fn() }}
            />,
          ),
        );
      await render(false);
      await click('更多 a');
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="改到明天 a"]')?.disabled,
      ).toBe(true);
      await click('编辑 a');
      expect(onEdit).toHaveBeenCalledOnce();

      await render(true);
      expect(container.querySelector<HTMLButtonElement>('[aria-label="更多 a"]')?.disabled).toBe(
        true,
      );
    });

    it('shows the undo line in the card slot for the working row', async () => {
      const routine = daily('routine');
      const test = harness([routine, task('b')]);
      await test.render();
      await click('开始 routine');
      await click('更多 routine');
      await click('今天不做 routine');
      test.setCurrent(null);
      test.setOverview(
        buildHomeTaskOverview(
          [routine, task('b')],
          [],
          [{ taskId: 'routine', date: today, skippedAt: `${today}T10:00:00.000Z` }],
          today,
        ),
      );
      await test.render();
      expect(card()?.querySelector('.home-task-undo')?.textContent).toContain('今天已跳过');
      expect(container.querySelector('.home-working-fields')).toBeNull();
      // A skipped recurring task comes back as its next date, as after a completion.
      expect(visibleRows()).toEqual(['b', 'routine']);
    });

    it('lists skipped rows for 恢复今天 only when there are any', async () => {
      const routine = daily('routine');
      const test = harness([routine]);
      await test.render();
      expect(container.textContent).not.toContain('今天不做 ');
      test.setOverview({
        ...buildHomeTaskOverview([], [], [], today),
        skipped: [rowOf(routine)],
      });
      await test.render();
      await click('恢复今天 routine');
      expect(test.plan.onRestore).toHaveBeenCalledExactlyOnceWith(rowOf(routine));
    });

    it('expands the list after a create so the new row stays visible', async () => {
      const created = task('new');
      const test = harness([task('a'), task('b')]);
      await test.render();
      await click('开始 a');
      expect(visibleRows()).toEqual(['a']);
      await act(async () => root.unmount());
      root = createRoot(container);
      const onCreated = vi.fn();
      const createTask = vi.fn().mockResolvedValue(created);
      await act(async () =>
        root.render(
          <HomeTasks
            overview={buildHomeTaskOverview([task('a'), task('b')], [], [], today)}
            unavailable={false}
            busy={false}
            writer={{ createTask }}
            onToggle={vi.fn()}
            onCreated={onCreated}
            onEdit={noop}
            onManage={noop}
            working={{
              row: rowOf(task('a')),
              note: '',
              onStart: vi.fn(),
              onPutDown: vi.fn(),
              onSaveNote: vi.fn(),
              onSaveTaskNotes: vi.fn(),
            }}
          />,
        ),
      );
      expect(visibleRows()).toEqual(['a']);
      await clickText('添加待办');
      act(() => {
        const el = container.querySelector<HTMLInputElement>('.task-form input')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          el,
          '新任务',
        );
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickText('创建待办');
      expect(onCreated).toHaveBeenCalledOnce();
      expect(visibleRows()).toEqual(['a', 'b']);
    });

    it('starts collapsed again when the same task is restarted', async () => {
      const test = harness([task('a'), task('b')]);
      await test.render();
      await click('开始 a');
      await openList();
      await click('先放下 a');
      await click('开始 a');
      expect(
        container.querySelector('.home-working-rest-toggle')?.getAttribute('aria-expanded'),
      ).toBe('false');
    });

    it('keeps the way to the task page out of the collapsed view', async () => {
      const test = harness([task('a'), task('b')]);
      await test.render();
      const manage = () =>
        [...container.querySelectorAll('button')].find(
          (entry) => entry.textContent === '管理待办与历史',
        );
      expect(manage()).toBeDefined();
      await click('开始 a');
      expect(manage()).toBeUndefined();
      // An empty scroller must not be a tab stop.
      expect(container.querySelector('.home-task-scroll')?.hasAttribute('tabindex')).toBe(false);
      await openList();
      expect(manage()).toBeDefined();
      expect(container.querySelector('.home-task-scroll')?.getAttribute('tabindex')).toBe('0');
    });

    it('draws the undo line in a group that has no other rows', async () => {
      const once = task('once');
      const test = harness([once]);
      await test.render();
      await click('更多 once');
      await click('不做了 once');
      test.setOverview(buildHomeTaskOverview([{ ...once, archived: true }], [], [], today));
      await test.render();
      const group = container.querySelector('#home-task-today')!.closest('section')!;
      expect(group.querySelector('.home-task-undo')?.textContent).toContain('已取消待办');
    });

    it('disables row actions when the list could not be read, but never the writing', async () => {
      await act(async () =>
        root.render(
          <HomeTasks
            overview={buildHomeTaskOverview([task('a'), task('b')], [], [], today)}
            unavailable={false}
            readBlocked
            busy={false}
            writer={{ createTask: vi.fn() }}
            onToggle={vi.fn()}
            onCreated={noop}
            onEdit={noop}
            onManage={noop}
            working={{
              row: rowOf(task('a')),
              note: '',
              onStart: vi.fn(),
              onPutDown: vi.fn(),
              onSaveNote: vi.fn(),
              onSaveTaskNotes: vi.fn(),
            }}
          />,
        ),
      );
      for (const label of ['完成 a', '先放下 a']) {
        expect(
          container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled,
        ).toBe(true);
      }
      await openList();
      expect(container.querySelector<HTMLButtonElement>('[aria-label="开始 b"]')?.disabled).toBe(
        true,
      );
      expect(notesField()?.disabled).toBe(false);
      expect(nextLine()?.disabled).toBe(false);
    });

    it('shows a failed start in the save-error slot and changes nothing', async () => {
      await act(async () =>
        root.render(
          <HomeTasks
            overview={buildHomeTaskOverview([task('a')], [], [], today)}
            unavailable={false}
            busy={false}
            writer={{ createTask: vi.fn() }}
            onToggle={vi.fn()}
            onCreated={noop}
            onEdit={noop}
            onManage={noop}
            working={{
              row: null,
              note: '',
              onStart: vi.fn().mockRejectedValue(new Error('quota')),
              onPutDown: vi.fn(),
              onSaveNote: vi.fn(),
              onSaveTaskNotes: vi.fn(),
            }}
          />,
        ),
      );
      await click('开始 a');
      expect(container.textContent).toContain('没能开始，请重试。');
      expect(card()).toBeNull();
    });

    describe('row details', () => {
      it('says only what is not obvious: no 今天, no 一次性, and no empty line', async () => {
        const test = harness([
          task('plain'),
          daily('routine'),
          { ...task('timed'), scheduledTime: '09:30' },
          { ...task('urgent'), priority: 'high' },
          task('late', '2026-10-18'),
          task('later', '2026-10-22'),
        ]);
        await test.render();
        const meta = (id: string) =>
          container.querySelector(`[data-task-id="${id}"] .home-task-meta`)?.textContent ?? null;
        expect(container.querySelector('[data-task-id="plain"] .home-task-meta')).toBeNull();
        expect(meta('routine')).toBe('每天');
        expect(meta('timed')).toBe('09:30');
        expect(meta('urgent')).toBe('高优先级');
        expect(meta('late')).toBe('2026-10-18');
        expect(meta('later')).toBe('2026-10-22');
        expect(container.textContent).not.toContain('一次性');
        // The same rule on the card.
        await click('开始 plain');
        expect(card()?.querySelector('.home-task-meta')).toBeNull();
        await click('先放下 plain');
        await click('开始 routine');
        expect(card()?.querySelector('.home-task-meta')?.textContent).toBe('每天');
      });

      it('shows 查看备注 on ordinary rows but never on the card, where the note is open', async () => {
        const noted = { ...task('noted'), notes: '记得带笔记本' };
        const test = harness([noted, { ...task('other'), notes: '另一条' }]);
        await test.render();
        expect(container.querySelectorAll('.home-task-notes')).toHaveLength(2);
        await click('开始 noted');
        expect(card()?.querySelector('.home-task-notes')).toBeNull();
        expect(card()?.textContent).not.toContain('查看备注');
        expect(notesField()?.value).toBe('记得带笔记本');
        await openList();
        expect(container.querySelector('[data-task-id="other"] .home-task-notes')).not.toBeNull();
      });

      it('has no second heading line in the header, and the heading can still take focus', async () => {
        const test = harness([task('a')]);
        await test.render();
        expect(container.querySelector('.home-tasks-header .eyebrow')).toBeNull();
        expect(container.querySelector('#home-tasks-heading')?.getAttribute('tabindex')).toBe('-1');
      });
    });

    describe('empty groups', () => {
      it('hides overdue at zero and says nothing about an empty today or later', async () => {
        const test = harness([task('a')]);
        await test.render();
        expect(container.querySelector('#home-task-overdue')).toBeNull();
        expect(container.querySelector('#home-task-today')).not.toBeNull();
        expect(container.querySelector('#home-task-upcoming')).not.toBeNull();
        for (const words of [
          '没有逾期任务',
          '今天没有未完成的任务',
          '没有之后的安排',
          '今天还没有完成记录。',
        ])
          expect(container.textContent).not.toContain(words);
        // A disclosure with nothing in it is not drawn at all.
        expect(container.querySelector('.home-task-completed-group')).toBeNull();
        test.setOverview(buildHomeTaskOverview([task('a')], [doneOn('a')], [], today));
        await test.render();
        expect(container.querySelector('.home-task-completed-group')?.textContent).toContain(
          '今天已完成',
        );
      });

      it('keeps the overdue group while its last row finishes, then folds them together', async () => {
        vi.useFakeTimers();
        try {
          const late = task('late', '2026-10-18');
          const props = taskProps(vi.fn().mockResolvedValue(true));
          const finished = { ...celebrationFor('late'), localDate: '2026-10-18' };
          await act(async () =>
            root.render(
              <HomeTasks {...props} overview={buildHomeTaskOverview([late], [], [], today)} />,
            ),
          );
          const group = () => container.querySelector('#home-task-overdue')?.closest('section');
          expect(group()).not.toBeNull();
          await click('完成 late');
          await act(async () =>
            root.render(
              <HomeTasks
                {...props}
                overview={buildHomeTaskOverview([late], [], [], today)}
                celebration={finished}
              />,
            ),
          );
          await act(async () =>
            root.render(
              <HomeTasks
                {...props}
                overview={buildHomeTaskOverview([], [], [], today)}
                celebration={finished}
              />,
            ),
          );
          expect(group()?.querySelector('.home-task-ghost')).not.toBeNull();
          expect(group()?.classList.contains('is-folding')).toBe(false);
          await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.rowHold));
          expect(group()?.classList.contains('is-folding')).toBe(true);
          await act(async () => vi.advanceTimersByTime(TASK_CELEBRATION_MS.rowCollapse));
          expect(group()).toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps the overdue group for the undo line of its last row', async () => {
        const late = task('late', '2026-10-18');
        const test = harness([late]);
        await test.render();
        await click('更多 late');
        await click('不做了 late');
        test.setOverview(buildHomeTaskOverview([{ ...late, archived: true }], [], [], today));
        await test.render();
        expect(
          container.querySelector('#home-task-overdue')?.closest('section')?.textContent,
        ).toContain('已取消待办');
        await click('撤销 late');
        await test.render();
        expect(container.querySelector('#home-task-overdue')).toBeNull();
      });
    });

    describe('next step line', () => {
      it('is one quiet button until it is clicked, then an input that takes focus', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        expect(nextLine()?.tagName).toBe('BUTTON');
        expect(nextLine()?.textContent).toBe('+ 下一步');
        await act(async () => nextLine()!.click());
        expect(nextLine()).toBeNull();
        expect(document.activeElement).toBe(nextInput());
      });

      it('shows the saved words after Enter and returns focus to them', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await writeNext('打开文档，写小标题');
        expect(test.notes.get('a')).toBe('打开文档，写小标题');
        expect(nextInput()).toBeNull();
        expect(nextLine()?.textContent).toBe('下一步：打开文档，写小标题');
        expect(document.activeElement).toBe(nextLine());
      });

      it('saves on blur too, without pulling focus back', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        await act(async () => nextInput()!.blur());
        expect(test.notes.get('a')).toBe('写小标题');
        expect(nextLine()?.textContent).toBe('下一步：写小标题');
        expect(document.activeElement).not.toBe(nextLine());
      });

      it('saves once when Enter ends the edit', async () => {
        const onSaveNote = vi.fn().mockResolvedValue(undefined);
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote,
                onSaveTaskNotes: vi.fn(),
              }}
            />,
          ),
        );
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        await keyOnNext('Enter');
        expect(onSaveNote).toHaveBeenCalledOnce();
      });

      it('Esc leaves everything as it was, and returns focus to the line', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await writeNext('写小标题');
        await act(async () => nextLine()!.click());
        expect(nextInput()?.value).toBe('写小标题');
        await typeNext('别的内容');
        await keyOnNext('Escape');
        expect(test.notes.get('a')).toBe('写小标题');
        expect(nextLine()?.textContent).toBe('下一步：写小标题');
        expect(document.activeElement).toBe(nextLine());
      });

      it('clearing it goes back to + 下一步', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await writeNext('写小标题');
        await writeNext('');
        expect(test.notes.get('a')).toBe('');
        expect(nextLine()?.textContent).toBe('+ 下一步');
      });

      it('does not submit on the Enter that ends a Chinese composition', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        await keyOnNext('Enter', { isComposing: true });
        await keyOnNext('Enter', { keyCode: 229 });
        await keyOnNext('Escape', { isComposing: true });
        expect(test.notes.has('a')).toBe(false);
        expect(nextInput()?.value).toBe('写小标题');
        await keyOnNext('Enter');
        expect(test.notes.get('a')).toBe('写小标题');
      });

      it('keeps the text and the input after a failed save, and clears the error on retry', async () => {
        const onSaveNote = vi
          .fn()
          .mockRejectedValueOnce(new Error('quota'))
          .mockResolvedValue(undefined);
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote,
                onSaveTaskNotes: vi.fn(),
              }}
            />,
          ),
        );
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        await keyOnNext('Enter');
        expect(container.textContent).toContain('下一步没保存，请重试。');
        expect(nextInput()?.value).toBe('写小标题');
        expect(document.activeElement).toBe(nextInput());
        await keyOnNext('Enter');
        expect(onSaveNote).toHaveBeenCalledTimes(2);
        expect(container.textContent).not.toContain('下一步没保存，请重试。');
      });

      it('a failed save can be abandoned with Esc', async () => {
        const onSaveNote = vi.fn().mockRejectedValue(new Error('quota'));
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote,
                onSaveTaskNotes: vi.fn(),
              }}
            />,
          ),
        );
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        await keyOnNext('Enter');
        await keyOnNext('Escape');
        expect(container.textContent).not.toContain('下一步没保存，请重试。');
        expect(nextLine()?.textContent).toBe('+ 下一步');
      });

      it('saves an open next step before the page is left, with nothing to ask', async () => {
        const confirm = vi.spyOn(window, 'confirm');
        try {
          const test = harness([task('a')]);
          await test.render();
          await click('开始 a');
          await act(async () => nextLine()!.click());
          // The stored words are trimmed, so the field's text changes when it closes. That must
          // not look like more typing.
          await typeNext('写小标题 ');
          expect(await leaveAsync()).toBe(true);
          expect(test.notes.get('a')).toBe('写小标题');
          expect(confirm).not.toHaveBeenCalled();
        } finally {
          confirm.mockRestore();
        }
      });

      it('stays on the page, with the text and the error, when that save fails', async () => {
        const onSaveNote = vi.fn().mockRejectedValue(new Error('quota'));
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote,
                onSaveTaskNotes: vi.fn(),
              }}
            />,
          ),
        );
        await act(async () => nextLine()!.click());
        await typeNext('写小标题');
        expect(await leaveAsync()).toBe(false);
        expect(nextInput()?.value).toBe('写小标题');
        expect(container.textContent).toContain('下一步没保存，请重试。');
        expect(document.activeElement).toBe(nextInput());
        // Esc is still the way to give it up, and then nothing holds the page.
        await keyOnNext('Escape');
        expect(await leaveAsync()).toBe(true);
      });

      it('stays when more was typed during the save that a leave waited for', async () => {
        let finish: () => void = () => undefined;
        const onSaveNote = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote,
                onSaveTaskNotes: vi.fn(),
              }}
            />,
          ),
        );
        await act(async () => nextLine()!.click());
        await typeNext('第一段');
        const leaving = requestEditorLeaveAsync();
        await act(async () => Promise.resolve());
        await typeNext('第一段，又打了几个字');
        await act(async () => finish());
        expect(await leaving).toBe(false);
        expect(nextInput()?.value).toBe('第一段，又打了几个字');
      });

      it('asks before a reload while it holds unsaved words, and only then', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        expect(await reloadAsks()).toBe(false);
        await act(async () => nextLine()!.click());
        expect(await reloadAsks()).toBe(false);
        await typeNext('写小标题');
        expect(await reloadAsks()).toBe(true);
        await keyOnNext('Escape');
        expect(await reloadAsks()).toBe(false);
      });

      it('does not let a saved next step stand in for the note that could not be saved', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
          const test = harness([task('a')]);
          await test.render();
          await click('开始 a');
          test.onSaveTaskNotes.mockRejectedValue(new Error('quota'));
          await typeNotes('第三节');
          await act(async () => notesField()!.blur());
          await act(async () => nextLine()!.click());
          await typeNext('写小标题');
          expect(await leaveAsync()).toBe(false);
          expect(confirm).toHaveBeenCalledOnce();
          expect(notesField()?.value).toBe('第三节');
        } finally {
          confirm.mockRestore();
        }
      });

      it('saves what was typed after Enter when the field is left, and then closes', async () => {
        let finish: () => void = () => undefined;
        const onSaveNote = vi
          .fn()
          .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
          .mockResolvedValue(undefined);
        const renderCard = (note: string) =>
          act(async () =>
            root.render(
              <HomeTasks
                overview={buildHomeTaskOverview([task('a')], [], [], today)}
                unavailable={false}
                busy={false}
                writer={{ createTask: vi.fn() }}
                onToggle={vi.fn()}
                onCreated={noop}
                onEdit={noop}
                onManage={noop}
                working={{
                  row: rowOf(task('a')),
                  note,
                  onStart: vi.fn(),
                  onPutDown: vi.fn(),
                  onSaveNote,
                  onSaveTaskNotes: vi.fn(),
                }}
              />,
            ),
          );
        await renderCard('');
        await act(async () => nextLine()!.click());
        await typeNext('第一段');
        await keyOnNext('Enter');
        await typeNext('第一段，又打了几个字');
        await act(async () => finish());
        await renderCard('第一段');
        expect(nextInput()?.value).toBe('第一段，又打了几个字');
        await act(async () => nextInput()!.blur());
        expect(onSaveNote).toHaveBeenCalledTimes(2);
        expect(onSaveNote).toHaveBeenLastCalledWith(rowOf(task('a')), '第一段，又打了几个字');
        expect(nextInput()).toBeNull();
        expect(document.activeElement).not.toBe(nextLine());
      });

      it('holds the line back until a press has become its click', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          const test = harness([task('a')]);
          await test.render();
          await click('开始 a');
          await act(async () => nextLine()!.click());
          await typeNext('写小标题');
          await press();
          await act(async () => nextInput()!.blur());
          // Saved at once, but the field keeps its shape while the pointer is down.
          expect(test.notes.get('a')).toBe('写小标题');
          expect(nextInput()?.value).toBe('写小标题');
          expect(requestEditorLeave()).toBe(true);
          await release();
          expect(nextInput()).not.toBeNull();
          await act(async () => vi.advanceTimersByTime(0));
          expect(nextInput()).toBeNull();
          expect(nextLine()?.textContent).toBe('下一步：写小标题');
        } finally {
          vi.useRealTimers();
        }
      });

      it('is not drawn on ordinary rows', async () => {
        const test = harness([task('a'), task('b')]);
        await test.render();
        expect(nextLine()).toBeNull();
        await click('开始 a');
        await writeNext('写小标题');
        await click('先放下 a');
        expect(container.textContent).not.toContain('写小标题');
      });
    });

    describe('note', () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

      it('saves 2 s after typing stops, once, and only then says 已保存', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        expect(notesField()?.getAttribute('placeholder')).toBe('想到什么记在这里');
        expect(container.querySelector('label[for="home-working-notes-input"]')?.textContent).toBe(
          '笔记',
        );
        expect(notesStatus()).toBe('');
        await typeNotes('第');
        await wait(1500);
        await typeNotes('第三节');
        await wait(1999);
        expect(test.onSaveTaskNotes).not.toHaveBeenCalled();
        expect(notesStatus()).toBe('');
        await wait(1);
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节');
        expect(notesStatus()).toBe('已保存');
        // Typing again: the word no longer holds until the next save.
        await typeNotes('第三节先写结论');
        expect(notesStatus()).toBe('');
        await wait(2000);
        expect(notesStatus()).toBe('已保存');
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
        // Nothing more is scheduled.
        await wait(20000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
      });

      it('keeps 已保存 through a trailing newline, which has nothing to save', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await typeNotes('第三节');
        await wait(2000);
        expect(notesStatus()).toBe('已保存');
        await typeNotes('第三节\n');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
        expect(notesStatus()).toBe('已保存');
        // And the caret's line is still there: the text is not tidied under the user.
        expect(notesField()?.value).toBe('第三节\n');
      });

      it('does not open a restarted card on the 已保存 of last time', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('第三节');
        await wait(2000);
        expect(notesStatus()).toBe('已保存');
        await click('先放下 a');
        await click('开始 a');
        expect(notesStatus()).toBe('');
        expect(notesField()?.value).toBe('第三节');
      });

      it('saves on blur at once, and a blur with nothing new writes nothing', async () => {
        const test = harness([{ ...task('a'), notes: '已有的笔记' }]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await act(async () => notesField()!.blur());
        expect(test.onSaveTaskNotes).not.toHaveBeenCalled();
        await act(async () => notesField()!.focus());
        await typeNotes('改过的笔记');
        await act(async () => notesField()!.blur());
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '改过的笔记');
        await wait(5000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
      });

      it('turns an empty note into null', async () => {
        const test = harness([{ ...task('a'), notes: '已有的笔记' }]);
        await test.render();
        await click('开始 a');
        await typeNotes('   ');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', null);
      });

      it('keeps the text after a failed save, says so, and writes again when asked', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
        await typeNotes('第三节先写结论');
        await wait(2000);
        expect(notesField()?.value).toBe('第三节先写结论');
        expect(notesStatus()).toBe('没保存，请重试');
        // It does not retry by itself.
        await wait(60000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
        await act(async () =>
          container.querySelector<HTMLButtonElement>('.home-working-notes-retry')!.click(),
        );
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
        expect(notesField()?.value).toBe('第三节先写结论');
        expect(notesStatus()).toBe('已保存');
        // The button is gone, and focus did not go with it.
        expect(document.activeElement).toBe(notesField());
      });

      it('never takes the row: nothing is disabled or moved while a save runs', async () => {
        let finish: (task: DailyTask) => void = () => undefined;
        const onSaveTaskNotes = vi.fn(
          () => new Promise<DailyTask>((resolve) => (finish = resolve)),
        );
        const onToggle = vi.fn();
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={onToggle}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote: vi.fn(),
                onSaveTaskNotes,
              }}
            />,
          ),
        );
        await typeNotes('第三节');
        await wait(2000);
        expect(onSaveTaskNotes).toHaveBeenCalledOnce();
        for (const control of container.querySelectorAll<HTMLButtonElement>(
          '.home-working-card button',
        ))
          expect(control.disabled).toBe(false);
        expect(notesField()?.disabled).toBe(false);
        // Typing during the write is kept, and goes out as the next write.
        await typeNotes('第三节先写结论');
        await act(async () => finish({ ...task('a'), notes: '第三节' }));
        expect(notesField()?.value).toBe('第三节先写结论');
        expect(notesStatus()).toBe('');
        await wait(2000);
        expect(onSaveTaskNotes).toHaveBeenCalledTimes(2);
        expect(onSaveTaskNotes).toHaveBeenLastCalledWith('a', '第三节先写结论');
        expect(onToggle).not.toHaveBeenCalled();
      });

      it('saves before 先放下, and stays when it cannot', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
        await typeNotes('第三节先写结论');
        await click('先放下 a');
        expect(card()).not.toBeNull();
        expect(notesField()?.value).toBe('第三节先写结论');
        expect(notesStatus()).toBe('没保存，请重试');
        await click('先放下 a');
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
        expect(card()).toBeNull();
      });

      it('saves before completing, and does not complete when it cannot', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
        await typeNotes('第三节先写结论');
        await click('完成 a');
        expect(test.onToggle).not.toHaveBeenCalled();
        expect(notesStatus()).toBe('没保存，请重试');
        await click('完成 a');
        expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '第三节先写结论');
        expect(test.onToggle).toHaveBeenCalledOnce();
      });

      it('saves before a plan action on the card', async () => {
        const test = harness([daily('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('第三节先写结论');
        await click('更多 a');
        await click('今天不做 a');
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节先写结论');
        expect(test.plan.onApply).toHaveBeenCalledOnce();
      });

      it('saves before 编辑 and hands the form the saved version', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('第三节先写结论');
        await click('更多 a');
        await click('编辑 a');
        const edited = test.onEdit.mock.calls[0]?.[0] as DailyTask;
        expect(edited.notes).toBe('第三节先写结论');
        expect(edited.updatedAt).toBe(new Date(2026, 9, 20, 13, 0, 1).toISOString());
      });

      it('does not open the form when the note cannot be saved', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
        await typeNotes('第三节先写结论');
        await click('更多 a');
        await click('编辑 a');
        expect(test.onEdit).not.toHaveBeenCalled();
        expect(notesStatus()).toBe('没保存，请重试');
        expect(document.activeElement?.getAttribute('aria-label')).toBe('更多 a');
      });

      it('does nothing more for a second click while the note is being written', async () => {
        let finish: (task: DailyTask) => void = () => undefined;
        const onToggle = vi.fn().mockResolvedValue(true);
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={onToggle}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote: vi.fn(),
                onSaveTaskNotes: () => new Promise<DailyTask>((resolve) => (finish = resolve)),
              }}
            />,
          ),
        );
        await typeNotes('第三节');
        await click('完成 a');
        await click('完成 a');
        await act(async () => finish({ ...task('a'), notes: '第三节' }));
        expect(onToggle).toHaveBeenCalledOnce();
      });

      it('saves when the page hides or unloads, and on unmount, and clears its timer', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('第三节');
        const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        await act(async () => document.dispatchEvent(new Event('visibilitychange')));
        hidden.mockRestore();
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节');
        await typeNotes('第三节先写结论');
        await act(async () => window.dispatchEvent(new Event('pagehide')));
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
        await typeNotes('第三节先写结论，再说明');
        await act(async () => window.dispatchEvent(new Event('beforeunload')));
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(3);
        await typeNotes('第三节先写结论，再补证据');
        await act(async () => root.unmount());
        root = createRoot(container);
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(4);
        expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '第三节先写结论，再补证据');
        await wait(10000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(4);
        // Nothing is listening after that.
        await act(async () => window.dispatchEvent(new Event('beforeunload')));
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(4);
      });

      it('starts the write as a reload begins, without asking about typed text', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('第三节');
        expect(await reloadAsks()).toBe(false);
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节');
      });

      it('asks before a reload only when the text could not be saved', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        test.onSaveTaskNotes.mockRejectedValue(new Error('quota'));
        await typeNotes('第三节');
        await wait(2000);
        expect(notesStatus()).toBe('没保存，请重试');
        expect(await reloadAsks()).toBe(true);
      });

      it('waits for the write before a leave inside the app, and asks only if it failed', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        try {
          const test = harness([task('a')]);
          await test.render();
          await click('开始 a');
          // Typed a moment ago, with focus still in the field: Back never blurs it.
          await act(async () => notesField()!.focus());
          await typeNotes('第三节');
          expect(requestEditorLeave()).toBe(true);
          expect(await leaveAsync()).toBe(true);
          expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节');
          expect(confirm).not.toHaveBeenCalled();

          test.onSaveTaskNotes.mockRejectedValue(new Error('quota'));
          await typeNotes('第三节先写结论');
          expect(await leaveAsync()).toBe(false);
          expect(confirm).toHaveBeenCalledOnce();
          expect(notesField()?.value).toBe('第三节先写结论');
          expect(notesStatus()).toBe('没保存，请重试');
          expect(document.activeElement).toBe(notesField());

          // Told what it costs, the user can still give it up and go.
          confirm.mockReturnValue(true);
          expect(await leaveAsync()).toBe(true);
        } finally {
          confirm.mockRestore();
        }
      });

      it('stays when more was typed during the write that a leave waited for', async () => {
        let finish: (task: DailyTask) => void = () => undefined;
        const onSaveTaskNotes = vi
          .fn()
          .mockImplementationOnce(() => new Promise<DailyTask>((resolve) => (finish = resolve)))
          .mockImplementation(async (_id: string, notes: string) => ({ ...task('a'), notes }));
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote: vi.fn(),
                onSaveTaskNotes,
              }}
            />,
          ),
        );
        await typeNotes('第三节');
        const leaving = requestEditorLeaveAsync();
        await act(async () => Promise.resolve());
        await typeNotes('第三节先写结论');
        await act(async () => finish({ ...task('a'), notes: '第三节' }));
        expect(await leaving).toBe(false);
        expect(notesField()?.value).toBe('第三节先写结论');
      });

      it('does not save pinyin while a Chinese word is being chosen', async () => {
        const test = harness([{ ...task('a'), notes: '已经有的。' }]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await act(async () =>
          notesField()!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
        );
        await typeNotes('已经有的。xiexiao');
        await wait(2000);
        await typeNotes('已经有的。xiexiaobiao');
        await wait(10000);
        expect(test.onSaveTaskNotes).not.toHaveBeenCalled();
        expect(notesStatus()).toBe('');
        // Chromium sends the last input first, and then the end of the composition.
        await typeNotes('已经有的。写小标');
        await act(async () =>
          notesField()!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
        );
        await wait(1999);
        expect(test.onSaveTaskNotes).not.toHaveBeenCalled();
        await wait(1);
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '已经有的。写小标');
        expect(notesStatus()).toBe('已保存');
      });

      it('leaving the field mid-composition still saves, and typing later saves by itself', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await act(async () =>
          notesField()!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
        );
        await typeNotes('写');
        await act(async () => notesField()!.blur());
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '写');
        await act(async () => notesField()!.focus());
        await typeNotes('写小标题');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '写小标题');
      });

      it('keeps the height of the note until a press has become its click', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await typeNotes('第三节');
        await wait(2000);
        await typeNotes('第三节\n');
        await press();
        await act(async () => notesField()!.blur());
        expect(notesField()?.value).toBe('第三节\n');
        await release();
        expect(notesField()?.value).toBe('第三节\n');
        await wait(0);
        expect(notesField()?.value).toBe('第三节');
      });

      it.each([
        ['a cancelled press', () => window.dispatchEvent(new Event('pointercancel'))],
        ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
        [
          'a key, when the release was never heard',
          () => window.dispatchEvent(new Event('keydown')),
        ],
      ])('lets go of a press on %s, so nothing stays held back', async (_name, end) => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await typeNotes('第三节');
        await wait(2000);
        await typeNotes('第三节\n');
        await press();
        await act(async () => notesField()!.blur());
        await act(async () => end());
        await wait(0);
        expect(notesField()?.value).toBe('第三节');
      });

      it('a right-click holds nothing back: only the main button makes a click', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await typeNotes('第三节');
        await wait(2000);
        await typeNotes('第三节\n');
        await act(async () => {
          window.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
        });
        await act(async () => notesField()!.blur());
        expect(notesField()?.value).toBe('第三节');
      });

      it('returns focus to the field when a save takes the retry button away under it', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
        await typeNotes('第三节');
        await wait(2000);
        const retry = container.querySelector<HTMLButtonElement>('.home-working-notes-retry')!;
        expect(retry).not.toBeNull();
        // Shift+Tab: leaving the field saves it, and storage has recovered.
        await act(async () => retry.focus());
        expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(2);
        expect(notesStatus()).toBe('已保存');
        expect(container.querySelector('.home-working-notes-retry')).toBeNull();
        expect(document.activeElement).toBe(notesField());
      });

      it('does not pull focus back from anywhere else when that save succeeds', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        test.onSaveTaskNotes.mockRejectedValue(new Error('quota'));
        await typeNotes('第三节');
        await wait(2000);
        await act(async () => notesField()!.blur());
        // Focus on the button, then away to nothing: a click on the blank page.
        const retry = container.querySelector<HTMLButtonElement>('.home-working-notes-retry')!;
        await act(async () => retry.focus());
        await act(async () => retry.blur());
        test.onSaveTaskNotes.mockReset();
        test.onSaveTaskNotes.mockImplementation(async (_id: string, value: string | null) => ({
          ...task('a'),
          notes: value,
        }));
        expect(document.activeElement).toBe(document.body);
        await act(async () => window.dispatchEvent(new Event('pagehide')));
        expect(notesStatus()).toBe('已保存');
        expect(document.activeElement).toBe(document.body);
      });

      it('adopts a change from elsewhere once a focused field has been removed', async () => {
        const test = harness([{ ...task('a'), notes: '原来的笔记' }]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        // Put down in another window: the field goes with no blur event, and later returns.
        test.setCurrent(null);
        await test.render();
        expect(notesField()).toBeNull();
        test.changeElsewhere('a', {
          notes: '另一个窗口改的',
          updatedAt: new Date(2026, 9, 20, 14).toISOString(),
        });
        test.setCurrent('a');
        await test.render();
        expect(document.activeElement).not.toBe(notesField());
        expect(notesField()?.value).toBe('另一个窗口改的');
        await typeNotes('另一个窗口改的，再加一句');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '另一个窗口改的，再加一句');
      });

      it('does not wait for the end of a composition whose field was removed', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await act(async () =>
          notesField()!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
        );
        test.setCurrent(null);
        await test.render();
        test.setCurrent('a');
        await test.render();
        await act(async () => notesField()!.focus());
        await typeNotes('第三节');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节');
      });

      it('still saves waiting text once, when a focused field is removed with it', async () => {
        const test = harness([task('a'), task('b')]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        await typeNotes('a 的笔记');
        test.setCurrent(null);
        await test.render();
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', 'a 的笔记');
        await wait(10000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
      });

      describe('a note whose card has moved on', () => {
        const stranded = () => container.querySelector('.home-working-stranded');
        const strandedButton = (text: string) =>
          [...(stranded()?.querySelectorAll('button') ?? [])].find(
            (entry) => entry.textContent === text,
          )!;
        /** Text on a, a failing write, and another window starting b. */
        async function strand() {
          const test = harness([task('a'), task('b')]);
          await test.render();
          await click('开始 a');
          test.onSaveTaskNotes.mockRejectedValueOnce(new Error('Task a was not found.'));
          await typeNotes('a 的笔记');
          test.setCurrent('b');
          await test.render();
          return test;
        }

        it('says so, keeps the words readable, and leaves the next card clean', async () => {
          await strand();
          expect(stranded()?.textContent).toContain('上一项的笔记没保存');
          expect(stranded()?.querySelector('.home-working-stranded-text')?.textContent).toBe(
            'a 的笔记',
          );
          expect(stranded()?.closest('[role="alert"]')).not.toBeNull();
          expect(notesField()?.value).toBe('');
          expect(notesStatus()).toBe('');
        });

        it('holds up nothing on the next card', async () => {
          const test = await strand();
          await click('更多 b');
          await click('编辑 b');
          expect(test.onEdit).toHaveBeenCalledOnce();
          await click('完成 b');
          expect(test.onToggle).toHaveBeenCalledOnce();
        });

        it('lets the next card put down and plan as usual', async () => {
          const test = await strand();
          await click('更多 b');
          await click('改到明天 b');
          expect(test.plan.onApply).toHaveBeenCalledOnce();
          await click('先放下 b');
          expect(card()).toBeNull();
          expect(stranded()?.textContent).toContain('a 的笔记');
        });

        it('is not overwritten by typing on the next card, and each goes to its own task', async () => {
          const test = await strand();
          await act(async () => notesField()!.focus());
          await typeNotes('b 的笔记');
          await wait(2000);
          expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('b', 'b 的笔记');
          expect(stranded()?.textContent).toContain('a 的笔记');
          await act(async () => strandedButton('重试').click());
          expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', 'a 的笔记');
          expect(stranded()).toBeNull();
          expect(notesField()?.value).toBe('b 的笔记');
        });

        it('says when a retry failed too, and can be given up', async () => {
          const test = await strand();
          test.onSaveTaskNotes.mockRejectedValueOnce(new Error('Task a was not found.'));
          await act(async () => strandedButton('重试').click());
          expect(stranded()?.textContent).toContain('上一项的笔记还是没保存');
          expect(stranded()?.textContent).toContain('a 的笔记');
          const writes = test.onSaveTaskNotes.mock.calls.length;
          await act(async () => strandedButton('放弃').click());
          expect(stranded()).toBeNull();
          await wait(10000);
          expect(test.onSaveTaskNotes).toHaveBeenCalledTimes(writes);
        });

        it('does not write it again on its own', async () => {
          const test = await strand();
          await wait(60000);
          expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
          await act(async () => window.dispatchEvent(new Event('pagehide')));
          expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
        });

        it('sends focus to the list heading when the notice holding it leaves', async () => {
          await strand();
          await act(async () => strandedButton('放弃').focus());
          await act(async () => strandedButton('放弃').click());
          expect(document.activeElement).toBe(container.querySelector('#home-tasks-heading'));
        });

        it('comes back to its field when its card does, with the field’s own retry', async () => {
          const test = await strand();
          test.setCurrent('a');
          await test.render();
          expect(stranded()).toBeNull();
          expect(notesField()?.value).toBe('a 的笔记');
          expect(notesStatus()).toBe('没保存，请重试');
          await act(async () =>
            container.querySelector<HTMLButtonElement>('.home-working-notes-retry')!.click(),
          );
          expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', 'a 的笔记');
          expect(notesStatus()).toBe('已保存');
        });

        it('keeps the newest text of a card that moved on during its write', async () => {
          let fail: (reason: Error) => void = () => undefined;
          const test = harness([task('a'), task('b')]);
          await test.render();
          await click('开始 a');
          test.onSaveTaskNotes.mockImplementationOnce(
            () => new Promise<DailyTask>((_resolve, reject) => (fail = reject)),
          );
          await typeNotes('第一段');
          await wait(2000);
          await typeNotes('第一段，第二段');
          test.setCurrent('b');
          await test.render();
          // Clicking into the next card must not lose the second paragraph.
          await act(async () => notesField()!.focus());
          await act(async () => fail(new Error('quota')));
          expect(stranded()?.querySelector('.home-working-stranded-text')?.textContent).toBe(
            '第一段，第二段',
          );
          expect(notesField()?.value).toBe('');
        });

        it('still writes newer text when the older write succeeds after the card moved', async () => {
          let finish: (task: DailyTask) => void = () => undefined;
          const test = harness([task('a'), task('b')]);
          await test.render();
          await click('开始 a');
          test.onSaveTaskNotes.mockImplementationOnce(
            () => new Promise<DailyTask>((resolve) => (finish = resolve)),
          );
          await typeNotes('第一段');
          await wait(2000);
          await typeNotes('第一段，第二段');
          test.setCurrent('b');
          await test.render();
          await act(async () => notesField()!.focus());
          await act(async () => finish({ ...task('a'), notes: '第一段' }));
          expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '第一段，第二段');
          expect(stranded()).toBeNull();
        });

        it('does not fail an action that was waiting on a write its card has moved on from', async () => {
          let fail: (reason: Error) => void = () => undefined;
          const test = harness([task('a'), task('b')]);
          await test.render();
          await click('开始 a');
          test.onSaveTaskNotes.mockImplementationOnce(
            () => new Promise<DailyTask>((_resolve, reject) => (fail = reject)),
          );
          await typeNotes('a 的笔记');
          await click('更多 a');
          await click('编辑 a');
          expect(test.onEdit).not.toHaveBeenCalled();
          test.setCurrent('b');
          await test.render();
          await act(async () => fail(new Error('quota')));
          // The words are kept in the notice, so nothing is lost by carrying on.
          expect(stranded()?.textContent).toContain('a 的笔记');
          expect(test.onEdit).toHaveBeenCalledOnce();
        });

        it('counts in every leave guard', async () => {
          const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
          try {
            const test = await strand();
            expect(await reloadAsks()).toBe(true);
            expect(requestEditorLeave()).toBe(false);
            expect(confirm).toHaveBeenCalledOnce();
            // A leave tries once more first, and goes when that works.
            test.onSaveTaskNotes.mockRejectedValueOnce(new Error('quota'));
            expect(await leaveAsync()).toBe(false);
            expect(confirm).toHaveBeenCalledTimes(2);
            expect(stranded()?.textContent).toContain('还是没保存');
            expect(await leaveAsync()).toBe(true);
            expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', 'a 的笔记');
            expect(confirm).toHaveBeenCalledTimes(2);
            expect(stranded()).toBeNull();
            expect(await reloadAsks()).toBe(false);
          } finally {
            confirm.mockRestore();
          }
        });

        it('stops holding the page once it is given up', async () => {
          await strand();
          expect(await reloadAsks()).toBe(true);
          await act(async () => strandedButton('放弃').click());
          expect(await reloadAsks()).toBe(false);
          expect(requestEditorLeave()).toBe(true);
        });
      });

      it('a text that was waiting still goes to its own task when the card moves on', async () => {
        const test = harness([task('a'), task('b')]);
        await test.render();
        await click('开始 a');
        await typeNotes('a 的笔记');
        // Another window started a different card.
        test.setCurrent('b');
        await test.render();
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', 'a 的笔记');
        expect(notesField()?.value).toBe('');
        await wait(10000);
        expect(test.onSaveTaskNotes).toHaveBeenCalledOnce();
      });

      it('a refreshed row never overwrites text being edited', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        await typeNotes('正在写的内容');
        test.changeElsewhere('a', {
          notes: '手机上改的',
          updatedAt: new Date(2026, 9, 20, 14).toISOString(),
        });
        await test.render();
        expect(notesField()?.value).toBe('正在写的内容');
        await wait(2000);
        expect(test.onSaveTaskNotes).toHaveBeenLastCalledWith('a', '正在写的内容');
        expect(notesField()?.value).toBe('正在写的内容');
      });

      it('a focused field keeps its text through a refresh, and adopts it on leaving', async () => {
        const test = harness([{ ...task('a'), notes: '原来的' }]);
        await test.render();
        await click('开始 a');
        await act(async () => notesField()!.focus());
        test.changeElsewhere('a', {
          notes: '手机上改的',
          updatedAt: new Date(2026, 9, 20, 14).toISOString(),
        });
        await test.render();
        expect(notesField()?.value).toBe('原来的');
        await act(async () => notesField()!.blur());
        expect(notesField()?.value).toBe('手机上改的');
        expect(test.onSaveTaskNotes).not.toHaveBeenCalled();
      });

      it('adopts a change from elsewhere while nothing is being written', async () => {
        const test = harness([task('a')]);
        await test.render();
        await click('开始 a');
        expect(notesField()?.value).toBe('');
        test.changeElsewhere('a', {
          notes: '编辑表单里改的',
          updatedAt: new Date(2026, 9, 20, 14).toISOString(),
        });
        await test.render();
        expect(notesField()?.value).toBe('编辑表单里改的');
      });

      it('does not go back to the old text in the moment before the list catches up', async () => {
        // The list here never catches up, as in the moment between a save and its redraw.
        const onSaveTaskNotes = vi.fn(async () => ({ ...task('a'), notes: '第三节' }));
        await act(async () =>
          root.render(
            <HomeTasks
              overview={buildHomeTaskOverview([task('a')], [], [], today)}
              unavailable={false}
              busy={false}
              writer={{ createTask: vi.fn() }}
              onToggle={vi.fn()}
              onCreated={noop}
              onEdit={noop}
              onManage={noop}
              working={{
                row: rowOf(task('a')),
                note: '',
                onStart: vi.fn(),
                onPutDown: vi.fn(),
                onSaveNote: vi.fn(),
                onSaveTaskNotes,
              }}
            />,
          ),
        );
        await typeNotes('第三节');
        await wait(2000);
        expect(notesStatus()).toBe('已保存');
        expect(notesField()?.value).toBe('第三节');
      });

      it('holds a finished card exactly as it was, with nothing folding, until its moment ends', async () => {
        const [a, b] = [task('a'), task('b')];
        const test = harness([a, b]);
        await test.render();
        await click('开始 a');
        await writeNext('写小标题');
        await typeNotes('第三节先写结论');
        await click('完成 a');
        expect(test.onSaveTaskNotes).toHaveBeenCalledExactlyOnceWith('a', '第三节先写结论');
        test.setCelebration(celebrationFor('a'));
        await test.render();
        expect(card()?.querySelector('[data-task-id="a"]')?.classList).toContain('is-completing');

        // The refreshed list no longer has the row. The card does not change at all.
        test.setOverview(
          buildHomeTaskOverview([{ ...a, notes: '第三节先写结论' }, b], [doneOn('a')], [], today),
        );
        await test.render();
        const ghost = card()?.querySelector('.home-task-ghost');
        expect(ghost?.hasAttribute('inert')).toBe(true);
        expect(ghost?.getAttribute('aria-hidden')).toBe('true');
        expect(ghost?.querySelector('.home-task-check-mark')).not.toBeNull();
        expect(ghost?.querySelector('[aria-label="先放下 a"]')).not.toBeNull();
        expect(container.querySelector('.home-working-fields')?.hasAttribute('inert')).toBe(true);
        expect(nextLine()?.textContent).toBe('下一步：写小标题');
        expect(notesField()?.value).toBe('第三节先写结论');
        expect(visibleRows()).toEqual([]);
        expect(container.querySelector('.home-working-rest-toggle')?.textContent).toContain(
          '今天还有 1 项',
        );

        // No fold on any clock: it leaves when the celebration does.
        await wait(TASK_CELEBRATION_MS.rowHold + TASK_CELEBRATION_MS.rowCollapse);
        expect(card()?.querySelector('.home-task-ghost')).toBe(ghost);
        expect(container.querySelector('.is-collapsing')).toBeNull();

        test.setCelebration(null);
        await test.render();
        expect(card()).toBeNull();
        expect(container.querySelector('.home-task-ghost')).toBeNull();
        expect(container.querySelector('.home-working-rest-toggle')).toBeNull();
        // The rest is back, and the finished row is in 今天已完成.
        expect(visibleRows()).toEqual(['b', 'a']);
      });

      it('never shows the finished row beside the next card', async () => {
        const [a, b] = [task('a'), task('b')];
        const test = harness([a, b]);
        await test.render();
        await click('开始 a');
        await openList();
        await click('完成 a');
        test.setCelebration(celebrationFor('a'));
        await test.render();
        test.setOverview(buildHomeTaskOverview([a, b], [doneOn('a')], [], today));
        await test.render();
        expect(card()?.querySelector('.home-task-ghost')).not.toBeNull();
        await click('开始 b');
        expect(card()?.querySelector('.home-task-ghost')).toBeNull();
        expect(card()?.querySelectorAll('.home-task-list > li')).toHaveLength(1);
        expect(card()?.textContent).toContain('b');
      });
    });
  });
});
