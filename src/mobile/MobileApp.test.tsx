import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileOutboxEntry, MobileState } from '../database/mobile-repository';
import type { DailyTask } from '../models/daily-task';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { MobileApp, pendingEstimate, type MobileAppServices } from './MobileApp';
import { MobileSyncError, type MobileSyncSummary } from './sync-client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date('2026-10-13T23:30:00Z');
const clock = () => now;
function task(id = 'task-1', title = '读书'): DailyTask {
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
  };
}
function initial(): MobileState {
  return {
    epoch: 'epoch-1',
    snapshot: {
      version: 2,
      sequence: 1,
      taskSkips: [],
      epoch: 'epoch-1',
      generatedAt: now.toISOString(),
      timeZone: 'Asia/Shanghai',
      tasks: [{ task: task(), revision: 'rev-1' }],
      completions: [],
      occurrences: [],
      wallet: { ...structuredClone(DEFAULT_ALLOWANCE), balance: 12 },
    },
    outbox: [],
    archives: [],
  };
}
function completion(id: string, taskId = 'task-1'): MobileOutboxEntry {
  return {
    id,
    epoch: 'epoch-1',
    operation: {
      id,
      kind: 'complete-task',
      at: now.toISOString(),
      date: '2026-10-14',
      timeZone: 'Asia/Shanghai',
      taskId,
      taskRevision: 'rev-1',
      occurrenceRevision: null,
    },
    attempted: false,
    status: 'pending',
    receipt: null,
    sequence: 1,
  };
}

function spendEntry(id: string, amount: number): MobileOutboxEntry {
  return {
    ...completion(id),
    operation: { id, kind: 'spend-allowance', at: now.toISOString(), amount, note: '咖啡' },
  };
}

