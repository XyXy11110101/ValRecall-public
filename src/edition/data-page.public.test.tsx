import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataView } from '../dashboard/DataView';
import { repository } from '../dashboard/services';
import { downloadJson } from '../shared/extension';
import { REWARDS_STORAGE_KEY, startRewards } from './rewards';

// Only in the public repository: it checks lines the export rewrites in the data page.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

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
});
