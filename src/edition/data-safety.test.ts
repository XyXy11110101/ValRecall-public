import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataView } from '../dashboard/DataView';
import { repository } from '../dashboard/services';
import {
  backupFileDate,
  deleteAllCopy,
  LAST_BACKUP_KEY,
  lastBackupLine,
  loadLastBackup,
  onLastBackupChanged,
  parseLastBackup,
  recordLastBackup,
  requestPersistentStorageOnce,
} from './data-safety';

vi.mock('../dashboard/services', () => ({
  repository: { exportData: vi.fn(), importData: vi.fn(), clearAllData: vi.fn() },
}));
vi.mock('../intake/LegacyNotesArchive', () => ({ LegacyNotesArchive: () => null }));
vi.mock('../shared/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/extension')>()),
  downloadJson: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubStorage(initial: Record<string, unknown> = {}) {
  const stored = { ...initial };
  const get = vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(stored, items);
  });
  vi.stubGlobal('chrome', { storage: { local: { get, set } } });
  return { get, set, stored };
}

function stubPersist(persist: (() => Promise<boolean>) | undefined) {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: persist ? { persist } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'storage');
});

describe('requestPersistentStorageOnce', () => {
  it('asks once, and does not ask again on the next open', async () => {
    const { stored } = stubStorage();
    const persist = vi.fn().mockResolvedValue(true);
    stubPersist(persist);
    await requestPersistentStorageOnce();
    await requestPersistentStorageOnce();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(stored['valrecall.persistAsked']).toBe(true);
  });

  it('takes a refusal silently and does not ask again', async () => {
    stubStorage();
    const persist = vi.fn().mockResolvedValue(false);
    stubPersist(persist);
    await expect(requestPersistentStorageOnce()).resolves.toBeUndefined();
    await requestPersistentStorageOnce();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('takes a thrown refusal silently', async () => {
    const { stored } = stubStorage();
    stubPersist(vi.fn().mockRejectedValue(new Error('denied')));
    await expect(requestPersistentStorageOnce()).resolves.toBeUndefined();
    expect(stored['valrecall.persistAsked']).toBe(true);
  });

  it('does nothing where the browser has no such request', async () => {
    const { set } = stubStorage();
    stubPersist(undefined);
    await expect(requestPersistentStorageOnce()).resolves.toBeUndefined();
    expect(set).not.toHaveBeenCalled();
  });

  it('survives a failed storage read without asking', async () => {
    const { get } = stubStorage();
    get.mockRejectedValue(new Error('read failed'));
    const persist = vi.fn().mockResolvedValue(true);
    stubPersist(persist);
    await expect(requestPersistentStorageOnce()).resolves.toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('last backup date', () => {
  it('stores the time of the export and reads it back', async () => {
    const { stored } = stubStorage();
    await expect(loadLastBackup()).resolves.toBeNull();
    const now = new Date('2026-11-01T02:03:04.000Z');
    await recordLastBackup(now);
    expect(stored[LAST_BACKUP_KEY]).toBe('2026-11-01T02:03:04.000Z');
    await expect(loadLastBackup()).resolves.toEqual(now);
  });

  it('does not fail when the date cannot be saved', async () => {
    const { set } = stubStorage();
    set.mockRejectedValue(new Error('quota'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(recordLastBackup()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('works without extension storage', async () => {
    await expect(recordLastBackup()).resolves.toBeUndefined();
    await expect(loadLastBackup()).resolves.toBeNull();
    expect(onLastBackupChanged(() => undefined)).toBeTypeOf('function');
  });

  it.each([[undefined], [null], [12], ['not a date'], [{}]])('treats %j as no backup', (value) => {
    expect(parseLastBackup(value)).toBeNull();
  });

  it('says the local date, or that there is none', () => {
    expect(lastBackupLine(new Date(2026, 10, 1, 23, 30))).toBe('上次导出：2026年11月1日。');
    expect(lastBackupLine(null)).toBe('还没有导出过。');
  });

  it('names the file with the same local date the page shows', () => {
    // Both ends of a local day, so one of them crosses the UTC date in any zone but UTC.
    for (const now of [new Date(2026, 10, 2, 0, 30), new Date(2026, 10, 2, 23, 30)]) {
      expect(backupFileDate(now)).toBe('2026-11-02');
      expect(lastBackupLine(now)).toBe('上次导出：2026年11月2日。');
    }
  });

  it('follows changes to this key in local storage only, until unsubscribed', () => {
    const listeners: ((changes: object, area: string) => void)[] = [];
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (listener: (changes: object, area: string) => void) =>
            listeners.push(listener),
          removeListener: () => listeners.pop(),
        },
      },
    });
    const listener = vi.fn();
    const stop = onLastBackupChanged(listener);
    const iso = '2026-11-01T02:03:04.000Z';
    listeners[0]!({ other: { newValue: iso } }, 'local');
    listeners[0]!({ [LAST_BACKUP_KEY]: { newValue: iso } }, 'sync');
    expect(listener).not.toHaveBeenCalled();
    listeners[0]!({ [LAST_BACKUP_KEY]: { newValue: iso } }, 'local');
    expect(listener).toHaveBeenCalledWith(new Date(iso));
    stop();
    expect(listeners).toHaveLength(0);
  });
});

describe('deleteAllCopy', () => {
  it.each([true, false])('never says everything is gone, rewards %s', (rewards) => {
    const copy = deleteAllCopy(rewards);
    for (const text of Object.values(copy)) {
      expect(text).not.toMatch(/全部学习|全部数据|全部本地|—/u);
    }
    expect(copy.done).toBe(
      '回忆题、截图、草稿、分类、待办和笔记已删除。有些记录还留在这个浏览器里。',
    );
  });

  it('only names money with rewards on', () => {
    expect(deleteAllCopy(true).panel).toContain('零花钱和账本');
    expect(JSON.stringify(deleteAllCopy(false))).not.toContain('零花钱');
  });
});

describe('data page, private edition', () => {
  it('records nothing on export and shows no public note', async () => {
    const { set } = stubStorage();
    vi.mocked(repository.exportData).mockResolvedValue({} as never);
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () =>
      root.render(
        createElement(DataView, { onChanged: () => undefined, onBackToSettings: () => undefined }),
      ),
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '导出全部数据')!
        .click(),
    );
    expect(container.textContent).toContain('已导出');
    expect(container.textContent).toContain('下载一份备份。');
    expect(container.textContent).not.toContain('卸载');
    expect(container.textContent).not.toContain('上次导出');
    expect(container.textContent).not.toContain('存好');
    expect(container.textContent).toContain('零花钱会保留');
    expect(container.textContent).toContain('删除全部本地学习数据');
    expect(set).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
