import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddWorkspace } from '../authoring/AddWorkspace';
import { ValRecallRepository } from '../database';
import { DataView } from '../dashboard/DataView';
import { SettingsView } from '../dashboard/SettingsView';
import { TaskTrialSettings } from '../dashboard/TaskTrialSettings';
import { TypographySettings } from '../dashboard/TypographySettings';
import { WORKING_CARD_STORAGE_KEY } from '../models/working-card';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { sendSyncControl } from '../sync/native-bridge';
import { installDraftMemoryPort } from '../testing/draft-port';
import {
  createTypographyStore,
  FONT_CHOICES,
  normalizeTypography,
  TYPOGRAPHY_STORAGE_KEY,
  VISIBLE_FONT_CHOICES,
} from '../ui/typography';
import { REWARDS_STORAGE_KEY } from './rewards';

// SettingsView reads the flag once on load to decide on its lazy section, so it is set before any
// import.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

vi.mock('../dashboard/services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dashboard/services')>()),
  repository: {
    exportData: vi.fn(),
    importData: vi.fn(),
    clearAllData: vi.fn(),
    listTasks: vi.fn(async () => []),
    listTaskCompletions: vi.fn(async () => []),
    getSchedulingDiagnostic: vi.fn(async () => null),
    listItems: vi.fn(async () => []),
  },
}));
vi.mock('../intake/LegacyNotesArchive', () => ({ LegacyNotesArchive: () => null }));
vi.mock('../sync/native-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync/native-bridge')>()),
  sendSyncControl: vi.fn(async () => ({
    version: 1,
    ok: true,
    state: { enabled: false, connected: false, status: null },
  })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function stubStorage(initial: Record<string, unknown> = {}) {
  const stored = { ...initial };
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension', getManifest: () => ({ version: '1.0.0' }) },
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(stored, items)),
        remove: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return stored;
}

