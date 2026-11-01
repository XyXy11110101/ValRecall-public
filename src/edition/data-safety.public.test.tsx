import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataView } from '../dashboard/DataView';
import { repository } from '../dashboard/services';
import { downloadJson } from '../shared/extension';
import { LAST_BACKUP_KEY } from './data-safety';
import { startRewards } from './rewards';

// DataView reads the flag once on load to decide on its lazy note, so it is set before any import.
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

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function stubStorage(initial: Record<string, unknown> = {}) {
  const stored = { ...initial };
  const listeners = new Set<ChangeListener>();
  const get = vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(stored, items);
    const changes = Object.fromEntries(
      Object.entries(items).map(([key, newValue]) => [key, { newValue }]),
    );
    listeners.forEach((listener) => listener(changes, 'local'));
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: ChangeListener) => listeners.add(listener),
        removeListener: (listener: ChangeListener) => listeners.delete(listener),
      },
    },
  });
  return { get, set, stored, listeners };
}

describe('data page, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  async function render() {
    root = createRoot(container);
    await act(async () =>
      root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
    );
    await waitFor(() => expect(container.textContent).toContain('卸载扩展'));
  }

  async function clickExport() {
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '导出全部数据')!
        .click(),
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    vi.mocked(repository.exportData).mockReset();
    vi.mocked(downloadJson).mockReset();
    vi.mocked(repository.clearAllData).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says there is no backup yet, what uninstalling does, and that moving is safe', async () => {
    stubStorage();
    await render();
    await waitFor(() => expect(container.textContent).toContain('还没有导出过。'));
    expect(container.textContent).toContain('下载一份备份。');
    expect(container.textContent).toContain('导出后，请确认文件已经存好。');
    expect(container.textContent).toContain('卸载扩展会删除这里的全部数据');
    expect(container.textContent).toContain('移动扩展文件夹不会丢数据');
  });

  it('shows the date of an earlier backup', async () => {
    stubStorage({ [LAST_BACKUP_KEY]: new Date(2026, 9, 5, 12).toISOString() });
    await render();
    await waitFor(() => expect(container.textContent).toContain('上次导出：2026年10月5日。'));
    expect(container.textContent).not.toContain('还没有导出过');
  });

  it('records the date after a successful export and shows it at once', async () => {
    const { stored } = stubStorage();
    vi.mocked(repository.exportData).mockResolvedValue({} as never);
    await render();
    await waitFor(() => expect(container.textContent).toContain('还没有导出过。'));
    await clickExport();
    await waitFor(() => expect(container.textContent).toContain('已导出'));
    expect(downloadJson).toHaveBeenCalledOnce();
    expect(parseIso(stored[LAST_BACKUP_KEY])).toBe(true);
    await waitFor(() => expect(container.textContent).toContain('上次导出：'));
    expect(container.textContent).not.toContain('还没有导出过');
  });

  it('records nothing when the export fails', async () => {
    const { stored } = stubStorage();
    vi.mocked(repository.exportData).mockRejectedValue(new Error('读不出来'));
    await render();
    await clickExport();
    await waitFor(() => expect(container.textContent).toContain('读不出来'));
    expect(stored[LAST_BACKUP_KEY]).toBeUndefined();
    expect(container.textContent).not.toContain('上次导出');
  });

  it('still reports the export as done when the date cannot be saved', async () => {
    const { set } = stubStorage();
    set.mockRejectedValue(new Error('quota'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(repository.exportData).mockResolvedValue({} as never);
    await render();
    await clickExport();
    await waitFor(() => expect(container.textContent).toContain('已导出'));
    expect(container.textContent).not.toContain('上次导出');
  });

  it('does not claim there is no backup when the date cannot be read', async () => {
    const { get } = stubStorage();
    get.mockRejectedValue(new Error('read failed'));
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container.textContent).not.toContain('还没有导出过');
    expect(container.textContent).not.toContain('上次导出');
  });

  describe.each([
    [false, '奖励记录'],
    [true, '零花钱和账本'],
  ])('deleting, with rewards %s', (rewards, kept) => {
    const button = () =>
      Array.from(container.querySelectorAll('button')).find(
        (entry) => entry.textContent === '删除学习内容',
      );
    let stop: () => void;

    beforeEach(async () => {
      stubStorage({ 'valrecall.rewards': rewards });
      stop = await startRewards();
      await render();
    });

    afterEach(() => stop());

    it('says what goes, what stays, and that only uninstalling removes all', () => {
      const panel = container.querySelector('.danger-zone')!.textContent!;
      expect(panel).toContain('删除学习内容');
      expect(panel).toContain('会永久删除回忆题、截图、草稿、分类、待办和笔记。');
      expect(panel).toContain(
        `有些记录会留在这个浏览器里：${kept}、部分复习记录、保存和同步记录等。`,
      );
      expect(panel).toContain('如果配对了手机，配对也会失效，要重新配对。');
      expect(panel).toContain('要全部删除，只能卸载扩展。');
      expect(panel).not.toContain('全部学习数据');
      expect(panel).not.toContain('全部本地');
    });

    it('asks first, says the same, and does nothing on no', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await act(async () => button()!.click());
      expect(confirm).toHaveBeenCalledOnce();
      const asked = confirm.mock.calls[0]![0]!;
      expect(asked).toContain('删除回忆题、截图、草稿、分类、待办和笔记？');
      expect(asked).toContain(kept);
      expect(asked).toContain('如果配对了手机，配对也会失效，要重新配对。');
      expect(asked).toContain('要全部删除，只能卸载扩展。');
      expect(asked).toContain('没有备份就无法恢复。');
      expect(asked).not.toContain('全部学习数据');
      expect(repository.clearAllData).not.toHaveBeenCalled();
    });
  });

  it('never mentions the money sentence on the delete panel with rewards off', async () => {
    stubStorage({ 'valrecall.rewards': false });
    const stop = await startRewards();
    await render();
    expect(container.querySelector('.danger-zone')!.textContent).not.toContain('零花钱');
    stop();
  });

  it('follows a backup made in another page, and stops listening when it closes', async () => {
    const { listeners } = stubStorage();
    await render();
    expect(listeners.size).toBe(1);
    await act(async () => {
      listeners.forEach((listener) =>
        listener(
          { [LAST_BACKUP_KEY]: { newValue: new Date(2026, 10, 2, 12).toISOString() } },
          'local',
        ),
      );
    });
    expect(container.textContent).toContain('上次导出：2026年11月2日。');
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(container);
  });
});

function parseIso(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}
