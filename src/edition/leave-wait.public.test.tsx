import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DailyTask, TaskDaySummary } from '../database';
import { ReviewArea } from '../dashboard/ReviewArea';
import { TasksView, type TaskDashboardRepository } from '../dashboard/TasksView';
import {
  DISCARD_AND_LEAVE_QUESTION,
  LEAVE_WAIT_STEP_MS,
  LEAVE_WAIT_STEPS,
  requestEditorLeave,
  requestEditorLeaveAsync,
  useEditProtection,
} from '../shared/edit-protection';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { installDraftMemoryPort } from '../testing/draft-port';

vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

let writing = false;
vi.mock('../dashboard/TodayView', async () => {
  const { useEditProtection: protect } = await import('../shared/edit-protection');
  return {
    TodayView: () => {
      protect({ dirty: false, busy: () => writing });
      return <p>现在到期内容</p>;
    },
  };
});
vi.mock('../dashboard/UpcomingReviewsView', () => ({
  UpcomingReviewsView: () => <p>即将到期内容</p>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAVING_MESSAGE = '正在保存，请稍候再离开。';
const LIMIT_MS = LEAVE_WAIT_STEP_MS * LEAVE_WAIT_STEPS;

describe('leaving during a save, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    writing = false;
    vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Writer({ busy }: { busy: () => boolean }) {
    useEditProtection({ dirty: false, busy });
    return null;
  }

  /** Follows a promise while fake time moves on. */
  function track(leaving: Promise<boolean>) {
    const seen: { result: boolean | undefined } = { result: undefined };
    void leaving.then((value) => {
      seen.result = value;
    });
    return seen;
  }

  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  describe('the wait itself', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('continues by itself once the write ends, with no message', async () => {
      await act(async () => root.render(<Writer busy={() => writing} />));
      writing = true;
      const seen = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS * 10);
      expect(seen.result).toBeUndefined();
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 2);
      expect(seen.result).toBe(true);
      expect(window.alert).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('sets no timer when nothing is being written', async () => {
      await act(async () => root.render(<Writer busy={() => false} />));
      const seen = track(requestEditorLeaveAsync());
      await advance(0);
      expect(seen.result).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops at the limit and falls back to the existing message', async () => {
      const busy = vi.fn(() => true);
      await act(async () => root.render(<Writer busy={busy} />));
      busy.mockClear();
      const seen = track(requestEditorLeaveAsync());
      await advance(LIMIT_MS - LEAVE_WAIT_STEP_MS);
      expect(seen.result).toBeUndefined();
      expect(window.alert).not.toHaveBeenCalled();
      await advance(LEAVE_WAIT_STEP_MS);
      expect(seen.result).toBe(false);
      expect(window.alert).toHaveBeenCalledOnce();
      expect(window.alert).toHaveBeenCalledWith(SAVING_MESSAGE);
      expect(vi.getTimerCount()).toBe(0);
      // One read before waiting, one per step, then the two existing checks. Nothing more.
      expect(busy.mock.calls.length).toBeLessThanOrEqual(LEAVE_WAIT_STEPS + 3);
    });

    it('does not ask about a form whose save has ended but has not rendered yet', async () => {
      // A pending ref clears at once, and the form's dirty state follows on the next render.
      let rerender: () => void = () => undefined;
      function SettingsLike() {
        const [dirty, setDirty] = useState(true);
        rerender = () => setDirty(false);
        useEditProtection({ dirty, busy: () => writing });
        return null;
      }
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await act(async () => root.render(<SettingsLike />));
      writing = true;
      const seen = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS * 3);
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS);
      expect(seen.result).toBeUndefined();
      await act(async () => rerender());
      await advance(LEAVE_WAIT_STEP_MS);
      expect(seen.result).toBe(true);
      expect(confirm).not.toHaveBeenCalled();
    });

    it('keeps the text when the save fails: the discard question decides, unchanged', async () => {
      function Form() {
        const [text, setText] = useState('还没存好的文字');
        useEditProtection({ dirty: true, busy: () => writing });
        return <textarea value={text} onChange={(event) => setText(event.target.value)} />;
      }
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await act(async () => root.render(<Form />));
      writing = true;
      const seen = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS * 4);
      expect(confirm).not.toHaveBeenCalled();
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 2);
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm).toHaveBeenCalledWith(DISCARD_AND_LEAVE_QUESTION);
      expect(seen.result).toBe(false);
      expect(container.querySelector('textarea')?.value).toBe('还没存好的文字');
    });

    it('saves text typed during the wait, the newest version, before leaving', async () => {
      const saved: string[] = [];
      let type: (value: string) => void = () => undefined;
      function Form() {
        const [text, setText] = useState('第一版');
        type = setText;
        useEditProtection({
          dirty: true,
          busy: () => writing,
          prepareLeave: async () => {
            saved.push(text);
            return true;
          },
          draftVersion: text,
        });
        return null;
      }
      await act(async () => root.render(<Form />));
      writing = true;
      const seen = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS * 2);
      await act(async () => type('第二版'));
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 2);
      expect(saved).toEqual(['第二版']);
      expect(seen.result).toBe(true);
    });

    it('stays put when text changes during a write that began in the draft flush', async () => {
      let type: (value: string) => void = () => undefined;
      function Form() {
        const [text, setText] = useState('第一版');
        type = setText;
        useEditProtection({
          dirty: true,
          busy: () => writing,
          prepareLeave: async () => {
            writing = true;
            return true;
          },
          draftVersion: text,
        });
        return null;
      }
      await act(async () => root.render(<Form />));
      const seen = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS);
      expect(window.alert).not.toHaveBeenCalled();
      expect(seen.result).toBeUndefined();
      await act(async () => type('第二版'));
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 2);
      expect(seen.result).toBe(false);
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('lets the newest leave go on, so the question is asked once', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      function Form() {
        useEditProtection({ dirty: true, busy: () => writing });
        return null;
      }
      await act(async () => root.render(<Form />));
      writing = true;
      const first = track(requestEditorLeaveAsync());
      await advance(LEAVE_WAIT_STEP_MS);
      const second = track(requestEditorLeaveAsync());
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 3);
      expect(first.result).toBe(false);
      expect(second.result).toBe(true);
      expect(confirm).toHaveBeenCalledOnce();
    });

    it('leaves the synchronous path as it was', async () => {
      await act(async () => root.render(<Writer busy={() => true} />));
      expect(requestEditorLeave()).toBe(false);
      expect(window.alert).toHaveBeenCalledWith(SAVING_MESSAGE);
    });

    it('private edition: still shows the message at once', async () => {
      vi.stubGlobal('__VALRECALL_PUBLIC_RELEASE__', false);
      await act(async () => root.render(<Writer busy={() => true} />));
      expect(await requestEditorLeaveAsync()).toBe(false);
      expect(window.alert).toHaveBeenCalledWith(SAVING_MESSAGE);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('review tabs', () => {
    function Area() {
      const [section, setSection] = useState<'due' | 'upcoming'>('due');
      return (
        <ReviewArea
          section={section}
          onSectionChange={setSection}
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          preferredItemId={null}
          onChanged={() => undefined}
          onGoHome={() => undefined}
          onGoLibrary={() => undefined}
          onViewItem={() => undefined}
          onOpenReminderSettings={() => undefined}
        />
      );
    }

    it('switches by itself once a rating has been written', async () => {
      vi.useFakeTimers();
      await act(async () => root.render(<Area />));
      writing = true;
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((entry) => entry.textContent === '即将到期')
          ?.click(),
      );
      await advance(LEAVE_WAIT_STEP_MS * 3);
      expect(container.textContent).toContain('现在到期内容');
      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 2);
      expect(container.textContent).toContain('即将到期内容');
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('stays on the same tab when the leave is refused', async () => {
      vi.useFakeTimers();
      await act(async () => root.render(<Area />));
      writing = true;
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((entry) => entry.textContent === '即将到期')
          ?.click(),
      );
      await advance(LIMIT_MS);
      expect(window.alert).toHaveBeenCalledWith(SAVING_MESSAGE);
      expect(container.textContent).toContain('现在到期内容');
      expect(container.textContent).not.toContain('即将到期内容');

      writing = false;
      await advance(LEAVE_WAIT_STEP_MS * 3);
      expect(container.textContent).toContain('现在到期内容');
    });
  });

  describe('tasks page', () => {
    const today = '2026-07-22';
    const clock = () => new Date(2026, 6, 22, 12, 0, 0);
    const makeTask = (title: string): DailyTask => ({
      id: 'task-1',
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
      createdAt: clock().toISOString(),
      updatedAt: clock().toISOString(),
    });
    const summaryOf = (task: DailyTask | null) =>
      ({
        localDate: today,
        total: task ? 1 : 0,
        completed: 0,
        remaining: task ? 1 : 0,
        percentage: 0,
        occurrences: task ? [{ task, localDate: today, completion: null }] : [],
      }) as unknown as TaskDaySummary;

    function repositoryWithReload(before: DailyTask, after: DailyTask | null) {
      let releaseReload: () => void = () => undefined;
      const reload = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      let saved = false;
      const repository = {
        listTasks: vi.fn(async () => {
          if (!saved) return [before];
          await reload;
          return after ? [after] : [];
        }),
        listTaskCompletions: vi.fn(async () => []),
        listItems: vi.fn(async () => []),
        getTaskDaySummary: vi.fn(async () => summaryOf(saved ? after : before)),
        updateTask: vi.fn(async () => {
          saved = true;
          return after ?? before;
        }),
      } as unknown as TaskDashboardRepository;
      return { repository, releaseReload: () => releaseReload() };
    }

    const buttonNamed = (label: string) =>
      Array.from(container.querySelectorAll('button')).find(
        (entry) => entry.textContent?.trim() === label,
      );
    const titleField = () => container.querySelector<HTMLInputElement>('.task-form label input');

    /** In short steps, because React renders only when an act ends, as it would between timers. */
    async function settle() {
      for (let step = 0; step < 12; step += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_STEP_MS / 2));
        });
      }
    }

    async function saveThenClickEditDuringReload(repository: TaskDashboardRepository) {
      await act(async () =>
        root.render(
          <TasksView
            revision={0}
            onChanged={() => undefined}
            taskRepository={repository}
            clock={clock}
            allowanceLoader={async () => ({ balance: 0 }) as never}
          />,
        ),
      );
      await settle();
      await act(async () => buttonNamed('编辑')?.click());
      await settle();
      await act(async () => buttonNamed('保存待办')?.click());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(titleField()).toBeNull();
      // The list still shows the old row, and its edit button is live during the reload.
      expect(buttonNamed('编辑')?.disabled).toBe(false);
      await act(async () => buttonNamed('编辑')?.click());
      await settle();
      expect(window.alert).not.toHaveBeenCalled();
      expect(titleField()).toBeNull();
    }

    beforeEach(() => {
      installDraftMemoryPort();
      vi.stubGlobal('chrome', {
        storage: {
          local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
        },
      });
    });

    it('opens the saved values, not the row that was clicked before the reload', async () => {
      const { repository, releaseReload } = repositoryWithReload(
        makeTask('旧标题'),
        makeTask('刚保存的标题'),
      );
      await saveThenClickEditDuringReload(repository);
      releaseReload();
      await settle();
      expect(titleField()?.value).toBe('刚保存的标题');
    });

    it('says so when the task is gone after the reload', async () => {
      const { repository, releaseReload } = repositoryWithReload(makeTask('旧标题'), null);
      await saveThenClickEditDuringReload(repository);
      releaseReload();
      await settle();
      expect(titleField()).toBeNull();
      expect(container.textContent).toContain('这条待办已不存在。');
    });
  });
});
