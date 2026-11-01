import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileOutboxEntry, MobileState } from '../database/mobile-repository';
import type { DailyTask } from '../models/daily-task';
import { MobileApp, type MobileAppServices } from '../mobile/MobileApp';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { installDraftMemoryPort } from '../testing/draft-port';

vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-10-13T23:30:00Z');
const MONEY = /零花钱|余额|扣款|入账|\d ?元/u;

function task(): DailyTask {
  return {
    id: 'task-1',
    schemaVersion: 1,
    title: '读书',
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

describe('rewards, public phone', () => {
  let container: HTMLDivElement;
  let root: Root;
  let data: MobileState;
  let services: MobileAppServices;

  const visibleText = () => {
    const copy = container.cloneNode(true) as HTMLDivElement;
    copy.querySelectorAll('[hidden]').forEach((element) => element.remove());
    return copy.textContent ?? '';
  };
  const navTabs = () =>
    Array.from(container.querySelectorAll('.mobile-bottom-nav button')).map(
      (tab) => tab.textContent,
    );

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
    const complete: MobileOutboxEntry = {
      id: 'complete-1',
      epoch: 'epoch-1',
      operation: {
        id: 'complete-1',
        kind: 'complete-task',
        at: now.toISOString(),
        date: '2026-10-14',
        timeZone: 'Asia/Shanghai',
        taskId: 'task-1',
        taskRevision: 'rev-1',
        occurrenceRevision: null,
      },
      attempted: false,
      status: 'pending',
      receipt: null,
      sequence: 1,
    };
    services = {
      repository: {
        load: vi.fn(async () => structuredClone(data)),
        createTask: vi.fn(),
        enqueueCompletion: vi.fn(async () => {
          data.outbox.push(complete);
          return complete;
        }),
        enqueueTaskAction: vi.fn(),
        enqueueSpend: vi.fn(),
        cancelNeverSent: vi.fn(),
        acceptNewEpoch: vi.fn(),
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
    } as unknown as MobileAppServices;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function render() {
    await act(async () =>
      root.render(<MobileApp services={services} clock={() => now} confirmAction={() => true} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10));
  }

  it('has two tabs and no reward text, with no setting to change that', async () => {
    await render();
    expect(navTabs()).toEqual(['待办', '设置']);
    expect(container.querySelector('#mobile-nav-wallet')).toBeNull();
    expect(visibleText()).not.toMatch(MONEY);
    expect(container.textContent).not.toContain('余额与奖励');
    expect(container.textContent).not.toContain('添加 +5 元');
  });

  it('credits the font this edition ships', async () => {
    await render();
    const credit = container.querySelector('.mobile-font-attribution')?.textContent;
    expect(credit).toBe('本产品使用思源黑体（Noto Sans SC），SIL Open Font License 1.1。');
  });

  it('keeps the wallet and spend pages out of reach', async () => {
    await render();
    expect(container.querySelector('#mobile-wallet-balance')?.closest('[hidden]')).not.toBeNull();
    expect(container.querySelector('#mobile-spend-form')?.closest('[hidden]')).not.toBeNull();
  });

  it('confirms a finished task plainly and shows no coin', async () => {
    await render();
    const check = container.querySelector<HTMLElement>('.mobile-checkbox');
    if (!check) throw new Error('Missing the task checkbox');
    await act(async () => check.click());
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(services.repository.enqueueCompletion).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.mobile-celebration-status')?.textContent).toBe('已完成');
    expect(document.querySelector('.mobile-completion-coin')).toBeNull();
    expect(visibleText()).not.toMatch(MONEY);
  });
});
