import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualQuestionForm, type ManualQuestionFormProps } from '../authoring/ManualQuestionForm';
import { DashboardApp } from '../dashboard/DashboardApp';
import { DashboardNavigation } from '../dashboard/DashboardNavigation';
import { DataView } from '../dashboard/DataView';
import { SettingsView } from '../dashboard/SettingsView';
import { changeTaskCompletion } from '../dashboard/task-completion';
import { saveIntake } from '../intake/save-intake';
import type { IntakeSelection } from '../intake/package';
import { TaskList } from '../mobile/TaskList';
import { confirmationMessage, type MobileTaskRow } from '../mobile/task-presentation';
import { newReadingDraft } from '../reading/reading-draft';
import { saveReading } from '../reading/save-reading';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import {
  taskCompletionMessage,
  taskCreationMessage,
  taskUndoMessage,
} from '../shared/task-celebration';
import { installDraftMemoryPort } from '../testing/draft-port';
import { REWARDS_STORAGE_KEY, startRewards } from './rewards';

// SettingsView reads the flag once on load to decide on its lazy switch, so it is set before any
// import.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MONEY = /零花钱|\d ?元/u;

function stubStorage(rewards?: boolean) {
  const stored: Record<string, unknown> =
    rewards === undefined ? {} : { [REWARDS_STORAGE_KEY]: rewards };
  const set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(stored, values);
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', getManifest: () => ({ version: '1' }) },
    storage: {
      local: { get: vi.fn(async () => stored), set },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return { set };
}

describe('rewards, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let stop: (() => void) | undefined;

  async function start(rewards?: boolean) {
    const storage = stubStorage(rewards);
    stop = await startRewards();
    return storage;
  }

  async function waitFor(check: () => void) {
    for (let attempt = 0; ; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      try {
        check();
        return;
      } catch (error) {
        if (attempt >= 100) throw error;
      }
    }
  }

  beforeEach(() => {
    installDraftMemoryPort();
    window.history.replaceState({}, '', '/dashboard.html');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('sentences', () => {
    it('never mention money while off', async () => {
      await start(false);
      expect(taskCompletionMessage('rewarded', 5)).toBe('已完成。');
      expect(taskCompletionMessage('all-done', 5)).toBe('今天的待办都完成了。');
      expect(taskUndoMessage(5)).toBe('已撤销完成。');
      expect(taskCreationMessage(5)).toBe('待办已创建。');
    });

    it('keep the amount while on', async () => {
      await start(true);
      expect(taskCompletionMessage('rewarded', 5)).toBe('已完成，+5 元零花钱。');
      expect(taskUndoMessage(5)).toBe('已撤销完成，零花钱 −5 元。');
      expect(taskCreationMessage(5)).toBe('待办已创建，+5 元零花钱。');
    });

    const failingLedger = () => ({
      complete: vi.fn().mockRejectedValue(new Error('locked')),
      undo: vi.fn(),
    });
    const completeToday = (rewards: ReturnType<typeof failingLedger>) => {
      const now = new Date(2026, 10, 1, 12);
      return changeTaskCompletion(
        {
          complete: vi.fn().mockResolvedValue({ created: true }),
          undo: vi.fn(),
        } as never,
        'task',
        '2026-11-01',
        true,
        now,
        rewards as never,
      );
    };

    it('do not warn about a ledger the user cannot see, which still records', async () => {
      await start(false);
      const rewards = failingLedger();
      const result = await completeToday(rewards);
      expect(rewards.complete).toHaveBeenCalledTimes(1);
      expect(result.warning).toBeNull();
    });

    it('warn about the ledger while on', async () => {
      await start(true);
      const result = await completeToday(failingLedger());
      expect(result.warning).toMatch(MONEY);
    });

    const readingDependencies = () => ({
      create: vi.fn().mockResolvedValue({ id: 'saved' }),
      get: vi.fn(),
      reward: vi.fn().mockRejectedValue(new Error('locked')),
    });
    const reading = () => ({
      ...newReadingDraft(),
      excerpt: '原文',
      recallPrompt: '问题？',
      coreLesson: '答案',
    });
    const intakeDependencies = () => ({
      receive: vi.fn().mockResolvedValue({
        notes: 0,
        questions: 1,
        entries: [{}],
        rewardReceiptIds: ['receipt'],
      }),
      reward: vi.fn().mockRejectedValue(new Error('locked')),
      finish: vi.fn(),
    });

    it('do not ask to check the ledger after a save while off', async () => {
      await start(false);
      const saved = await saveReading(reading(), 'standard', readingDependencies() as never);
      expect(saved.warning).toBeNull();
      const received = await saveIntake(
        {} as IntakeSelection,
        'standard',
        intakeDependencies() as never,
      );
      expect(received.warning).toBeNull();
    });

    it('ask to check the ledger after a save while on', async () => {
      await start(true);
      const saved = await saveReading(reading(), 'standard', readingDependencies() as never);
      expect(saved.warning).toContain('账本');
      const received = await saveIntake(
        {} as IntakeSelection,
        'standard',
        intakeDependencies() as never,
      );
      expect(received.warning).toContain('账本');
    });
  });

  describe('navigation', () => {
    const tabs = () =>
      Array.from(container.querySelectorAll('.nav-tab')).map((tab) => tab.textContent);
    const navigation = <DashboardNavigation view="home" ready onNavigate={() => undefined} />;

    it('has no reward tab while off', async () => {
      await start(false);
      await act(async () => root.render(navigation));
      expect(tabs()).toContain('设置');
      expect(tabs()).not.toContain('零花钱');
    });

    it('shows the reward tab while on', async () => {
      await start(true);
      await act(async () => root.render(navigation));
      expect(tabs()).toContain('零花钱');
    });

    it('sends the reward page home while off, replacing it in the history', async () => {
      await start(false);
      window.history.replaceState({}, '', '/dashboard.html?view=allowance');
      const before = window.history.length;
      await act(async () =>
        root.render(<DashboardApp preferenceLoader={async () => DEFAULT_PREFERENCES} />),
      );
      await waitFor(() => expect(window.location.search).toBe('?view=home'));
      expect(window.history.length).toBe(before);
      expect(container.querySelector('.allowance-ledger-view')).toBeNull();
    });

    it('opens the reward page while on', async () => {
      await start(true);
      window.history.replaceState({}, '', '/dashboard.html?view=allowance');
      await act(async () =>
        root.render(<DashboardApp preferenceLoader={async () => DEFAULT_PREFERENCES} />),
      );
      await waitFor(() => expect(container.querySelector('.allowance-ledger-view')).not.toBeNull());
      expect(window.location.search).toBe('?view=allowance');
    });
  });

  describe('switch in settings', () => {
    const settings = (
      <SettingsView
        preferences={DEFAULT_PREFERENCES}
        onSaved={() => undefined}
        onOpenData={() => undefined}
      />
    );
    const toggle = () =>
      Array.from(container.querySelectorAll('label'))
        .find((label) => label.textContent?.includes('显示零花钱奖励'))
        ?.querySelector('input') ?? null;

    it('is off by default, and says what it is once on', async () => {
      const { set } = await start();
      await act(async () => root.render(settings));
      await waitFor(() => expect(toggle()).not.toBeNull());
      expect(toggle()!.checked).toBe(false);
      expect(container.textContent).not.toContain('不是真钱');

      await act(async () => toggle()!.click());
      await waitFor(() => expect(toggle()!.checked).toBe(true));
      expect(set).toHaveBeenCalledWith({ 'valrecall.rewards': true });
      expect(container.textContent).toContain('这只是给自己的奖励记录，不是真钱。');
    });

    it('says so when the choice could not be saved', async () => {
      const { set } = await start();
      set.mockRejectedValueOnce(new Error('full'));
      await act(async () => root.render(settings));
      await waitFor(() => expect(toggle()).not.toBeNull());
      await act(async () => toggle()!.click());
      await waitFor(() =>
        expect(
          Array.from(container.querySelectorAll('[role="alert"]')).map(
            (alert) => alert.textContent,
          ),
        ).toContain('没能保存，请再试一次。'),
      );
      expect(toggle()!.checked).toBe(false);
    });
  });

  describe('data page', () => {
    it('does not mention rewards while off', async () => {
      await start(false);
      await act(async () =>
        root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
      );
      const mode = container.querySelector('select') as HTMLSelectElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      await act(async () => {
        setValue.call(mode, 'replace');
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.textContent).not.toMatch(MONEY);
    });

    it('offers to restore them while on', async () => {
      await start(true);
      await act(async () =>
        root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
      );
      const mode = container.querySelector('select') as HTMLSelectElement;
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      await act(async () => {
        setValue.call(mode, 'replace');
        mode.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.textContent).toContain('同时恢复备份中的零花钱');
    });
  });

  it('shows a plain saved heading, not praise, after saving a reading', async () => {
    await start(false);
    const save: NonNullable<ManualQuestionFormProps['save']> = vi.fn().mockResolvedValue({
      item: { id: 'saved', title: '问题？', recallPrompt: '问题？' },
      allowance: {
        captureReward: 2,
        checkIn: false,
        checkInReward: 0,
        praise: '又记下一个知识点。',
        checkInPraise: null,
      },
      manualReward: null,
      warning: null,
    });
    await act(async () =>
      root.render(
        <ManualQuestionForm
          loadCategories={async () => []}
          save={save}
          sourceRequest={{ key: 1, source: 'reading' }}
        />,
      ),
    );
    const type = (label: string, value: string) => {
      const element = Array.from(container.querySelectorAll('label'))
        .find((entry) => entry.querySelector('span')?.textContent === label)
        ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
      if (!element) throw new Error(`Missing field ${label}`);
      const proto =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      act(() => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('原文', '摘录');
    type('回忆问题', '问题？');
    type('答案要点', '答案');
    const submit = Array.from(container.querySelectorAll('button')).find(
      (entry) => entry.textContent === '保存阅读摘录',
    );
    await act(async () => submit!.click());
    const heading = container.querySelector('.manual-question-form h2');
    expect(heading?.textContent).toBe('阅读摘录已保存');
    expect(heading?.textContent).not.toContain('知识点');
  });

  it('hides every whole reward element with display:none, so no key can reach it', () => {
    const css = readFileSync(resolve(__dirname, 'rewards.css'), 'utf8');
    for (const selector of [
      "[data-allowance-stat='balance']",
      '[data-wallet-target]',
      '.home-task-wallet',
      '.tasks-wallet-chip',
      '.task-coin-layer',
      '.review-session-earned',
      '.review-allowance-copy',
      '.review-earned-total',
      '.review-step-earned',
      '.reading-reward',
      '.capture-reward-confirmation',
    ]) {
      expect(css).toContain(`html:not([data-rewards='on']) ${selector}`);
    }
    expect(css).toContain('display: none;');
  });

  describe('phone', () => {
    it('confirms without an amount', () => {
      expect(confirmationMessage([{ operationId: 'a', taskId: 't', amount: 5 }])).toBe(
        '电脑已确认完成',
      );
      expect(
        confirmationMessage([{ operationId: 'a', taskId: 't', amount: 5, kind: 'create-task' }]),
      ).toBe('电脑已确认新增待办');
      expect(
        confirmationMessage([
          { operationId: 'a', taskId: 't', amount: 5 },
          { operationId: 'b', taskId: 'u', amount: 5 },
        ]),
      ).toBe('电脑已确认 2 项完成');
    });

    it('shows a finished task without its amount', async () => {
      const row = {
        task: {
          id: 't',
          title: '读书',
          notes: null,
          recurrence: 'daily',
          scheduledDate: null,
          scheduledTime: null,
          selectedWeekdays: [],
          priority: 'normal',
        },
        date: '2026-11-01',
        done: true,
        pending: false,
        rewardAmount: 5,
      } as unknown as MobileTaskRow;
      await act(async () =>
        root.render(
          <TaskList
            rows={[row]}
            disabled={false}
            timeZone="Asia/Shanghai"
            onComplete={() => undefined}
            onAction={() => undefined}
          />,
        ),
      );
      expect(container.textContent).toContain('读书');
      expect(container.textContent).not.toMatch(MONEY);
    });
  });
});