describe('mobile tasks and confirmed allowance UI', () => {
  let container: HTMLDivElement;
  let root: Root;
  let data: MobileState;
  let services: MobileAppServices;
  let confirmAction: ReturnType<typeof vi.fn<(message: string) => boolean>>;

  beforeEach(() => {
    installDraftMemoryPort();
    vi.useFakeTimers();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    data = initial();
    confirmAction = vi.fn(() => true);
    services = {
      repository: {
        load: vi.fn(async () => structuredClone(data)),
        createTask: vi.fn(async (draft) => {
          const createId = 'create-' + (data.outbox.length + 1);
          const entry: MobileOutboxEntry = {
            id: createId,
            epoch: 'epoch-1',
            attempted: false,
            status: 'pending',
            receipt: null,
            sequence: 2,
            operation: {
              id: createId,
              kind: 'create-task',
              at: now.toISOString(),
              task: {
                ...task('new-task-' + createId, draft.title),
                notes: draft.notes ?? null,
                recurrence: draft.recurrence,
                selectedWeekdays: draft.selectedWeekdays ?? [],
                scheduledDate: draft.scheduledDate ?? null,
                scheduledTime: draft.scheduledTime ?? null,
                priority: draft.priority ?? 'normal',
              },
            },
          };
          data.outbox.push(entry);
          return entry;
        }),
        enqueueCompletion: vi.fn(async (id) => {
          const entry = completion('complete-1', id);
          data.outbox.push(entry);
          return entry;
        }),
        enqueueTaskAction: vi.fn(async (action, taskId, date) => {
          if (action === 'undo-task') {
            data.outbox = data.outbox.filter(
              (entry) =>
                !(
                  entry.operation.kind === 'complete-task' &&
                  entry.operation.taskId === taskId &&
                  !entry.attempted
                ),
            );
          }
          const id = 'action-' + data.outbox.length;
          const current = data.snapshot?.tasks.find((row) => row.task.id === taskId);
          const entry: MobileOutboxEntry = {
            ...completion(id, taskId),
            sequence: data.outbox.length + 2,
            operation: {
              id,
              kind:
                action === 'cancel-task'
                  ? current?.task.recurrence === 'specific_date'
                    ? 'archive-task'
                    : 'skip-task'
                  : action,
              at: now.toISOString(),
              taskId,
              date: '2026-10-14',
              occurrenceDate: date ?? '2026-10-14',
              timeZone: 'Asia/Shanghai',
              taskRevision: 'rev-1',
              occurrenceRevision: null,
            },
            ...(action === 'undo-task' ? { reservedAmount: 5 } : {}),
          };
          data.outbox.push(entry);
          return entry;
        }),
        enqueueSpend: vi.fn(async (amount, note) => {
          const entry: MobileOutboxEntry = {
            id: 'spend-' + data.outbox.length,
            epoch: 'epoch-1',
            attempted: false,
            status: 'pending',
            receipt: null,
            sequence: data.outbox.length + 1,
            operation: {
              id: 'spend-' + data.outbox.length,
              kind: 'spend-allowance',
              at: now.toISOString(),
              amount,
              note: note ?? '',
            },
          };
          data.outbox.push(entry);
          return entry;
        }),
        cancelNeverSent: vi.fn(async (id) => {
          data.outbox = data.outbox.filter((entry) => entry.id !== id);
          return true;
        }),
        acceptNewEpoch: vi.fn(async (epoch) => {
          data.epoch = epoch;
          data.snapshot = null;
          data.outbox = data.outbox.map((entry) => ({ ...entry, status: 'isolated' }));
        }),
      },
      client: {
        sync: vi.fn(async () => ({
          state: structuredClone(data),
          pushed: 0,
          remaining: 0,
          conflicts: 0,
          snapshotUpdated: true,
        })),
      },
      native: vi.fn(async () => ({ paired: true, deviceId: 'phone', epoch: 'epoch-1' })),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  async function render(viewClock = clock) {
    await act(async () =>
      root.render(
        <MobileApp services={services} clock={viewClock} confirmAction={confirmAction} />,
      ),
    );
  }
  function button(text: string) {
    const value = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text || element.getAttribute('aria-label') === text,
    );
    if (!value) throw new Error(`Missing button ${text}`);
    return value;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
    await act(async () => vi.advanceTimersByTimeAsync(10));
  }
  async function fill(label: string, value: string, scope: ParentNode = container) {
    if (label === '任务标题' && window.location.hash !== '#add-task') await click('添加任务');
    const parent = [...scope.querySelectorAll('label')].find(
      (element) => element.firstChild?.textContent === label,
    );
    const input = parent?.querySelector('input,textarea,select');
    if (!(
      input instanceof HTMLInputElement ||
      input instanceof HTMLTextAreaElement ||
      input instanceof HTMLSelectElement
    ))
      throw new Error(`Missing input ${label}`);
    let ancestor = input.parentElement;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : input instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(
        new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
      );
    });
  }
  async function submit(selector = 'form') {
    await act(async () =>
      container
        .querySelector(selector)!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
  }

  it('submits from the fixed form toolbar and offers one-click sync on all main pages', async () => {
    await render();
    for (const tab of ['待办', '零花钱', '设置']) {
      await click(tab);
      const before = vi.mocked(services.client.sync).mock.calls.length;
      await click('同步');
      expect(services.client.sync).toHaveBeenCalledTimes(before + 1);
    }
    await click('待办');
    expect(button('立即同步').closest('.mobile-page')?.getAttribute('hidden')).not.toBeNull();
    expect(container.querySelector('.mobile-sync-summary')?.textContent).not.toContain('立即同步');
    await fill('任务标题', '工具栏保存任务');
    expect(container.textContent).toContain('添加 +5 元，完成再 +5 元');
    expect(container.textContent).not.toContain('以电脑确认金额为准');
    const save = button('保存任务');
    expect(save.form?.id).toBe('mobile-add-form');
    expect(save.closest('.mobile-subpage-bar')).not.toBeNull();
    expect(container.querySelectorAll('#mobile-add-form button[type="submit"]')).toHaveLength(0);
    await click('保存任务');
    expect(services.repository.createTask).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#tasks');
    await click('查看同步设置');
    expect(window.location.hash).toBe('#settings');
    expect(document.activeElement?.id).toBe('mobile-connection-heading');
  });

  it('puts the task title before draft recovery and secondary instructions', async () => {
    await render();
    await click('添加任务');
    const form = container.querySelector<HTMLFormElement>('#mobile-add-form')!;
    const input = form.querySelector<HTMLInputElement>('#mobile-task-title')!;
    const entry = form.firstElementChild!;
    expect(form.parentElement?.firstElementChild).toBe(form);
    expect(entry.firstElementChild?.contains(input)).toBe(true);
    expect(input.labels?.[0]?.textContent).toBe('任务标题');
    expect(input.labels?.[0]?.querySelector('.mobile-sr-only')?.textContent).toBe('任务标题');
    expect(form.querySelector('input, textarea, select')).toBe(input);
    for (const secondary of [
      form.querySelector('.mobile-add-draft')!,
      form.querySelector('.mobile-add-options')!,
      form.querySelector('.mobile-advanced')!,
      form.querySelector('.mobile-add-reward')!,
    ]) {
      expect(input.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
    }
    expect(form.lastElementChild?.textContent).toContain('添加 +5 元，完成再 +5 元');
    expect(document.activeElement?.id).toBe('mobile-page-heading');
  });

  it('keeps draft status below the same title input while typing and saving', async () => {
    await render();
    await click('添加任务');
    const form = container.querySelector<HTMLFormElement>('#mobile-add-form')!;
    const input = form.querySelector<HTMLInputElement>('#mobile-task-title')!;
    const entry = form.firstElementChild;
    const draftSlot = form.querySelector('.mobile-add-draft')!;
    expect(draftSlot.childElementCount).toBe(0);
    input.focus();
    await fill('任务标题', '先写要做的事');
    expect(draftSlot.querySelector('[role="status"]')?.textContent).toBe('\u00a0');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(draftSlot.querySelector('[role="status"]')?.textContent).toBe('已存草稿');
    expect(form.firstElementChild).toBe(entry);
    expect(entry?.firstElementChild?.contains(input)).toBe(true);
    expect(form.querySelector('#mobile-task-title')).toBe(input);
    expect(input.compareDocumentPosition(draftSlot) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(input.value).toBe('先写要做的事');
    expect(document.activeElement).toBe(input);
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });

  it('checks quietly without interrupting the draft and stops on native background/offline', async () => {
    const summary = (): MobileSyncSummary => ({
      state: structuredClone(data),
      pushed: 0,
      remaining: 0,
      conflicts: 0,
      snapshotUpdated: false,
      changeProbe: true,
    });
    services.client.sync = vi.fn(async () => ({ ...summary(), snapshotUpdated: true }));
    services.client.changeProbe = true;
    services.client.checkForChanges = vi.fn(async () => summary());
    await render();
    const input = container.querySelector<HTMLInputElement>('input[name="title"]')!;
    await fill('任务标题', '还在输入的想法');
    input.focus();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(services.client.checkForChanges).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('还在输入的想法');
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('.mobile-sync-summary')?.textContent).toContain('已同步');
    expect(container.querySelector('.mobile-sync-summary')?.textContent).not.toContain('正在同步');
    await act(async () => {
      window.dispatchEvent(new Event('valrecall-app-background'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(services.client.checkForChanges).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event('valrecall-app-resume')));
    expect(services.client.checkForChanges).toHaveBeenCalledTimes(2);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(services.client.checkForChanges).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(services.client.checkForChanges).toHaveBeenCalledTimes(3);
    expect(services.client.sync).not.toHaveBeenCalled();
  });

  it('waits after finite failures, then connects to a later desktop with one manual click', async () => {
    let desktopOnline = false;
    const summary = (): MobileSyncSummary => ({
      state: structuredClone(data),
      pushed: 0,
      remaining: 0,
      conflicts: 0,
      snapshotUpdated: true,
      changeProbe: true,
    });
    services.client.sync = vi.fn(async () => {
      if (!desktopOnline) throw new MobileSyncError('UNAVAILABLE', '电脑暂时离线');
      services.client.changeProbe = true;
      return summary();
    });
    services.client.checkForChanges = vi.fn(async () => ({ ...summary(), snapshotUpdated: false }));
    await render();
    await fill('任务标题', '等待电脑时继续输入');
    await act(async () => vi.advanceTimersByTimeAsync(50_000));
    expect(services.client.sync).toHaveBeenCalledTimes(3);
    expect(services.client.changeProbe).toBeUndefined();
    desktopOnline = true;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(services.client.sync).toHaveBeenCalledTimes(3);
    await click('返回');
    await click('同步');
    expect(services.client.sync).toHaveBeenCalledTimes(4);
    expect(container.querySelector('.mobile-sync-summary')?.textContent).toContain('已同步');
    expect(container.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe(
      '等待电脑时继续输入',
    );
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(services.client.checkForChanges).not.toHaveBeenCalled();
    expect(services.client.sync).toHaveBeenCalledTimes(4);
  });

  it('keeps action-required failures visible after local edits and ignores foreground retry', async () => {
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('ACTION_REQUIRED', '电脑身份不一致'));
    await render();
    await click('读书：标记完成');
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mobile-sync-summary')?.textContent).toContain('需要处理');
    expect(container.textContent).toContain('电脑身份不一致');
    expect(button('查看同步设置')).toBeDefined();
    // An automatic sync stays silent, even when it fails; the summary shows it.
    expect(container.querySelector('.mobile-sr-only[role="status"]')?.textContent).toBe('');
  });

  it('reuses desktop time then priority order without mutating the cached task order', async () => {
    data.snapshot!.tasks = [
      { task: task('normal', '普通'), revision: 'r1' },
      { task: { ...task('high', '优先'), priority: 'high' }, revision: 'r2' },
      { task: { ...task('timed', '早晨'), scheduledTime: '08:00' }, revision: 'r3' },
    ];
    await render();
    expect(
      [...container.querySelectorAll('.mobile-task h3')].map((node) => node.textContent),
    ).toEqual(['早晨', '优先', '普通']);
    expect(data.snapshot!.tasks.map(({ task: entry }) => entry.id)).toEqual([
      'normal',
      'high',
      'timed',
    ]);
  });

  it('shows unknown balance and blocks authoring until first complete snapshot', async () => {
    data = { epoch: null, snapshot: null, outbox: [], archives: [] };
    services.client.sync = vi.fn().mockRejectedValue(new MobileSyncError('NOT_PAIRED', '请先配对'));
    await render();
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('—');
    expect(container.querySelector('form fieldset')?.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('先连接电脑。');
    expect(container.textContent).not.toContain('今天还没有安排');
  });

  it('load failures never present zero or erase the recovery path', async () => {
    vi.mocked(services.repository.load).mockRejectedValueOnce(new Error('disk'));
    await render();
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('—');
    expect(services.client.sync).not.toHaveBeenCalled();
    expect(container.textContent).toContain('读取失败，请重试。');
    expect(container.textContent).not.toContain('暂无待确认操作');
    expect(container.querySelector('.mobile-today')?.textContent).not.toContain('先连接电脑');
    await click('零花钱');
    // A failed read shows one retry alert at the top, never a zero balance or an empty list.
    expect(container.querySelector('.mobile-page:not([hidden])')?.textContent).not.toContain(
      '暂无待确认操作',
    );
    await click('重试');
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    expect(container.textContent).not.toContain('读取失败');
    expect(container.querySelector('.mobile-pending-empty')?.textContent).toContain(
      '暂无待确认操作',
    );
  });

  it('separates confirmed balance, pending estimates and acknowledged rewards in the PC timezone', async () => {
    data.outbox = [
      completion('pending'),
      {
        ...completion('ack', 'task-2'),
        attempted: true,
        status: 'acknowledged',
        receipt: { operationId: 'ack', status: 'applied', reward: 2, message: '已确认' },
      },
    ];
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('UNAVAILABLE', '暂时离线'));
    await render();
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    expect(container.textContent).toContain('待入账+7');
    expect(container.textContent).toContain('已确认 · 更新中');
    expect(container.textContent).toContain('10月14日星期三');
    expect(container.textContent).toContain('Asia/Shanghai');
    expect(container.textContent).toContain('暂时离线');
    expect(button('读书：撤销完成').disabled).toBe(false);
    expect(container.querySelector('.mobile-completed')?.textContent).toContain('待同步');
  });

  it('lists today first and puts overdue todos under one label after them', async () => {
    data.snapshot!.tasks.push({
      task: {
        ...task('late', '交作业'),
        kind: 'one_off',
        recurrence: 'specific_date',
        scheduledDate: '2026-10-12',
      },
      revision: 'rev-1',
    });
    await render();
    const today = container.querySelector('.mobile-today')!;
    const first = today.querySelector('.mobile-task-list')!;
    expect(first.textContent).toContain('读书');
    expect(first.textContent).not.toContain('交作业');
    const overdue = today.querySelector('.mobile-overdue')!;
    expect(overdue.querySelector('h3')?.textContent).toContain('逾期');
    expect(overdue.textContent).toContain('交作业');
    expect(first.compareDocumentPosition(overdue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reports a phone completion as an estimate, then the computer confirmation once', async () => {
    await render();
    await click('读书：标记完成');
    const status = () => container.querySelector('.mobile-celebration-status');
    expect(status()?.textContent).toBe('已完成 · 待入账 +5 元');
    expect(status()?.getAttribute('role')).toBe('status');
    expect(container.querySelector('.mobile-feedback .mobile-status')).toBeNull();
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');

    data.outbox = data.outbox.map((entry) =>
      entry.operation.kind === 'complete-task'
        ? {
            ...entry,
            attempted: true,
            status: 'acknowledged' as const,
            receipt: {
              operationId: entry.id,
              status: 'applied' as const,
              reward: 5,
              walletDelta: 5,
              message: '已确认',
            },
          }
        : entry,
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(services.client.sync).toHaveBeenCalled();
    expect(status()?.textContent).toBe('+5 元已到账');
    await act(async () => vi.advanceTimersByTimeAsync(2400));
    expect(status()?.hasAttribute('hidden')).toBe(true);
    await click('同步');
    expect(status()?.hasAttribute('hidden')).toBe(true);
  });

  it('announces a second identical phone completion line again', async () => {
    data.snapshot!.tasks.push({ task: task('task-2', '写作'), revision: 'rev-1' });
    let next = 0;
    vi.mocked(services.repository.enqueueCompletion).mockImplementation(async (id) => {
      next += 1;
      const entry = { ...completion(`complete-${next}`, id), sequence: next };
      data.outbox.push(entry);
      return entry;
    });
    await render();
    await click('读书：标记完成');
    const line = () => container.querySelector('.mobile-celebration-status > span');
    const first = line();
    expect(first?.textContent).toBe('已完成 · 待入账 +5 元');
    await click('写作：标记完成');
    // Same words, new node: the live region announces it and the hide timer restarts.
    expect(line()?.textContent).toBe('已完成 · 待入账 +5 元');
    expect(line()).not.toBe(first);
  });

  it('excludes confirmed occurrences, conflicts and old epochs from estimates', () => {
    data.outbox = [
      completion('one'),
      completion('same-occurrence'),
      { ...completion('old', 'old-task'), epoch: 'old' },
      { ...completion('conflict', 'other'), status: 'conflict' },
    ];
    expect(pendingEstimate(data)).toBe(5);
    data.snapshot!.completions = [
      { id: 'done', taskId: 'task-1', localDate: '2026-10-14', completedAt: now.toISOString() },
    ];
    expect(pendingEstimate(data)).toBe(0);
  });

  it('serializes double completion clicks and shows pending, not an increased balance', async () => {
    let finish!: (value: MobileOutboxEntry) => void;
    vi.mocked(services.repository.enqueueCompletion).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await act(async () => {
      button('读书：标记完成').click();
      button('读书：标记完成').click();
    });
    expect(services.repository.enqueueCompletion).toHaveBeenCalledTimes(1);
    const entry = completion('complete-1');
    data.outbox.push(entry);
    await act(async () => finish(entry));
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    expect(button('读书：撤销完成').disabled).toBe(false);
    expect(container.querySelector('.mobile-completed')?.textContent).toContain('待同步');
    expect(container.textContent).toContain('待入账+5');
  });

  it('keeps the displayed default date in a durable draft across midnight without creating a task', async () => {
    let current = now;
    const advancingClock = () => current;
    await render(advancingClock);
    await click('添加任务');
    await fill('任务标题', '跨午夜草稿');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(container.textContent).toContain('已存草稿');
    await act(async () => root.unmount());
    current = new Date('2026-10-15T23:30:00Z');
    root = createRoot(container);
    await render(advancingClock);
    await click('添加任务');
    await click('继续');
    expect(container.querySelector<HTMLInputElement>('[type="date"]')?.value).toBe('2026-10-14');
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });

  it('retains an unsaved form after failure and saves date/time/priority while keeping spending in a separate form', async () => {
    await render();
    await fill('任务标题', '散步');
    await fill('备注（可选）', '走二十分钟');
    await fill('计划时间（可选）', '19:30');
    await fill('优先级', 'high');
    vi.mocked(services.repository.createTask).mockRejectedValueOnce(new Error('保存失败'));
    await submit();
    expect(container.textContent).toContain('保存失败');
    expect(container.querySelector<HTMLInputElement>('form input')?.value).toBe('散步');
    await submit();
    expect(services.repository.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '散步',
        notes: '走二十分钟',
        scheduledDate: '2026-10-14',
        scheduledTime: '19:30',
        priority: 'high',
      }),
      now,
      expect.objectContaining({ id: expect.any(String), epoch: 'epoch-1' }),
    );
    expect(container.querySelector<HTMLInputElement>('form input')?.value).toBe('');
    expect(container.querySelectorAll('button')).not.toContainEqual(
      expect.objectContaining({ textContent: '消费' }),
    );
  });

  it('requires weekdays for selected-weekday tasks', async () => {
    await render();
    await fill('任务标题', '锻炼');
    await fill('重复安排', 'selected_weekdays');
    await submit();
    expect(container.textContent).toContain('请至少选择一个星期');
    expect(services.repository.createTask).not.toHaveBeenCalled();
    await act(async () =>
      (container.querySelector('.mobile-weekdays input') as HTMLInputElement).click(),
    );
    await submit();
    expect(services.repository.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrence: 'selected_weekdays',
        selectedWeekdays: [1],
        scheduledDate: null,
      }),
      now,
      expect.objectContaining({ id: expect.any(String), epoch: 'epoch-1' }),
    );
  });

  it('offers direct undo for both unsent and attempted completions', async () => {
    data.outbox = [completion('new'), { ...completion('attempted', 'other'), attempted: true }];
    await render();
    expect(container.textContent).not.toContain('取消待扣款');
    confirmAction.mockReturnValueOnce(false);
    await click('读书：撤销完成');
    expect(services.repository.enqueueTaskAction).not.toHaveBeenCalled();
    await click('读书：撤销完成');
    expect(services.repository.enqueueTaskAction).toHaveBeenCalledWith(
      'undo-task',
      'task-1',
      '2026-10-14',
      now,
    );
    expect(container.textContent).toContain('已发送');
  });

  it('sends pairing text only to native and clears it after pairing', async () => {
    await render();
    await click('设置');
    await fill('电脑显示的配对文字', '{"secret":"synthetic-test-only"}');
    await click('使用配对文字');
    expect(services.native).toHaveBeenCalledWith('pair.import', {
      qr: '{"secret":"synthetic-test-only"}',
    });
    expect(container.querySelector('textarea[autocomplete="off"]')?.textContent).toBe('');
    expect(
      (container.querySelector('textarea[autocomplete="off"]') as HTMLTextAreaElement).value,
    ).toBe('');
    expect(services.client.sync).toHaveBeenCalledTimes(2);
  });

  it('requires explicit epoch acceptance, preserving old operations before the next sync', async () => {
    data.outbox = [completion('old')];
    vi.mocked(services.client.sync).mockRejectedValueOnce(
      new MobileSyncError('EPOCH_CHANGED', '电脑恢复过数据', 'epoch-2'),
    );
    await render();
    expect(button('立即同步').disabled).toBe(true);
    expect(container.querySelector('form fieldset')?.hasAttribute('disabled')).toBe(true);
    confirmAction.mockReturnValueOnce(false);
    await click('接收新数据');
    expect(services.repository.acceptNewEpoch).not.toHaveBeenCalled();
    await click('接收新数据');
    expect(services.repository.acceptNewEpoch).toHaveBeenCalledWith('epoch-2');
    expect(services.client.sync).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('旧版本记录');
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('—');
  });

  it('requires re-pairing when the changed epoch is not known', async () => {
    vi.mocked(services.client.sync).mockRejectedValueOnce(
      new MobileSyncError('EPOCH_CHANGED', '请重新配对'),
    );
    await render();
    expect(container.textContent).toContain('请先重新扫描电脑配对码');
    expect(container.textContent).not.toContain('接收新数据');
    await click('设置');
    await click('扫描电脑二维码');
    expect(services.native).toHaveBeenCalledWith('pair.scan', {});
    expect(services.client.sync).toHaveBeenCalledTimes(2);
  });

  it('keeps conflict and isolated inspection visible without awarding or retrying them', async () => {
    data.outbox = [
      {
        ...completion('conflict'),
        status: 'conflict',
        attempted: true,
        receipt: {
          operationId: 'conflict',
          status: 'conflict',
          reward: 0,
          message: '电脑已修改任务',
        },
      },
      { ...completion('isolated'), epoch: 'old', status: 'isolated' },
    ];
    await render();
    expect(container.textContent).toContain('电脑已修改任务');
    expect(container.textContent).toContain('请在电脑核对。');
    expect(container.textContent).toContain('旧版本记录');
    expect(pendingEstimate(data)).toBe(0);
    expect(container.querySelector('.mobile-amount-list')).toBeNull();
    expect(container.querySelector('.mobile-pending-empty')?.textContent).toContain(
      '暂无待确认操作',
    );
  });

  it('resolves isolated unsynced task names and keeps old snapshot inspection', async () => {
    const oldTask = task('never-synced-task', '原先手机新增的散步');
    data.outbox = [
      {
        ...completion('old-create'),
        epoch: 'old-epoch',
        status: 'isolated',
        operation: { id: 'old-create', kind: 'create-task', at: now.toISOString(), task: oldTask },
      },
      { ...completion('old-complete', oldTask.id), epoch: 'old-epoch', status: 'isolated' },
    ];
    data.archives = [
      {
        id: 'archive',
        epoch: 'old-epoch',
        archivedAt: now.toISOString(),
        snapshot: { ...initial().snapshot!, epoch: 'old-epoch' },
      },
    ];
    await render();
    const summaries = [...container.querySelectorAll('summary')].map((entry) => entry.textContent);
    expect(summaries).toContain('旧版本记录 · 完成 原先手机新增的散步');
    expect(container.textContent).toContain('旧记录存档');
    expect(container.textContent).toContain('当时余额：12');
    expect(container.textContent).not.toContain('取消待扣款');
  });

  it('refreshes the computer-calendar day without network polling and ignores hidden events', async () => {
    let date = now;
    const viewClock = () => date;
    data.snapshot!.tasks[0]!.task = {
      ...task(),
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-14',
    };
    await render(viewClock);
    expect(button('读书：标记完成').disabled).toBe(false);
    date = new Date('2026-10-14T16:10:00Z');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(container.textContent).toContain('10月15日星期四');
    expect(button('读书：标记完成').disabled).toBe(false);
    expect(container.querySelector('.mobile-today')?.textContent).toContain('逾期');
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('valrecall-network-ready'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(services.client.sync).toHaveBeenCalledTimes(2);
  });

  it('keeps the finite event fallback for a known legacy desktop', async () => {
    services.client.changeProbe = false;
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('UNAVAILABLE', '电脑离线'));
    await render();
    await act(async () => {
      for (let index = 0; index < 10; index++)
        window.dispatchEvent(new Event('valrecall-network-ready'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(services.client.sync).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(services.client.sync).toHaveBeenCalledTimes(3);
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(services.client.sync).toHaveBeenCalledTimes(4);
  });

  it('retains concurrent local work when an older in-flight sync summary finishes', async () => {
    let finish!: () => void;
    const old = structuredClone(data);
    services.client.sync = vi.fn(
      () =>
        new Promise<MobileSyncSummary>((resolve) => {
          finish = () =>
            resolve({ state: old, pushed: 0, remaining: 0, conflicts: 0, snapshotUpdated: true });
        }),
    );
    await render();
    await click('读书：标记完成');
    await act(async () => finish());
    expect(button('读书：撤销完成').disabled).toBe(false);
    expect(container.querySelector('.mobile-completed')?.textContent).toContain('待同步');
    expect(container.textContent).toContain('待入账+5');
  });

  it('shows only tasks at launch, with separate hidden forms and wallet, and collapsed history', async () => {
    data.snapshot!.tasks.push({ task: task('done', '已经做完'), revision: 'done-rev' });
    data.snapshot!.completions.push({
      id: 'done-completion',
      taskId: 'done',
      localDate: '2026-10-14',
      completedAt: now.toISOString(),
    });
    await render();
    const taskNode = container.querySelector('.mobile-today')!;
    expect(container.querySelector('.mobile-advanced')?.closest('[hidden]')).not.toBeNull();
    expect(taskNode.compareDocumentPosition(container.querySelector('.mobile-wallet')!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.querySelector<HTMLDetailsElement>('.mobile-completed')?.open).toBe(false);
    expect(container.querySelector('.mobile-settings')?.closest('[hidden]')).not.toBeNull();
    expect(container.querySelector<HTMLDetailsElement>('.mobile-advanced')?.open).toBe(false);
    expect(button('已经做完：撤销完成').disabled).toBe(false);
    expect(button('读书：标记完成').disabled).toBe(false);
  });

  it('quick add defaults to today once and resets successful advanced choices', async () => {
    await render();
    await fill('任务标题', '今天的小事');
    await submit();
    expect(services.repository.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ recurrence: 'specific_date', scheduledDate: '2026-10-14' }),
      now,
      expect.objectContaining({ id: expect.any(String), epoch: 'epoch-1' }),
    );
    await fill('任务标题', '每日锻炼');
    await fill('重复安排', 'daily');
    await submit();
    expect(services.repository.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ recurrence: 'daily', scheduledDate: null }),
      now,
      expect.objectContaining({ id: expect.any(String), epoch: 'epoch-1' }),
    );
    expect(container.querySelector<HTMLSelectElement>('.mobile-add-options select')?.value).toBe(
      'specific_date',
    );
  });

  it('keeps zero pending money compact and reveals only real queued amounts', async () => {
    await render();
    await click('零花钱');
    expect(container.querySelector('.mobile-pending-empty')?.textContent).toContain(
      '暂无待确认操作',
    );
    expect(container.querySelector('.mobile-amount-list')).toBeNull();
    expect(container.querySelector('.mobile-balance-explanation')).toBeNull();
    await click('待办');
    await click('读书：标记完成');
    await click('零花钱');
    expect(container.querySelector('.mobile-pending-empty')).toBeNull();
    expect(container.querySelector('.mobile-amount-list')?.textContent).toContain('待入账+5 元');
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    await click('查看记录');
    expect(document.activeElement?.id).toBe('mobile-records-heading');
  });

  it('keeps connection details optional and the spend toolbar tied to its form', async () => {
    await render();
    await click('设置');
    expect(container.querySelector<HTMLDetailsElement>('.mobile-connection-details')?.open).toBe(
      false,
    );
    expect(container.querySelector<HTMLDetailsElement>('.mobile-pairing')?.open).toBe(false);
    expect(container.querySelector('.mobile-connection-details')?.textContent).toContain(
      '上次同步：',
    );
    await click('零花钱');
    await click('记一笔扣款');
    await fill('金额（元）', '4', container.querySelector('.mobile-spend-form')!);
    expect(button('确认扣除').form?.id).toBe('mobile-spend-form');
    await click('确认扣除');
    expect(services.repository.enqueueSpend).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#wallet');
    expect(document.activeElement?.id).toBe('mobile-wallet-balance');
  });

  it('confirms offline spending and keeps the confirmed balance unchanged', async () => {
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    const form = container.querySelector('.mobile-spend-form')!;
    await fill('金额（元）', '4', form);
    await fill('备注（可选）', '茶', form);
    confirmAction.mockReturnValueOnce(false);
    await submit('.mobile-spend-form');
    expect(services.repository.enqueueSpend).not.toHaveBeenCalled();
    expect(form.querySelector<HTMLInputElement>('input')?.value).toBe('4');
    await submit('.mobile-spend-form');
    expect(services.repository.enqueueSpend).toHaveBeenCalledWith(
      4,
      '茶',
      now,
      expect.objectContaining({ id: expect.any(String), epoch: 'epoch-1' }),
    );
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    expect(container.textContent).toContain('待扣款−4 元');
    expect(confirmAction).toHaveBeenLastCalledWith('确认扣除 4 元？');
    expect(container.querySelector('.mobile-spend-form')?.closest('[hidden]')).not.toBeNull();
    await click('零花钱');
    await click('记一笔扣款');
    expect(container.querySelector<HTMLInputElement>('.mobile-spend-form input')?.value).toBe('');
    expect(container.querySelector<HTMLInputElement>('.mobile-spend-form input')?.max).toBe('8');
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])(
    'rejects invalid spending amount %s without queuing',
    async (amount) => {
      await render();
      await click('零花钱');
      await click('记一笔扣款');
      await fill('金额（元）', amount, container.querySelector('.mobile-spend-form')!);
      await submit('.mobile-spend-form');
      expect(container.textContent).toContain('请输入大于 0 的整数金额');
      expect(services.repository.enqueueSpend).not.toHaveBeenCalled();
      expect(confirmAction).not.toHaveBeenCalled();
    },
  );

  it('retains spending input when the repository rejects insufficient balance', async () => {
    vi.mocked(services.repository.enqueueSpend).mockRejectedValueOnce(
      new Error('余额不足，请先同步。'),
    );
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    const form = container.querySelector('.mobile-spend-form')!;
    await fill('金额（元）', '9', form);
    await fill('备注（可选）', '保留这条说明', form);
    await submit('.mobile-spend-form');
    expect(container.textContent).toContain('余额不足，请先同步。');
    expect([...form.querySelectorAll('input')].map((input) => input.value)).toEqual([
      '9',
      '保留这条说明',
    ]);
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
    expect(data.outbox).toEqual([]);
  });

  it('locks repeated spend submissions before a second confirmation can occur', async () => {
    let finish!: (entry: MobileOutboxEntry) => void;
    vi.mocked(services.repository.enqueueSpend).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    await fill('金额（元）', '3', container.querySelector('.mobile-spend-form')!);
    await submit('.mobile-spend-form');
    await submit('.mobile-spend-form');
    expect(services.repository.enqueueSpend).toHaveBeenCalledTimes(1);
    expect(confirmAction).toHaveBeenCalledTimes(1);
    const entry = spendEntry('spend-once', 3);
    data.outbox.push(entry);
    await act(async () => finish(entry));
    expect(container.textContent).toContain('待扣款−3 元');
  });

  it('excludes estimates and rejected or isolated spends from spendable cached funds', async () => {
    data.outbox = [
      completion('earn-estimate'),
      spendEntry('pending', 4),
      {
        ...spendEntry('ack', 3),
        status: 'acknowledged',
        attempted: true,
        receipt: { operationId: 'ack', status: 'applied', reward: 0, message: '已扣款' },
      },
      {
        ...spendEntry('conflict', 100),
        status: 'conflict',
        attempted: true,
        receipt: { operationId: 'conflict', status: 'conflict', reward: 0, message: '余额不足' },
      },
      { ...spendEntry('isolated', 200), status: 'isolated', epoch: 'old' },
    ];
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    expect(container.querySelector<HTMLInputElement>('.mobile-spend-form input')?.max).toBe('5');
    expect(container.textContent).toContain('待入账+5 元待扣款−7 元');
    expect(container.textContent).toContain('已确认 · 更新中');
    await click('返回');
    expect(container.textContent).toContain('2 条记录需要核对');
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
  });

  it('only offers cancellation for never-attempted spending and confirms that cancellation', async () => {
    data.outbox = [spendEntry('not-sent', 2), { ...spendEntry('attempted', 3), attempted: true }];
    await render();
    expect(
      [...container.querySelectorAll('button')].filter(
        (element) => element.textContent === '取消待扣款',
      ),
    ).toHaveLength(1);
    await click('取消待扣款');
    expect(confirmAction).toHaveBeenCalledWith('取消这笔扣款？');
    expect(services.repository.cancelNeverSent).toHaveBeenCalledWith('not-sent');
    expect(container.textContent).toContain('待扣款−3 元');
    expect(container.textContent).not.toContain('取消待扣款');
  });

  it('keeps a cached offline error visible but out of the task-first area', async () => {
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('UNAVAILABLE', '电脑离线，记录已保留。'));
    await render();
    const offline = container.querySelector('.mobile-sync-detail')!;
    expect(offline.textContent).toContain('电脑离线，记录已保留。');
    expect(offline.closest('.mobile-sync-summary')).not.toBeNull();
    expect(container.querySelector('.mobile-today')!.compareDocumentPosition(offline)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(container.querySelector('.mobile-error')).toBeNull();
    expect(button('读书：标记完成').disabled).toBe(false);
  });

  it('keeps overdue and future one-offs discoverable, with confirmed cancellation at the row', async () => {
    data.snapshot!.tasks = ['2026-10-10', '2026-10-20'].map((date, i) => ({
      task: {
        ...task('once-' + i, i ? '以后做' : '昨天没做'),
        kind: 'one_off',
        recurrence: 'specific_date',
        scheduledDate: date,
      },
      revision: 'rev-1',
    }));
    await render();
    expect(button('昨天没做：标记完成').disabled).toBe(false);
    expect(container.querySelector<HTMLDetailsElement>('.mobile-future')?.open).toBe(false);
    expect(container.querySelector('.mobile-future')?.textContent).toContain('以后做');
    confirmAction.mockReturnValueOnce(false);
    await click('以后做：不做了');
    expect(services.repository.enqueueTaskAction).not.toHaveBeenCalled();
    await click('以后做：不做了');
    expect(services.repository.enqueueTaskAction).toHaveBeenCalledWith(
      'cancel-task',
      'once-1',
      '2026-10-20',
      now,
    );
    expect(container.querySelector('.mobile-future .mobile-task')).toBeNull();
    expect(data.outbox.at(-1)?.operation.kind).toBe('archive-task');
  });

  it('returns to and focuses a newly created future task with its group expanded', async () => {
    await render();
    await fill('任务标题', '下周再做');
    await fill('日期', '2026-10-20');
    await submit();
    expect(window.location.hash).toBe('#tasks');
    expect(document.activeElement?.id).toBe('mobile-task-new-task-create-1');
    expect(container.querySelector<HTMLDetailsElement>('.mobile-future')?.open).toBe(true);
    expect(container.querySelector('.mobile-future')?.textContent).toContain('下周再做');
    // No lone link is left above the list: the tasks feedback area stays empty and hidden.
    expect(container.textContent).not.toContain('查看「之后」');
    const feedback = container.querySelector('.mobile-page:not([hidden]) > .mobile-feedback');
    expect(feedback === null || feedback.childElementCount === 0).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.textContent).not.toContain('查看「之后」');
  });

  it('skips and restores a recurring task without stopping the recurring definition', async () => {
    await render();
    await click('读书：今天不做');
    expect(container.querySelector('.mobile-skipped')?.textContent).toContain('读书');
    expect(container.querySelector<HTMLDetailsElement>('.mobile-skipped')?.open).toBe(false);
    expect(confirmAction).not.toHaveBeenCalled();
    await click('读书：恢复今天');
    expect(button('读书：标记完成').disabled).toBe(false);
    expect(container.querySelector('.mobile-skipped .mobile-task')).toBeNull();
    expect(data.snapshot!.tasks[0]!.task.recurrence).toBe('daily');
  });

  it('paginates retained history by completion time and reverses the original historical reward', async () => {
    data.snapshot!.tasks = Array.from({ length: 65 }, (_, i) => ({
      task: task('history-' + i, '历史' + i),
      revision: 'r',
    }));
    data.snapshot!.completions = data.snapshot!.tasks.map(({ task }, i) => ({
      id: 'c-' + i,
      taskId: task.id,
      localDate: '2026-10-01',
      completedAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    }));
    data.snapshot!.occurrences = data.snapshot!.tasks.map(({ task }) => ({
      taskId: task.id,
      date: '2026-10-01',
      revision: 'c',
      rewardAmount: 2,
    }));
    await render();
    expect(container.querySelector('.mobile-completed li')).toBeNull();
    await click('查看完成历史');
    const history = container.querySelector('.mobile-history')!;
    expect(history.querySelectorAll(':scope > details')).toHaveLength(30);
    expect(history.querySelector('strong')?.textContent).toBe('历史64');
    expect(history.querySelector('li')).toBeNull();
    await click('加载更多任务');
    expect(history.querySelectorAll(':scope > details')).toHaveLength(60);
    await click('加载更多任务');
    expect(history.querySelectorAll(':scope > details')).toHaveLength(65);
    await act(async () => {
      history.querySelector<HTMLDetailsElement>('details')!.open = true;
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(history.querySelectorAll('li')).toHaveLength(1);
    await click('历史64：撤销完成');
    expect(confirmAction).toHaveBeenLastCalledWith('撤销完成并扣回 2 元？');
    expect(services.repository.enqueueTaskAction).toHaveBeenCalledWith(
      'undo-task',
      'history-64',
      '2026-10-01',
      now,
    );
    expect(data.snapshot!.completions).toHaveLength(65);
    expect(document.activeElement?.id).toBe('mobile-page-heading');
  });

  it('keeps grouped history expansion, row pagination and return focus without extra sync', async () => {
    data.snapshot!.completions = Array.from({ length: 35 }, (_, i) => ({
      id: 'day-' + i,
      taskId: 'task-1',
      localDate: new Date(Date.UTC(2026, 8, i + 1)).toISOString().slice(0, 10),
      completedAt: new Date(Date.UTC(2026, 8, i + 1, 10)).toISOString(),
    }));
    await render();
    await click('查看完成历史');
    expect(window.location.hash).toBe('#task-history');
    expect(container.querySelector('.mobile-subpage-bar button[type="submit"]')).toBeNull();
    expect(container.querySelector('nav')?.hasAttribute('hidden')).toBe(true);
    const group = container.querySelector<HTMLDetailsElement>('.mobile-history > details')!;
    await act(async () => {
      group.open = true;
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(group.querySelectorAll('li')).toHaveLength(30);
    await click('加载更多完成记录');
    expect(group.querySelectorAll('li')).toHaveLength(35);
    await click('返回');
    expect(document.activeElement?.id).toBe('mobile-open-history');
    await click('查看完成历史');
    expect(group.open).toBe(true);
    expect(group.querySelectorAll('li')).toHaveLength(35);
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    expect(new Set([...container.querySelectorAll('[id]')].map((node) => node.id)).size).toBe(
      container.querySelectorAll('[id]').length,
    );
  });

  it('shows overdue completions today and preserves unknown rewards and failed undo in history', async () => {
    data.snapshot!.tasks[0]!.task = {
      ...task(),
      recurrence: 'specific_date',
      scheduledDate: '2026-10-01',
    };
    data.snapshot!.completions = [
      { id: 'old', taskId: 'task-1', localDate: '2026-10-01', completedAt: now.toISOString() },
    ];
    await render();
    expect(container.querySelector('.mobile-completed')?.textContent).toContain('今天已完成1');
    expect(container.querySelector('.mobile-progress-totals')?.textContent).toContain(
      '今天完成1次',
    );
    expect(container.querySelector('.mobile-progress-chart')?.children).toHaveLength(7);
    await click('查看完成历史');
    const group = container.querySelector<HTMLDetailsElement>('.mobile-history > details')!;
    await act(async () => {
      group.open = true;
      await vi.advanceTimersByTimeAsync(10);
    });
    // An unknown historical amount is never shown as money.
    expect(group.textContent).toContain('已确认');
    expect(group.textContent).not.toContain('+0 元');
    vi.mocked(services.repository.enqueueTaskAction).mockRejectedValueOnce(
      new Error('撤销未保存，请重试'),
    );
    const undo = group.querySelector<HTMLButtonElement>('button[aria-label="读书：撤销完成"]')!;
    await act(async () => undo.click());
    expect(confirmAction).toHaveBeenLastCalledWith('撤销这次完成？余额不变。');
    expect(container.querySelector('#mobile-history-page [role="alert"]')?.textContent).toContain(
      '撤销未保存',
    );
    expect(group.querySelectorAll('li')).toHaveLength(1);
    expect(window.location.hash).toBe('#task-history');
  });

  it('prevents double manual submission and never periodically submits afterward', async () => {
    await render();
    let finish!: () => void;
    vi.mocked(services.client.sync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              state: structuredClone(data),
              pushed: 0,
              remaining: 0,
              conflicts: 0,
              snapshotUpdated: true,
            });
        }),
    );
    const sync = button('同步');
    await act(async () => {
      sync.click();
      sync.click();
    });
    expect(sync.disabled).toBe(true);
    expect(sync.textContent).toBe('正在同步…');
    expect(services.client.sync).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    await act(async () => vi.advanceTimersByTimeAsync(600_000));
    expect(services.client.sync).toHaveBeenCalledTimes(2);
  });

  it('shows signed balances, reserves pending undo and disables spending from debt', async () => {
    data.snapshot!.wallet.balance = -3;
    await render();
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('-3');
    expect(button('记一笔扣款').disabled).toBe(true);
    expect(container.textContent).not.toContain('不会实际转账');
    expect(container.textContent).not.toContain('以电脑核对为准');
    expect(container.textContent).not.toContain('不保证后台同步');
  });

  it('expands long notes and automatically syncs a short burst of saved work', async () => {
    data.snapshot!.tasks[0]!.task.notes = '很长的备注\n'.repeat(30);
    await render();
    expect(button('展开备注').getAttribute('aria-expanded')).toBe('false');
    await click('展开备注');
    expect(button('收起备注').classList.contains('is-expanded')).toBe(true);
    await click('读书：标记完成');
    expect(container.querySelector('.mobile-completed')?.textContent).toContain('读书');
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(services.client.sync).toHaveBeenCalledTimes(2);
  });

  it('uses one alternate-tab history entry and returns from spend to wallet then tasks', async () => {
    await render();
    expect(window.location.hash).toBe('#tasks');
    const push = vi.spyOn(window.history, 'pushState');
    await click('零花钱');
    const length = window.history.length;
    for (let i = 0; i < 5; i++) {
      await click('零花钱');
      await click('设置');
    }
    expect(window.history.length).toBe(length);
    expect(push).toHaveBeenCalledTimes(1);
    await click('零花钱');
    await click('记一笔扣款');
    expect(container.querySelector('.mobile-bottom-nav')?.hasAttribute('hidden')).toBe(true);
    await fill('金额（元）', '3', container.querySelector('.mobile-spend-form')!);
    await click('返回');
    expect(window.location.hash).toBe('#wallet');
    await act(async () => {
      window.history.back();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(window.location.hash).toBe('#tasks');
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    await click('零花钱');
    await click('记一笔扣款');
    expect(container.querySelector<HTMLInputElement>('[name="amount"]')?.value).toBe('3');
    expect(document.activeElement?.tagName).not.toMatch(/INPUT|TEXTAREA/);
    expect(window.location.search).toBe('');
  });

  it('retains drafts, expansion, history count and per-tab scroll without focusing an input', async () => {
    await render();
    await fill('任务标题', '还没写完');
    await fill('备注（可选）', '原先备注');
    await click('返回');
    const future = container.querySelector<HTMLDetailsElement>('.mobile-future')!;
    future.open = true;
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(380);
    await click('零花钱');
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(180);
    await click('待办');
    expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 380, behavior: 'instant' });
    expect(future.open).toBe(true);
    await click('添加任务');
    expect(container.querySelector<HTMLInputElement>('[name="title"]')?.value).toBe('还没写完');
    expect(container.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value).toBe('原先备注');
    expect(container.querySelector<HTMLDetailsElement>('.mobile-advanced')?.open).toBe(true);
    expect(document.activeElement?.id).toBe('mobile-page-heading');
    confirmAction.mockReturnValueOnce(false);
    await click('放弃草稿');
    expect(window.location.hash).toBe('#add-task');
    expect(services.repository.createTask).not.toHaveBeenCalled();
    await click('放弃草稿');
    expect(window.location.hash).toBe('#tasks');
    await click('添加任务');
    expect(container.querySelector<HTMLInputElement>('[name="title"]')?.value).toBe('');
  });

  it('does not hijack navigation when a task finishes saving after the user leaves', async () => {
    await render();
    const create = services.repository.createTask;
    let finish!: () => void;
    services.repository.createTask = vi.fn(
      (...args: Parameters<typeof create>) =>
        new Promise<MobileOutboxEntry>((resolve) => {
          finish = () => {
            void create(...args).then(resolve);
          };
        }),
    );
    await fill('任务标题', '慢速保存');
    await submit();
    await click('返回');
    await click('零花钱');
    await act(async () => finish());
    expect(window.location.hash).toBe('#wallet');
    expect(container.querySelector('.mobile-page:not([hidden])')?.textContent).not.toContain(
      '已添加',
    );
    await click('待办');
    expect(container.querySelector('.mobile-today')?.textContent).toContain('慢速保存');
    expect(services.repository.createTask).toHaveBeenCalledTimes(1);
  });

  it('keeps late errors with the original form and offers an explicit return and retry', async () => {
    await render();
    let fail!: (reason: Error) => void;
    const create = services.repository.createTask;
    services.repository.createTask = vi.fn(
      () =>
        new Promise<MobileOutboxEntry>((_, reject) => {
          fail = reject;
        }),
    );
    await fill('任务标题', '不能丢的草稿');
    await submit();
    await click('返回');
    await click('设置');
    await act(async () => fail(new Error('磁盘暂时不可写')));
    expect(window.location.hash).toBe('#settings');
    expect(container.querySelector('.mobile-page:not([hidden])')?.textContent).not.toContain(
      '磁盘暂时不可写',
    );
    await click('待办');
    await click('返回任务草稿');
    expect(window.location.hash).toBe('#add-task');
    expect(container.querySelector<HTMLInputElement>('[name="title"]')?.value).toBe('不能丢的草稿');
    services.repository.createTask = create;
    await submit();
    expect(window.location.hash).toBe('#tasks');
    expect(data.outbox.filter((entry) => entry.operation.kind === 'create-task')).toHaveLength(1);
  });

  it('keeps pairing feedback in settings after a previous wallet operation', async () => {
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    await fill('金额（元）', '3', container.querySelector('.mobile-spend-form')!);
    await submit('.mobile-spend-form');
    await click('设置');
    vi.mocked(services.native).mockRejectedValueOnce(new Error('配对码已过期'));
    await click('扫描电脑二维码');
    expect(container.querySelector('.mobile-settings')?.textContent).toContain('配对码已过期');
    await click('零花钱');
    expect(container.querySelector('.mobile-page:not([hidden])')?.textContent).not.toContain(
      '配对码已过期',
    );
    expect(container.querySelector('.mobile-page:not([hidden])')?.textContent).toContain(
      '已记录扣款',
    );
  });

  it('locates the requested settings module and keeps navigation outside the scheduler', async () => {
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('ACTION_REQUIRED', '需要核对电脑身份'));
    await render();
    await click('查看同步设置');
    expect(window.location.hash).toBe('#settings');
    expect(document.activeElement?.id).toBe('mobile-connection-heading');
    await click('零花钱');
    await click('查看记录');
    expect(document.activeElement?.id).toBe('mobile-records-heading');
    expect(window.location.hash).toBe('#settings');
    expect(services.client.sync).toHaveBeenCalledTimes(1);
    expect(services.repository.load).toHaveBeenCalledTimes(2);
  });

  it('preserves loaded history and closes the row menu when leaving the tab', async () => {
    data.snapshot!.tasks = Array.from({ length: 40 }, (_, i) => ({
      task: task('history-' + i, '历史' + i),
      revision: 'r',
    }));
    data.snapshot!.completions = data.snapshot!.tasks.map(({ task }, i) => ({
      id: 'c-' + i,
      taskId: task.id,
      localDate: '2026-10-01',
      completedAt: now.toISOString(),
    }));
    await render();
    const history = container.querySelector<HTMLDetailsElement>('.mobile-completed')!;
    await act(async () => {
      history.open = true;
      await vi.advanceTimersByTimeAsync(10);
    });
    await click('加载更多');
    const menu = container.querySelector<HTMLDetailsElement>('.mobile-task-more')!;
    menu.open = true;
    await click('零花钱');
    await click('待办');
    expect(history.open).toBe(true);
    expect(history.querySelectorAll('li')).toHaveLength(40);
    expect(menu.open).toBe(false);
  });

  it('routes a connection recovery from a subpage without leaving an extra Back entry', async () => {
    await render();
    await click('零花钱');
    await click('记一笔扣款');
    vi.mocked(services.client.sync).mockRejectedValueOnce(
      new MobileSyncError('EPOCH_CHANGED', '配对需要处理'),
    );
    await act(async () => window.dispatchEvent(new Event('valrecall-app-background')));
    await act(async () => window.dispatchEvent(new Event('valrecall-app-resume')));
    await click('打开配对设置');
    expect(window.location.hash).toBe('#settings');
    expect(document.activeElement?.id).toBe('mobile-connection-heading');
    await act(async () => {
      window.history.back();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(window.location.hash).toBe('#tasks');
  });

  /** Live regions a screen reader can hear right now (hidden pages and empty regions are silent). */
  const audibleStatus = () =>
    [...container.querySelectorAll('[role="status"]')].filter(
      (node) => !node.closest('[hidden]') && Boolean(node.textContent?.trim()),
    );
  /** The hidden line that speaks the result of a sync the person asked for. */
  const syncLine = () => container.querySelector('.mobile-sr-only[role="status"]');

  it('reports a saved task once back on #tasks, as an estimate on the floating line only', async () => {
    await render();
    await fill('任务标题', '新的小事');
    await click('保存任务');
    expect(window.location.hash).toBe('#tasks');
    const status = container.querySelector('.mobile-celebration-status')!;
    expect(status.hasAttribute('hidden')).toBe(false);
    expect(status.textContent).toBe('已添加 · 待入账 +5 元');
    // No in-flow notice pushes the list down, and nothing else speaks.
    expect(container.querySelector('.mobile-feedback .mobile-status')).toBeNull();
    expect(container.textContent).not.toContain('已存到手机');
    expect(audibleStatus()).toEqual([status]);
    await act(async () => vi.advanceTimersByTimeAsync(2400));
    expect(status.hasAttribute('hidden')).toBe(true);
    await click('零花钱');
    expect(container.querySelector('.mobile-amount-list')?.textContent).toContain('待入账+5 元');
    expect(container.querySelector('.mobile-balance')?.textContent).toBe('12');
  });

  it('says a saved task is kept on the phone when no creation reward is expected', async () => {
    data.snapshot!.tasks.push({ task: task('new-task-create-1', '电脑已有'), revision: 'r' });
    await render();
    await fill('任务标题', '电脑已有');
    await click('保存任务');
    expect(container.querySelector('.mobile-celebration-status')?.textContent).toBe('已添加');
  });

  it('keeps the top summary still during an automatic sync; a requested sync shows progress', async () => {
    await render();
    let finish!: () => void;
    vi.mocked(services.client.sync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              state: structuredClone(data),
              pushed: 1,
              remaining: 0,
              conflicts: 0,
              snapshotUpdated: true,
            });
        }),
    );
    await click('读书：标记完成');
    const summary = container.querySelector('.mobile-sync-summary')!;
    const action = () => container.querySelector<HTMLButtonElement>('.mobile-sync-action')!;
    expect(summary.textContent).toContain('1 条待同步');
    // The sync scheduled after the local change is now running, unseen.
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(services.client.sync).toHaveBeenCalledTimes(2);
    expect(summary.textContent).toContain('1 条待同步');
    expect(summary.textContent).not.toContain('正在同步');
    expect(action().textContent).toBe('同步');
    expect(action().disabled).toBe(false);
    // Neither the summary nor the pending line is a live region: only the floating line is.
    expect(summary.querySelector('[role="status"]')).toBeNull();
    expect(
      [...container.querySelectorAll('.mobile-status')]
        .find((node) => node.textContent?.includes('待入账'))
        ?.getAttribute('role'),
    ).toBeNull();
    expect(audibleStatus()).toEqual([container.querySelector('.mobile-celebration-status')]);
    expect(syncLine()?.textContent).toBe('');
    // Asking while it runs adopts the running sync, which is shown from now on.
    await act(async () => action().click());
    expect(summary.textContent).toContain('正在同步');
    expect(action().textContent).toBe('正在同步…');
    expect(action().disabled).toBe(true);
    expect(services.client.sync).toHaveBeenCalledTimes(2);
    await act(async () => finish());
    expect(summary.textContent).not.toContain('正在同步');
    expect(action().textContent).toBe('同步');
    // The adopted sync was asked for, so its result is spoken, once.
    expect(syncLine()?.textContent).toBe('同步完成。');
  });

  it('speaks the result of a requested sync once and keeps automatic results silent', async () => {
    services.client.sync = vi
      .fn()
      .mockRejectedValue(new MobileSyncError('UNAVAILABLE', '电脑暂时离线，记录已保留。'));
    await render();
    // The opening sync and its finite retries are automatic: nothing is spoken.
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(services.client.sync).toHaveBeenCalledTimes(3);
    expect(syncLine()?.textContent).toBe('');
    expect(syncLine()?.classList.contains('sr-only')).toBe(false);

    vi.mocked(services.client.sync).mockRejectedValue(
      new MobileSyncError('ACTION_REQUIRED', '电脑身份与配对记录不一致，请重新配对。'),
    );
    await click('同步');
    expect(container.querySelector('.mobile-sync-summary')?.textContent).toContain('需要处理');
    expect(container.querySelector('.mobile-sync-detail')?.textContent).toBe(
      '电脑身份与配对记录不一致，请重新配对。',
    );
    expect(syncLine()?.textContent).toBe('需要处理：电脑身份与配对记录不一致，请重新配对。');
    // One announcement: the floating line stays hidden and nothing else speaks.
    expect(audibleStatus()).toEqual([syncLine()]);
    expect(container.querySelector('.mobile-celebration-status')?.hasAttribute('hidden')).toBe(
      true,
    );
    // The same failure on the next request is spoken again.
    const first = syncLine()?.firstElementChild;
    await click('同步');
    expect(syncLine()?.textContent).toBe('需要处理：电脑身份与配对记录不一致，请重新配对。');
    expect(syncLine()?.firstElementChild).not.toBe(first);

    vi.mocked(services.client.sync).mockRejectedValueOnce(
      new MobileSyncError('UNAVAILABLE', '电脑暂时离线，记录已保留。'),
    );
    await click('同步');
    expect(syncLine()?.textContent).toBe('电脑暂时离线，记录已保留。');

    vi.mocked(services.client.sync).mockImplementation(async () => ({
      state: structuredClone(data),
      pushed: 0,
      remaining: 0,
      conflicts: 0,
      snapshotUpdated: true,
    }));
    await click('同步');
    expect(container.querySelector('.mobile-sync-summary')?.textContent).toContain('已同步');
    expect(syncLine()?.textContent).toBe('同步完成。');
    expect(audibleStatus()).toEqual([syncLine()]);

    // A later automatic sync silently clears the old result, so nothing stale stays readable.
    const requested = vi.mocked(services.client.sync).mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('valrecall-app-background'));
      window.dispatchEvent(new Event('valrecall-app-resume'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(services.client.sync).toHaveBeenCalledTimes(requested + 1);
    expect(syncLine()?.textContent).toBe('');

    // A changed computer: the alert speaks, so the sync line adds nothing.
    vi.mocked(services.client.sync).mockRejectedValueOnce(
      new MobileSyncError('EPOCH_CHANGED', '电脑数据已更换', 'epoch-2'),
    );
    await click('同步');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('电脑数据已更换');
    expect(syncLine()?.textContent).toBe('');
    expect(audibleStatus()).toEqual([]);
  });

  it('explains, only for a slow automatic sync, why pairing and cancelling wait', async () => {
    data.outbox = [spendEntry('not-sent', 2)];
    await render();
    let finish!: () => void;
    vi.mocked(services.client.sync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              state: structuredClone(data),
              pushed: 0,
              remaining: 0,
              conflicts: 0,
              snapshotUpdated: true,
            });
        }),
    );
    // A local change schedules the automatic sync; the person opens settings meanwhile.
    await click('读书：标记完成');
    await click('设置');
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(services.client.sync).toHaveBeenCalledTimes(2);
    const scan = button('扫描电脑二维码');
    expect(scan.disabled).toBe(true);
    expect(button('取消待扣款').disabled).toBe(true);
    expect(button('立即同步').disabled).toBe(false);
    // A fast sync never flashes a hint.
    await act(async () => vi.advanceTimersByTimeAsync(599));
    expect(container.textContent).not.toContain('正在同步，稍后');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.querySelector('#mobile-pairing-wait')?.textContent).toBe(
      '正在同步，稍后可配对。',
    );
    expect(scan.getAttribute('aria-describedby')).toBe('mobile-pairing-wait');
    const cancel = button('取消待扣款');
    expect(cancel.getAttribute('aria-describedby')).toBe('mobile-cancel-wait-not-sent');
    expect(container.querySelector('#mobile-cancel-wait-not-sent')?.textContent).toBe(
      '正在同步，稍后可取消。',
    );
    // The hints are plain text, never another live region.
    expect(container.querySelector('#mobile-pairing-wait')?.getAttribute('role')).toBeNull();
    // The top summary still does not say 正在同步.
    expect(container.querySelector('.mobile-sync-summary')?.textContent).not.toContain('正在同步');
    await act(async () => finish());
    expect(container.textContent).not.toContain('正在同步，稍后');
    expect(button('扫描电脑二维码').disabled).toBe(false);
    expect(button('扫描电脑二维码').hasAttribute('aria-describedby')).toBe(false);
    expect(syncLine()?.textContent).toBe('');
  });

  it('announces what one sync confirmed and removed, once each, with one filled coin', async () => {
    const animate = vi.fn(() => Object.assign(new EventTarget(), { cancel: vi.fn() }));
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    try {
      await render();
      document.getElementById('mobile-nav-wallet')!.getBoundingClientRect = () =>
        ({ left: 120, top: 770, width: 115, height: 56, right: 235, bottom: 826 }) as DOMRect;
      const applied = [
        { operationId: 'create-9', kind: 'create-task' as const, taskId: 'new-9', reward: 5 },
        { operationId: 'complete-9', kind: 'complete-task' as const, taskId: 'task-1', reward: 5 },
      ];
      // Pushed, acknowledged and settled by the same sync: the outbox is already empty.
      const confirmed = (): MobileSyncSummary => ({
        state: structuredClone(data),
        pushed: 2,
        remaining: 0,
        conflicts: 0,
        snapshotUpdated: true,
        applied,
      });
      vi.mocked(services.client.sync).mockImplementation(async () => confirmed());
      await click('同步');
      const status = container.querySelector('.mobile-celebration-status')!;
      expect(status.textContent).toBe('+10 元已到账');
      // The confirmation already says the requested sync worked: no second line.
      expect(syncLine()?.textContent).toBe('');
      expect(document.querySelectorAll('.mobile-completion-coin.is-confirmed')).toHaveLength(1);
      expect(document.querySelector('.mobile-completion-coin')?.textContent).toBe('+10');
      await act(async () => vi.advanceTimersByTimeAsync(2400));
      expect(status.hasAttribute('hidden')).toBe(true);
      // The same receipts again (a retried summary) are never announced twice; the sync
      // itself is then reported plainly.
      await click('同步');
      expect(status.hasAttribute('hidden')).toBe(true);
      expect(syncLine()?.textContent).toBe('同步完成。');
    } finally {
      delete (Element.prototype as Partial<Element>).animate;
      document.querySelectorAll('.mobile-completion-coin').forEach((coin) => coin.remove());
    }
  });

  describe('private companion', () => {
    const head = () => container.querySelector<HTMLImageElement>('.mobile-companion-head');
    const cheer = () => container.querySelector<HTMLElement>('.mobile-companion-cheer');
    const cheerArt = () => container.querySelector<HTMLImageElement>('.mobile-companion-cheer-art');
    const cheering = () => cheer()?.classList.contains('is-visible') ?? false;

    it('puts a decorative head before the 待办 title, only on the 待办 page', async () => {
      await render();
      const header = container.querySelector('.mobile-header')!;
      expect(header.firstElementChild).toBe(head());
      expect(head()?.getAttribute('alt')).toBe('');
      expect(head()?.getAttribute('aria-hidden')).toBe('true');
      expect(head()?.dataset.companionPose).toBe('head-smile');
      // The head comes before the title block and the add button stays last.
      const title = header.querySelector('#mobile-page-heading')!;
      expect(head()!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(header.lastElementChild?.id).toBe('mobile-open-add');
      expect(title.textContent).toBe('待办');
      expect(header.textContent).toContain('添加任务');
      // The cheer waits hidden, outside the floating line and the tabs.
      expect(cheering()).toBe(false);
      expect(cheer()?.closest('.mobile-celebration-status, .mobile-bottom-nav')).toBeNull();
      for (const tab of ['零花钱', '设置']) {
        await click(tab);
        expect(head()).toBeNull();
        expect(cheer()).toBeNull();
      }
      await click('待办');
      await click('添加任务');
      expect(head()).toBeNull();
    });

    it("wears the snapshot day's outfit, not this device's day", async () => {
      // 2026-10-13 16:30 in Los Angeles: the snapshot's today is the 13th, not the 14th.
      data.snapshot!.timeZone = 'America/Los_Angeles';
      await render();
      expect(head()?.dataset.companionOutfit).toBe('outfit4');
      expect(head()?.getAttribute('src')).toBe(
        'assets/companion/chibi/outfit4/head-smile.anim.svg',
      );
    });

    it('cheers for 2.4 s after a saved completion, then clears with the line', async () => {
      await render();
      expect(head()?.dataset.companionOutfit).toBe('outfit5');
      await click('读书：标记完成');
      expect(cheering()).toBe(true);
      expect(cheerArt()?.dataset.companionPose).toBe('cheer');
      expect(cheerArt()?.getAttribute('src')).toBe('assets/companion/chibi/outfit5/cheer.anim.svg');
      expect(head()?.dataset.companionPose).toBe('head-joy');
      const status = container.querySelector('.mobile-celebration-status')!;
      expect(status.textContent).toBe('已完成 · 待入账 +5 元');
      expect(cheer()?.contains(status)).toBe(false);
      expect(status.contains(cheer())).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(2400));
      expect(cheering()).toBe(false);
      expect(status.hasAttribute('hidden')).toBe(true);
      // Nothing left open today: all done.
      expect(head()?.dataset.companionPose).toBe('head-joy');
    });

    it("takes the pose from today's count before the completion", async () => {
      data.snapshot!.tasks.push({ task: task('task-2', '写作'), revision: 'rev-1' });
      let next = 0;
      vi.mocked(services.repository.enqueueCompletion).mockImplementation(async (id) => {
        next += 1;
        const entry = { ...completion(`complete-${next}`, id), sequence: next };
        data.outbox.push(entry);
        return entry;
      });
      await render();
      await click('读书：标记完成');
      expect(cheerArt()?.dataset.companionPose).toBe('cheer');
      await act(async () => vi.advanceTimersByTimeAsync(2400));
      expect(head()?.dataset.companionPose).toBe('head-smile');
      await click('写作：标记完成');
      expect(cheering()).toBe(true);
      expect(cheerArt()?.dataset.companionPose).toBe('clap');
    });

    it('clears the cheer when the app goes to the background', async () => {
      await render();
      await click('读书：标记完成');
      expect(cheering()).toBe(true);
      await act(async () => window.dispatchEvent(new Event('valrecall-app-background')));
      expect(cheering()).toBe(false);
      await act(async () => window.dispatchEvent(new Event('valrecall-app-resume')));
      expect(cheering()).toBe(false);
    });

    it('does not cheer when the completion was not saved', async () => {
      vi.mocked(services.repository.enqueueCompletion).mockRejectedValue(new Error('没有保存。'));
      await render();
      await click('读书：标记完成');
      expect(cheering()).toBe(false);
      expect(head()?.dataset.companionPose).toBe('head-smile');
    });

    it('shows the still worried head on a read error', async () => {
      vi.mocked(services.repository.load).mockRejectedValue(new Error('broken'));
      await render();
      expect(container.textContent).toContain('读取失败，请重试。');
      expect(head()?.dataset.companionPose).toBe('head-worried');
      // No snapshot yet, so the outfit follows this device's day; the face is always a still.
      expect(head()?.getAttribute('src')).toMatch(
        /^assets\/companion\/chibi\/[a-z0-9]+\/head-worried\.svg$/u,
      );
      expect(head()?.dataset.companionMotion).toBe('static');
    });
  });
});
