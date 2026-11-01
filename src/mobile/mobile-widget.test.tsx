import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftRepository, readDraft } from '../database/drafts';
import type { MobileOutboxEntry, MobileState } from '../database/mobile-repository';
import type { DailyTask } from '../models/daily-task';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { installDraftMemoryPort } from '../testing/draft-port';
import { MobileApp, type MobileAppServices } from './MobileApp';
import type { WidgetNavigation } from './widget-bridge';
import type { WidgetProjection } from './widget-projection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const now = new Date('2026-10-26T10:00:00Z');
const date = '2026-10-26';
const clock = () => now;

function task(id = 'read-book', title = '读十页书'): DailyTask {
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

function initialState(): MobileState {
  return {
    epoch: 'epoch-1',
    snapshot: {
      version: 2,
      sequence: 1,
      epoch: 'epoch-1',
      generatedAt: now.toISOString(),
      timeZone: 'Europe/London',
      tasks: [{ task: task(), revision: 'revision-1' }],
      completions: [],
      occurrences: [],
      taskSkips: [],
      wallet: { ...structuredClone(DEFAULT_ALLOWANCE), balance: 20 },
    },
    outbox: [],
    archives: [],
  };
}

function target(kind: WidgetNavigation['kind'], id = 'widget-click-1'): WidgetNavigation {
  return {
    version: 1,
    id,
    kind,
    epoch: kind === 'task' ? 'epoch-1' : null,
    taskId: kind === 'task' ? 'read-book' : null,
    occurrenceDate: kind === 'task' ? date : null,
  };
}

describe('mobile widget integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: MobileState;
  let services: MobileAppServices;
  let drafts: ReturnType<typeof installDraftMemoryPort>;
  let navigation: WidgetNavigation[];
  let rejectPublish: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    drafts = installDraftMemoryPort();
    // The real repository lists newest first; preserve that contract in this memory fixture.
    vi.mocked(DraftRepository.prototype.list).mockImplementation(async (scope) =>
      [...drafts.values()]
        .filter((draft) => draft.scope === scope)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    state = initialState();
    navigation = [];
    rejectPublish = false;
    services = {
      repository: {
        load: vi.fn(async () => structuredClone(state)),
        createTask: vi.fn(async (draft) => {
          const id = 'create-' + (state.outbox.length + 1);
          const entry: MobileOutboxEntry = {
            id,
            epoch: 'epoch-1',
            attempted: false,
            status: 'pending',
            receipt: null,
            sequence: state.outbox.length + 1,
            operation: {
              id,
              kind: 'create-task',
              at: now.toISOString(),
              task: {
                ...task('task-' + id, draft.title),
                kind: draft.recurrence === 'specific_date' ? 'one_off' : 'routine',
                notes: draft.notes ?? null,
                recurrence: draft.recurrence,
                selectedWeekdays: draft.selectedWeekdays ?? [],
                scheduledDate: draft.scheduledDate ?? null,
                scheduledTime: draft.scheduledTime ?? null,
                priority: draft.priority ?? 'normal',
              },
            },
          };
          state.outbox.push(entry);
          return entry;
        }),
        enqueueCompletion: vi.fn(async (taskId) => {
          const entry: MobileOutboxEntry = {
            id: 'complete-1',
            epoch: 'epoch-1',
            attempted: false,
            status: 'pending',
            receipt: null,
            sequence: state.outbox.length + 1,
            operation: {
              id: 'complete-1',
              kind: 'complete-task',
              at: now.toISOString(),
              date,
              timeZone: 'Europe/London',
              taskId,
              taskRevision: 'revision-1',
              occurrenceRevision: null,
            },
          };
          state.outbox.push(entry);
          return entry;
        }),
        enqueueTaskAction: vi.fn(async () => {
          throw new Error('Unexpected task action');
        }),
        enqueueSpend: vi.fn(async () => {
          throw new Error('Unexpected spending');
        }),
        cancelNeverSent: vi.fn(async () => false),
        acceptNewEpoch: vi.fn(async () => undefined),
      },
      client: {
        sync: vi.fn(async () => ({
          state: structuredClone(state),
          pushed: 0,
          remaining: 0,
          conflicts: 0,
          snapshotUpdated: true,
        })),
      },
      native: vi.fn(async (type) => {
        if (type === 'navigation.consume') return navigation.shift() ?? null;
        if (type === 'widget.publish') {
          if (rejectPublish) throw new Error('Widget cache unavailable');
          return {};
        }
        if (type === 'navigation.inputReady') return {};
        return { paired: true, deviceId: 'phone-1', epoch: 'epoch-1' };
      }),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function render() {
    await act(async () => root.render(<MobileApp services={services} clock={clock} />));
    await settle();
  }

  async function settle() {
    await act(async () => vi.advanceTimersByTimeAsync(20));
  }

  function button(name: string) {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (element) =>
        !element.closest('[hidden]') &&
        (element.textContent === name || element.getAttribute('aria-label') === name),
    );
    if (!found) throw new Error('Missing visible button: ' + name);
    return found;
  }

  async function click(name: string) {
    await act(async () => button(name).click());
    await settle();
  }

  async function fill(name: string, value: string) {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[name="${name}"]`,
    )!;
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function wake(next: WidgetNavigation) {
    navigation.push(next);
    await act(async () => window.dispatchEvent(new Event('valrecall-navigation-ready')));
    await settle();
  }

  function publications() {
    return vi
      .mocked(services.native)
      .mock.calls.filter(([type]) => type === 'widget.publish')
      .map(([, payload]) => (payload as { projection: WidgetProjection }).projection);
  }

  const inputReady = () =>
    vi.mocked(services.native).mock.calls.filter(([type]) => type === 'navigation.inputReady');
  const titleInput = () => container.querySelector<HTMLInputElement>('#mobile-task-title')!;

  function latestReady() {
    const projection = publications().at(-1);
    if (projection?.status !== 'ready') throw new Error('Missing ready widget projection');
    return projection;
  }

  it('publishes loaded tasks and removes a completion only after its local write succeeds', async () => {
    await render();
    expect(latestReady().days[0]).toMatchObject({
      date,
      total: 1,
      rows: [{ taskId: 'read-book' }],
    });
    const complete = services.repository.enqueueCompletion;
    let finish!: () => Promise<void>;
    services.repository.enqueueCompletion = vi.fn(
      (...args: Parameters<typeof complete>) =>
        new Promise<MobileOutboxEntry>((resolve, reject) => {
          finish = async () => {
            try {
              resolve(await complete(...args));
            } catch (error) {
              reject(error);
            }
          };
        }),
    );
    await click('读十页书：标记完成');
    expect(latestReady().days[0]?.total).toBe(1);
    await act(async () => finish());
    await settle();
    const last = publications().at(-1)!;
    expect(last.status).toBe('ready');
    if (last.status !== 'ready') throw new Error('Missing ready projection');
    expect(last.days[0]).toMatchObject({ date, total: 0, rows: [] });
    expect(last.days[1]?.rows[0]?.taskId).toBe('read-book');
    expect(services.repository.enqueueCompletion).toHaveBeenCalledTimes(1);
  });

  it('publishes an unavailable state when the initial read fails', async () => {
    vi.mocked(services.repository.load).mockRejectedValue(new Error('Synthetic read failure'));
    await render();
    expect(publications().at(-1)).toMatchObject({
      status: 'unavailable',
      reason: 'read-error',
      days: [],
    });
    expect(publications().some((projection) => projection.status === 'ready')).toBe(false);
  });

  it('keeps a saved task and its navigation when native cache publishing rejects', async () => {
    rejectPublish = true;
    navigation.push(target('add-task'));
    await render();
    await fill('title', '练习十分钟');
    await click('保存任务');
    expect(services.repository.createTask).toHaveBeenCalledTimes(1);
    expect(state.outbox.filter((entry) => entry.operation.kind === 'create-task')).toHaveLength(1);
    expect(window.location.hash).toBe('#tasks');
    expect(container.querySelector('.mobile-today')?.textContent).toContain('练习十分钟');
    expect(container.textContent).not.toContain('没有保存成功');
  });

  it('consumes a cold task target after loading and focuses that exact task', async () => {
    navigation.push(target('task'));
    await render();
    expect(window.location.hash).toBe('#tasks');
    expect(document.activeElement?.id).toBe('mobile-task-read-book');
    expect(inputReady()).toHaveLength(0);
  });

  it.each(['missing', 'completed', 'wrong-epoch', 'old-occurrence'] as const)(
    'opens the current list with a notice for a cold %s task target',
    async (reason) => {
      const request = target('task');
      if (reason === 'missing') request.taskId = 'missing-task';
      if (reason === 'wrong-epoch') request.epoch = 'old-epoch';
      if (reason === 'old-occurrence') request.occurrenceDate = '2026-10-25';
      if (reason === 'completed')
        state.snapshot!.completions.push({
          id: 'done-1',
          taskId: 'read-book',
          localDate: date,
          completedAt: now.toISOString(),
        });
      navigation.push(request);
      await render();
      expect(window.location.hash).toBe('#tasks');
      expect(container.querySelector('.mobile-celebration-status')?.textContent).toBe(
        '这项待办已变化。',
      );
      expect(document.activeElement?.id).not.toBe('mobile-task-read-book');
      expect(inputReady()).toHaveLength(0);
    },
  );

  it('opens the next recurring occurrence as a focused read-only card after today is completed', async () => {
    state.snapshot!.completions.push({
      id: 'done-today',
      taskId: 'read-book',
      localDate: date,
      completedAt: now.toISOString(),
    });
    navigation.push({ ...target('task'), occurrenceDate: '2026-10-27' });
    await render();
    expect(latestReady().days[0]).toMatchObject({
      total: 0,
      rows: [],
      next: { taskId: 'read-book', occurrenceDate: '2026-10-27' },
    });
    const card = container.querySelector<HTMLElement>('#mobile-widget-next-task');
    expect(window.location.hash).toBe('#tasks');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('下一次安排');
    expect(card?.textContent).toContain('读十页书');
    expect(document.activeElement).toBe(card);
    expect(card?.querySelector('.mobile-complete, [aria-label$="：标记完成"]')).toBeNull();
    expect(services.repository.enqueueCompletion).not.toHaveBeenCalled();
    expect(inputReady()).toHaveLength(0);
  });

  it('does not lose a cold target while the first repository read is pending', async () => {
    let finish!: (value: MobileState) => void;
    vi.mocked(services.repository.load).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    navigation.push(target('task'));
    await render();
    expect(
      vi.mocked(services.native).mock.calls.some(([type]) => type === 'navigation.consume'),
    ).toBe(false);
    expect(publications()).toHaveLength(0);
    await act(async () => finish(structuredClone(state)));
    await settle();
    expect(document.activeElement?.id).toBe('mobile-task-read-book');
  });

  it('focuses a cold add target and requests the keyboard once after the input is ready', async () => {
    const request = target('add-task');
    navigation.push(request);
    await render();
    expect(window.location.hash).toBe('#add-task');
    expect(document.activeElement).toBe(titleInput());
    expect(inputReady()).toEqual([['navigation.inputReady', { id: request.id }]]);
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });

  it.each(['wallet', 'spend'] as const)(
    'opens a hot add target from %s and continues the existing task draft',
    async (from) => {
      await render();
      await click('添加任务');
      await fill('title', '还没写完的待办');
      await fill('notes', '保留备注');
      await click('返回');
      await click('零花钱');
      if (from === 'spend') {
        await click('记一笔扣款');
        await fill('amount', '3');
        await fill('spend-note', '尚未确认');
      }
      vi.spyOn(window, 'scrollY', 'get').mockReturnValue(480);
      await wake(target('add-task', 'hot-add'));
      expect(window.location.hash).toBe('#add-task');
      expect(titleInput().value).toBe('还没写完的待办');
      expect(container.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value).toBe(
        '保留备注',
      );
      expect(document.activeElement).toBe(titleInput());
      expect(window.scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
      expect(titleInput().selectionStart).toBe(titleInput().value.length);
      expect(inputReady()).toEqual([['navigation.inputReady', { id: 'hot-add' }]]);
      expect(services.repository.createTask).not.toHaveBeenCalled();
      expect(services.repository.enqueueSpend).not.toHaveBeenCalled();
      if (from === 'spend') {
        expect(container.querySelector<HTMLInputElement>('[name="amount"]')?.value).toBe('3');
        expect(container.querySelector<HTMLInputElement>('[name="spend-note"]')?.value).toBe(
          '尚未确认',
        );
      }
    },
  );

  it('continues the newest same-workspace draft after a restart without restoring another epoch', async () => {
    await render();
    await click('添加任务');
    await fill('title', '重启后继续写');
    await fill('notes', '最新草稿备注');
    await act(async () => vi.advanceTimersByTimeAsync(500));
    const saved = [...drafts.values()].find((draft) => draft.scope === 'mobile-task')!;
    expect(saved).toBeDefined();
    for (const [id, epoch, updatedAt] of [
      ['older-draft', 'epoch-1', '2026-10-25T10:00:00Z'],
      ['other-workspace', 'epoch-2', '2026-10-27T10:00:00Z'],
    ]) {
      drafts.set(
        id!,
        readDraft({
          ...saved,
          id,
          updatedAt,
          summary: id,
          payload: { ...(saved.payload as Record<string, string>), id, epoch, title: id },
        }),
      );
    }
    await act(async () => root.unmount());
    root = createRoot(container);
    navigation.push(target('add-task', 'restart-add'));
    await render();
    expect(window.location.hash).toBe('#add-task');
    expect(titleInput().value).toBe('重启后继续写');
    expect(container.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value).toBe(
      '最新草稿备注',
    );
    expect(document.activeElement).toBe(titleInput());
    expect(inputReady()).toEqual([['navigation.inputReady', { id: 'restart-add' }]]);
    expect(drafts.has('other-workspace')).toBe(true);
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });

  it('does not request the keyboard again for rapid duplicate navigation events', async () => {
    const request = target('add-task', 'same-click');
    navigation.push(request, request, request);
    await render();
    await act(async () => {
      window.dispatchEvent(new Event('valrecall-navigation-ready'));
      window.dispatchEvent(new Event('valrecall-navigation-ready'));
    });
    await settle();
    expect(window.location.hash).toBe('#add-task');
    expect(document.activeElement).toBe(titleInput());
    expect(inputReady()).toEqual([['navigation.inputReady', { id: 'same-click' }]]);
  });

  it('cancels a queued widget add when the user leaves while a save is still busy', async () => {
    await render();
    await click('添加任务');
    await fill('title', '正在保存的待办');
    const create = services.repository.createTask;
    let finish!: () => Promise<void>;
    services.repository.createTask = vi.fn(
      (...args: Parameters<typeof create>) =>
        new Promise<MobileOutboxEntry>((resolve, reject) => {
          finish = async () => {
            try {
              resolve(await create(...args));
            } catch (error) {
              reject(error);
            }
          };
        }),
    );
    await click('保存任务');
    await wake(target('add-task', 'queued-add'));
    expect(inputReady()).toHaveLength(0);
    await click('返回');
    expect(window.location.hash).toBe('#tasks');
    await act(async () => finish());
    await settle();
    expect(window.location.hash).toBe('#tasks');
    expect(inputReady()).toHaveLength(0);
    expect(services.repository.createTask).toHaveBeenCalledTimes(1);
  });

  it('shows a visible draft-read error and retries restoring before requesting the keyboard', async () => {
    const id = 'retained-draft';
    drafts.set(
      id,
      readDraft({
        schemaVersion: 1,
        id,
        scope: 'mobile-task',
        revision: 1,
        updatedAt: now.toISOString(),
        summary: '上次没有写完',
        payload: {
          id,
          epoch: 'epoch-1',
          title: '上次没有写完',
          notes: '已有备注',
          recurrence: 'specific_date',
          selectedWeekdays: [],
          scheduledDate: date,
          scheduledTime: '',
          priority: 'normal',
        },
      }),
    );
    const list = vi.mocked(DraftRepository.prototype.list);
    list.mockRejectedValue(new Error('Synthetic draft read failure'));
    navigation.push(target('add-task', 'retry-add'));
    await render();
    const error = container.querySelector('#mobile-add-form .mobile-error[role="alert"]');
    expect(error?.textContent).toContain('草稿读取失败');
    expect(error?.closest('[hidden]')).toBeNull();
    expect(window.location.hash).toBe('#add-task');
    expect(inputReady()).toHaveLength(0);
    list.mockImplementation(async (scope) =>
      [...drafts.values()]
        .filter((draft) => draft.scope === scope)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    await click('重试读取草稿');
    expect(titleInput().value).toBe('上次没有写完');
    expect(container.querySelector<HTMLTextAreaElement>('[name="notes"]')?.value).toBe('已有备注');
    expect(document.activeElement).toBe(titleInput());
    expect(inputReady()).toEqual([['navigation.inputReady', { id: 'retry-add' }]]);
    expect(container.querySelector('#mobile-add-form .mobile-error[role="alert"]')).toBeNull();
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });

  it('does not focus a stale row after a later repository read fails', async () => {
    await render();
    await click('零花钱');
    vi.mocked(services.repository.load).mockRejectedValue(
      new Error('Synthetic later read failure'),
    );
    await click('同步');
    expect(publications().at(-1)).toMatchObject({ status: 'unavailable', reason: 'read-error' });
    await wake(target('task', 'stale-row'));
    expect(window.location.hash).toBe('#tasks');
    expect(document.activeElement?.id).not.toBe('mobile-task-read-book');
    expect(container.querySelector('.mobile-celebration-status')?.textContent).toBe(
      '这项待办已变化。',
    );
  });

  it('ignores a delayed consumed target when the user has already chosen another page', async () => {
    let deliver!: (value: unknown) => void;
    const delayed = new Promise<unknown>((resolve) => {
      deliver = resolve;
    });
    const ordinaryNative = services.native;
    let first = true;
    services.native = vi.fn(async (type, payload) => {
      if (type === 'navigation.consume' && first) {
        first = false;
        return delayed;
      }
      return ordinaryNative(type, payload);
    });
    await render();
    await click('零花钱');
    await act(async () => {
      deliver(target('add-task', 'delayed-consume'));
      await delayed;
    });
    await settle();
    expect(window.location.hash).toBe('#wallet');
    expect(inputReady()).toHaveLength(0);
  });

  it('routes an add target to recovery without opening the keyboard when records cannot be read', async () => {
    vi.mocked(services.repository.load).mockRejectedValue(new Error('Synthetic read failure'));
    navigation.push(target('add-task'));
    await render();
    expect(window.location.hash).toBe('#settings');
    expect(document.activeElement?.id).toBe('mobile-connection-heading');
    expect(inputReady()).toHaveLength(0);
    expect(services.repository.createTask).not.toHaveBeenCalled();
  });
});