describe('owner-only features, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function waitFor(check: () => void) {
    for (let attempt = 0; ; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      try {
        check();
        return;
      } catch (error) {
        if (attempt >= 100) throw error;
      }
    }
  }

  const findButton = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === label,
    ) ?? null;

  beforeEach(() => {
    vi.mocked(sendSyncControl).mockClear();
    stubStorage({ [REWARDS_STORAGE_KEY]: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('MiSans', () => {
    const fontValues = () =>
      Array.from(container.querySelectorAll<HTMLInputElement>('input[name="typography-font"]')).map(
        (radio) => radio.value,
      );
    const checkedFont = () =>
      container.querySelector<HTMLInputElement>('input[name="typography-font"]:checked')?.value;

    it('lists the same choices as the full list, without MiSans', () => {
      expect(VISIBLE_FONT_CHOICES).toEqual(FONT_CHOICES.filter(({ id }) => id !== 'misans'));
    });

    it('offers no MiSans radio', async () => {
      const store = createTypographyStore({ faces: () => Promise.resolve() });
      await act(async () => {
        await store.start();
        root.render(<TypographySettings store={store} />);
      });
      expect(fontValues()).toEqual(['wenkai', 'noto', 'yahei']);
      expect(container.textContent).not.toContain('MiSans');
    });

    it('falls a stored MiSans choice back to the default, and keeps the text size', async () => {
      expect(normalizeTypography({ size: 'large', font: 'misans' })).toEqual({
        size: 'large',
        font: 'wenkai',
      });
      expect(normalizeTypography({ font: 'noto' }).font).toBe('noto');

      stubStorage({ [TYPOGRAPHY_STORAGE_KEY]: { size: 'large', font: 'misans' } });
      const page = document.createElement('html');
      const faces = vi.fn(() => Promise.resolve());
      const store = createTypographyStore({ root: () => page, faces });
      await act(async () => {
        await store.start();
        root.render(<TypographySettings store={store} />);
      });
      expect(page.getAttribute('data-font')).toBe('wenkai');
      expect(page.getAttribute('data-text-size')).toBe('large');
      expect(faces).toHaveBeenCalledWith('wenkai');
      expect(checkedFont()).toBe('wenkai');
    });
  });

  describe('settings', () => {
    async function renderSettings() {
      await act(async () =>
        root.render(
          <SettingsView
            preferences={DEFAULT_PREFERENCES}
            onSaved={() => undefined}
            onOpenData={() => undefined}
          />,
        ),
      );
    }
    const syncDetails = () =>
      Array.from(container.querySelectorAll('details')).find((details) =>
        details.querySelector('summary')?.textContent?.includes('手机同步'),
      );
    async function toggle(details: HTMLDetailsElement, open: boolean) {
      await act(async () => {
        details.open = open;
        details.dispatchEvent(new Event('toggle'));
      });
    }

    it('keeps sync folded and silent until it is opened, and silent again after', async () => {
      await renderSettings();
      await waitFor(() => expect(syncDetails()).toBeDefined());
      const details = syncDetails()!;

      expect(details.open).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('手机同步（可选）');
      expect(details.textContent).toContain('可以不管这里');
      expect(details.textContent).toContain('要你自己构建');
      expect(details.textContent).toContain('docs/LOCAL_SYNC.md');
      expect(container.querySelector('.sync-settings')).toBeNull();
      expect(sendSyncControl).not.toHaveBeenCalled();

      await toggle(details, true);
      await waitFor(() => expect(container.querySelector('.sync-settings')).not.toBeNull());
      expect(sendSyncControl).toHaveBeenCalledTimes(1);
      expect(sendSyncControl).toHaveBeenCalledWith('status');

      await toggle(details, false);
      expect(container.querySelector('.sync-settings')).toBeNull();
    });

    it('credits only the fonts it ships, and each licence file exists', async () => {
      await renderSettings();
      await act(async () => findButton('高级')?.click());
      await act(async () => findButton('显示高级选项')?.click());
      await waitFor(() => expect(container.textContent).toContain('界面字体'));

      expect(container.textContent).not.toContain('MiSans');
      expect(container.textContent).toContain('霞鹜文楷（LXGW WenKai）');
      expect(container.textContent).toContain('思源黑体（Noto Sans SC）');
      const licences = Array.from(container.querySelectorAll('dd a')).map((link) =>
        link.getAttribute('href'),
      );
      expect(licences).toEqual(['fonts/LXGW-OFL.txt', 'fonts/OFL.txt']);
      for (const licence of licences) {
        expect(existsSync(resolve('public', licence!))).toBe(true);
      }
    });
  });

  describe('add page', () => {
    function workspace(key: number, mode: 'receive' | 'manual') {
      return (
        <AddWorkspace
          active
          request={{ key, mode }}
          preferences={DEFAULT_PREFERENCES}
          onChanged={() => undefined}
          onViewItem={() => undefined}
        />
      );
    }

    beforeEach(() => {
      installDraftMemoryPort();
      vi.spyOn(ValRecallRepository.prototype, 'listCategories').mockResolvedValue([]);
    });

    it('has no ChatGPT entry and shows the manual form, even when asked for the other', async () => {
      await act(async () => root.render(workspace(1, 'receive')));
      await waitFor(() => expect(container.querySelector('.manual-question-form')).not.toBeNull());
      const manual = () =>
        container.querySelector('.manual-question-form')?.closest<HTMLElement>('[hidden]');

      expect(container.textContent).not.toContain('ChatGPT');
      expect(container.textContent).not.toContain('整理包');
      expect(container.querySelector('.add-mode-switch')).toBeNull();
      expect(manual()).toBeNull();

      await act(async () => root.render(workspace(2, 'receive')));
      expect(container.textContent).not.toContain('ChatGPT');
      expect(manual()).toBeNull();
    });
  });

  it('keeps the working card switch and hides the two-week comparison', async () => {
    stubStorage({
      [WORKING_CARD_STORAGE_KEY]: {
        version: 1,
        enabled: true,
        current: null,
        notes: [],
        trial: { startedOn: '2026-10-30', openOneOffsAtStart: 8, starts: 5 },
      },
    });
    await act(async () => root.render(<TaskTrialSettings />));
    await waitFor(() =>
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(
        false,
      ),
    );

    expect(container.textContent).toContain('工作中卡片');
    expect(container.textContent).toContain('在首页待办里显示');
    expect(container.textContent).not.toContain('两周对比');
    expect(container.querySelector('details')).toBeNull();
  });

  it('asks about the phone only if there is one, when replacing data', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () =>
      root.render(<DataView onChanged={() => undefined} onBackToSettings={() => undefined} />),
    );
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    await act(async () => {
      const mode = container.querySelector('select')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(
        mode,
        'replace',
      );
      mode.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['{}'], 'backup.json')],
    });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toBe(
      '用这份备份替换全部学习和待办数据？如果你在用手机版，请先在手机上完成同步。',
    );
  });
});
