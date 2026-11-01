import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataView } from './DataView';
import { repository } from './services';

vi.mock('./services', () => ({
  repository: { exportData: vi.fn(), importData: vi.fn(), clearAllData: vi.fn() },
}));
vi.mock('../intake/LegacyNotesArchive', () => ({ LegacyNotesArchive: () => null }));
vi.mock('../edition/pending-capture-clear', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../edition/pending-capture-clear')>()),
  reloadDataPageAfterDelete: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('DataView operations', () => {
  it.each([9, 8])(
    'only restores wallet after explicit replace opt-in for schema %s',
    async (schemaVersion) => {
      vi.mocked(repository.importData).mockResolvedValue({
        items: 0,
        notes: 0,
        categories: 0,
        reviews: 0,
        screenshots: 0,
        tasks: 0,
        taskCompletions: 0,
        intakeReceipts: 0,
      });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const onChanged = vi.fn();
      const container = document.createElement('div');
      const root = createRoot(container);
      const parsed = { schemaVersion };
      async function upload() {
        const input = container.querySelector<HTMLInputElement>('input[type=file]')!;
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: [{ text: async () => JSON.stringify(parsed) }],
        });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      }
      try {
        act(() =>
          root.render(<DataView onChanged={onChanged} onBackToSettings={() => undefined} />),
        );
        await upload();
        expect(repository.importData).toHaveBeenLastCalledWith(parsed, 'merge');
        const select = container.querySelector('select')!;
        act(() => {
          select.value = 'replace';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await upload();
        expect(repository.importData).toHaveBeenLastCalledWith(parsed, 'replace', {
          restoreWallet: false,
        });
        act(() => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
        await upload();
        expect(repository.importData).toHaveBeenLastCalledWith(parsed, 'replace', {
          restoreWallet: schemaVersion === 9,
        });
        expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('零花钱也会替换'));
        expect(onChanged).toHaveBeenCalledTimes(3);
        expect(container.textContent).toContain(
          schemaVersion === 9 ? '零花钱已按备份恢复' : '这份备份不含零花钱',
        );
        confirm.mockReturnValueOnce(false);
        await upload();
        expect(onChanged).toHaveBeenCalledTimes(3);
      } finally {
        act(() => root.unmount());
        confirm.mockRestore();
        vi.clearAllMocks();
      }
    },
  );

  it('starts only one export and releases the lock after a failure', async () => {
    let reject!: (error: Error) => void;
    vi.mocked(repository.exportData).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() =>
        root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
      );
      const button = [...container.querySelectorAll('button')].find(
        (node) => node.textContent === '导出全部数据',
      )!;
      act(() => {
        button.click();
        button.click();
      });
      expect(repository.exportData).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(true);
      await act(async () => reject(new Error('export failed')));
      expect(button.disabled).toBe(false);
      expect(container.textContent).toContain('export failed');
    } finally {
      act(() => root.unmount());
      vi.clearAllMocks();
    }
  });

  describe('工作中 card notes', () => {
    function stubStorage(remove = vi.fn(async () => undefined)) {
      vi.stubGlobal('chrome', { storage: { local: { get: vi.fn(), set: vi.fn(), remove } } });
      return remove;
    }
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function mount() {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
      );
      return { container, root };
    }
    const clearAll = (container: HTMLElement) =>
      act(async () => {
        [...container.querySelectorAll('button')]
          .find((node) => node.textContent === '删除全部学习数据')
          ?.click();
      });

    it('clears them with clear-all', async () => {
      const remove = stubStorage();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(repository.clearAllData).mockResolvedValue(undefined);
      const { container, root } = await mount();
      await clearAll(container);
      expect(repository.clearAllData).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledExactlyOnceWith('valrecall.workingCard');
      expect(container.textContent).toContain(
        '回忆题、截图、草稿、分类、待办和笔记已删除。有些记录还留在这个浏览器里。',
      );
      act(() => root.unmount());
      container.remove();
      vi.clearAllMocks();
    });

    it('warns when they could not be cleared', async () => {
      stubStorage(vi.fn().mockRejectedValue(new Error('denied')));
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.mocked(repository.clearAllData).mockResolvedValue(undefined);
      const { container, root } = await mount();
      await clearAll(container);
      expect(container.textContent).toContain('工作中卡片的内容没清除，请再试一次。');
      act(() => root.unmount());
      container.remove();
      vi.clearAllMocks();
    });
  });
});
