import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataView } from '../dashboard/DataView';
import { repository } from '../dashboard/services';
import { downloadJson } from '../shared/extension';
import { setDraftWritesStopped } from '../database/drafts';
import { reloadDataPageAfterDelete } from './pending-capture-clear';
import { REWARDS_STORAGE_KEY, startRewards } from './rewards';

// Only in the public repository: it checks lines the export rewrites in the data page.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

vi.mock('./pending-capture-clear', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pending-capture-clear')>()),
  reloadDataPageAfterDelete: vi.fn(),
}));
vi.mock('../database/drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/drafts')>()),
  setDraftWritesStopped: vi.fn(),
}));

vi.mock('../dashboard/services', () => ({
  repository: { exportData: vi.fn(), importData: vi.fn(), clearAllData: vi.fn() },
}));
vi.mock('../intake/LegacyNotesArchive', () => ({ LegacyNotesArchive: () => null }));
vi.mock('../shared/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/extension')>()),
  downloadJson: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMPORT_RESULT = {
  items: 2,
  notes: 0,
  categories: 0,
  reviews: 0,
  screenshots: 0,
  tasks: 1,
  taskCompletions: 0,
  intakeReceipts: 0,
};

describe('data page results, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let stop: () => void;

  async function render(rewards: boolean) {
    const stored: Record<string, unknown> = { [REWARDS_STORAGE_KEY]: rewards };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async () => stored),
          set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, values)),
        },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    stop = await startRewards();
    await act(async () =>
      root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
    );
  }

  async function upload(backup: unknown) {
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ text: async () => JSON.stringify(backup) }],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  const click = async (label: string) =>
    act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === label)!
        .click(),
    );

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(repository.importData).mockResolvedValue(IMPORT_RESULT as never);
    vi.mocked(repository.exportData).mockResolvedValue({} as never);
    vi.mocked(repository.clearAllData).mockResolvedValue(undefined);
    vi.mocked(downloadJson).mockReset();
    vi.mocked(reloadDataPageAfterDelete).mockReset();
    vi.mocked(setDraftWritesStopped).mockReset();
    sessionStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([new Date(2026, 10, 2, 0, 30), new Date(2026, 10, 2, 23, 30)])(
    'names the backup with the local date at %s',
    async (now) => {
      await render(false);
      vi.useFakeTimers({ toFake: ['Date'], now });
      await click('导出全部数据');
      expect(downloadJson).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        'valrecall-backup-2026-11-02.json',
      );
    },
  );

  it('says nothing about money and does not warn on an old backup with rewards off', async () => {
    await render(false);
    await upload({ schemaVersion: 8 });
    const notice = container.querySelector('.notice');
    expect(notice?.textContent).toBe('已导入 2 条回忆题、1 项待办等。');
    expect(notice?.className).not.toContain('warning');
  });

  it('still says so, with a warning, with rewards on', async () => {
    await render(true);
    await upload({ schemaVersion: 8 });
    const notice = container.querySelector('.notice');
    expect(notice?.textContent).toContain('这份备份不含零花钱。');
    expect(notice?.className).toContain('warning');
  });

  it.each([true, false])('does not say everything is gone after deleting, %s', async (rewards) => {
    await render(rewards);
    await click('删除学习内容');
    expect(repository.clearAllData).toHaveBeenCalledOnce();
    const notice = container.querySelector('.notice')?.textContent;
    expect(notice).toContain(
      '回忆题、截图、草稿、分类、待办和笔记已删除。有些记录还留在这个浏览器里。',
    );
    expect(notice).not.toContain('全部');
  });

  describe('what this tab still holds in memory', () => {
    it('stops draft writes before deleting, then reloads with the result', async () => {
      const order: string[] = [];
      vi.mocked(setDraftWritesStopped).mockImplementation(() => order.push('stop') as never);
      vi.mocked(repository.clearAllData).mockImplementation(async () => {
        order.push('database');
      });
      vi.mocked(reloadDataPageAfterDelete).mockImplementation(() => order.push('reload') as never);
      await render(false);
      vi.stubGlobal('chrome', {
        ...chrome,
        storage: {
          ...chrome.storage,
          local: { ...chrome.storage.local, remove: vi.fn(async () => undefined) },
        },
      });
      await click('删除学习内容');
      expect(order).toEqual(['stop', 'database', 'reload']);
      expect(reloadDataPageAfterDelete).toHaveBeenCalledExactlyOnceWith({
        text: expect.stringContaining('回忆题、截图、草稿、分类、待办和笔记已删除。'),
        tone: 'success',
      });
    });

    it('stays, and writes again, when the delete failed', async () => {
      vi.mocked(repository.clearAllData).mockRejectedValue(new Error('读不出来'));
      await render(false);
      await click('删除学习内容');
      expect(reloadDataPageAfterDelete).not.toHaveBeenCalled();
      expect(vi.mocked(setDraftWritesStopped).mock.calls).toEqual([[true], [false]]);
    });

    it('does not reload when the person says no', async () => {
      vi.mocked(window.confirm).mockReturnValue(false);
      await render(false);
      await click('删除学习内容');
      expect(reloadDataPageAfterDelete).not.toHaveBeenCalled();
      expect(setDraftWritesStopped).not.toHaveBeenCalled();
    });

    it('shows the held result once after the reload', async () => {
      sessionStorage.setItem(
        'valrecall.deleteNotice',
        JSON.stringify({ text: '已删除，有警告。', tone: 'warning' }),
      );
      await render(false);
      const notice = container.querySelector('.notice');
      expect(notice?.textContent).toBe('已删除，有警告。');
      expect(notice?.className).toContain('warning');

      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () =>
        root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
      );
      expect(container.querySelector('.notice')).toBeNull();
    });
  });

  describe('the capture still waiting in the service worker', () => {
    const sendMessage = vi.fn();

    async function deleteWithRuntime() {
      await render(false);
      vi.stubGlobal('chrome', {
        ...chrome,
        runtime: { id: 'test', sendMessage },
        storage: {
          ...chrome.storage,
          local: { ...chrome.storage.local, remove: vi.fn(async () => undefined) },
        },
      });
      await click('删除学习内容');
    }

    beforeEach(() => sendMessage.mockReset());

    it('is cleared by a message the service worker accepts, after the database', async () => {
      const order: string[] = [];
      vi.mocked(repository.clearAllData).mockImplementation(async () => {
        order.push('database');
      });
      sendMessage.mockImplementation(async () => {
        order.push('message');
        return { ok: true };
      });
      await deleteWithRuntime();
      expect(order).toEqual(['database', 'message']);
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        type: 'VALRECALL_CLEAR_PENDING_CAPTURE',
        version: 1,
      });
      const notice = container.querySelector('.notice');
      expect(notice?.textContent).not.toContain('捕获没清除');
      expect(notice?.className).not.toContain('warning');
    });

    it.each([
      ['refuses', async () => ({ ok: false })],
      ['cannot be reached', () => Promise.reject(new Error('No receiver'))],
    ])('is reported when the service worker %s', async (_name, answer) => {
      sendMessage.mockImplementation(answer);
      await deleteWithRuntime();
      const notice = container.querySelector('.notice');
      expect(notice?.textContent).toContain('等待整理的捕获没清除，请再试一次。');
      expect(notice?.className).toContain('warning');
    });

    it('is not touched when the database could not be cleared', async () => {
      vi.mocked(repository.clearAllData).mockRejectedValue(new Error('读不出来'));
      await deleteWithRuntime();
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });
});
