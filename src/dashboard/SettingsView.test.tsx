import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Rating } from 'ts-fsrs';

import { FsrsService } from '../fsrs';
import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../models/messages';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { SettingsView } from './SettingsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsView reminders', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, 'startViewTransition');
    vi.unstubAllGlobals();
  });

  it('keeps failed settings editable, locks saves, and reports reminder failure separately', async () => {
    let reject!: (error: Error) => void;
    const set = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const onSaved = vi.fn();
    vi.stubGlobal('chrome', {
      storage: { local: { set } },
      runtime: {
        id: 'test',
        getManifest: () => ({ version: 'test' }),
        sendMessage: vi.fn().mockResolvedValue({ ok: false, error: '提醒暂时不可用' }),
      },
    });
    await act(async () =>
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={onSaved}
          onOpenData={() => undefined}
        />,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>('select')!;
    act(() => {
      select.value = 'Do';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const save = findButton('保存设置')!;
    act(() => {
      save.click();
      save.click();
    });
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('无法写入设置')));
    expect(onSaved).not.toHaveBeenCalled();
    expect(select.value).toBe('Do');
    expect(container.textContent).toContain('无法写入设置');
    await act(async () => findButton('保存设置')!.click());
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ defaultItemType: 'Do' }));
    expect(container.textContent).toContain('已保存，提醒没刷新');
  });

  it('shows the personal-build defaults and Edge delivery explanation', () => {
    const markup = renderToStaticMarkup(
      <SettingsView
        preferences={DEFAULT_PREFERENCES}
        onSaved={() => undefined}
        onOpenData={() => undefined}
      />,
    );

    expect(markup).toContain('Edge 每日复习提醒');
    expect(markup).toContain('value="20:00"');
    expect(markup).toContain('启用每日复习提醒');
    expect(markup).toContain('仅在有到期学习条目时通知');
    // Nothing asks for notification permission before the status says it is missing.
    expect(markup).not.toContain('需要在 Edge 和系统里允许通知。');
    expect(markup).not.toContain('只影响之后的复习。');
    expect(markup).toContain('每日计划提醒');
    expect(markup).toContain('value="09:00"');
    expect(markup).toContain('包含到期复习数量');
    expect(markup).toContain('包含剩余任务数量');
    expect(markup).toContain('每天早上提醒今天的复习和待办数量。');
    expect(markup).toContain('发送每日计划测试');
    expect(markup).toContain('短期复习模式');
    expect(markup).toContain('标准');
    expect(markup).toContain('下次到期提醒');
    expect(markup).toContain('下次复习到期时通知');
    expect(markup).toContain('通知里显示到期数量');
  });

  it('opens the wardrobe from a button beside Backup and recovery', async () => {
    const onOpenWardrobe = vi.fn();
    await act(async () =>
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
          onOpenWardrobe={onOpenWardrobe}
        />,
      ),
    );

    const links = [...container.querySelectorAll('.settings-subpage-links button')];
    expect(links.map((button) => button.textContent)).toEqual(['备份与恢复', '衣橱']);
    await act(async () => findButton('衣橱')!.click());
    expect(onOpenWardrobe).toHaveBeenCalledTimes(1);
  });

  it('shows no wardrobe button when the dashboard offers no wardrobe', () => {
    const markup = renderToStaticMarkup(
      <SettingsView
        preferences={DEFAULT_PREFERENCES}
        onSaved={() => undefined}
        onOpenData={() => undefined}
      />,
    );

    expect(markup).toContain('备份与恢复');
    expect(markup).not.toContain('衣橱');
  });

  it('keeps the test action available while real reminders are disabled', () => {
    const markup = renderToStaticMarkup(
      <SettingsView
        preferences={{ ...DEFAULT_PREFERENCES, reminderEnabled: false }}
        onSaved={() => undefined}
        onOpenData={() => undefined}
      />,
    );

    expect(markup).toMatch(/type="time"[^>]*disabled=""/);
    expect(markup).toContain('发送测试通知');
    expect(markup).not.toMatch(/disabled=""[^>]*>发送测试通知/);
  });

  it('sends the isolated versioned test-reminder message and reports success', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'valrecall-test',
        getManifest: () => ({ version: '0.1.0' }),
        sendMessage,
      },
    });
    await act(async () => {
      root.render(
        <SettingsView
          preferences={{ ...DEFAULT_PREFERENCES, reminderEnabled: false }}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });

    await act(async () => {
      findButton('提醒')?.click();
      await Promise.resolve();
    });
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '发送测试通知',
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.sendTestReminder,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    expect(container.textContent).toContain('测试通知已发送。');
  });

  it('sends the separate Daily Plan test message and reports success', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'valrecall-test',
        getManifest: () => ({ version: '0.1.0' }),
        sendMessage,
      },
    });
    await act(async () => {
      root.render(
        <SettingsView
          preferences={{ ...DEFAULT_PREFERENCES, dailyPlanReminderEnabled: false }}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });

    act(() => findButton('每日计划')?.click());
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === '发送每日计划测试',
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(sendMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.sendTestDailyPlan,
      version: MESSAGE_PROTOCOL_VERSION,
    });
    expect(container.textContent).toContain('测试通知已发送。');
  });

  async function openRemindersWith(notificationPermission: string) {
    const sendMessage = vi.fn(async (message: { type: string }) =>
      message.type === MESSAGE_TYPES.getReminderStatus
        ? {
            ok: true,
            status: {
              nextReviewReminderAt: '2026-07-21T16:10:00.000Z',
              notificationPermission,
            },
          }
        : { ok: true },
    );
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'valrecall-test',
        getManifest: () => ({ version: '0.1.0' }),
        sendMessage,
      },
    });
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });

    await act(async () => {
      findButton('提醒')?.click();
      await Promise.resolve();
    });
    return sendMessage;
  }

  it('shows the next scheduled FSRS alarm and says nothing about a granted permission', async () => {
    const sendMessage = await openRemindersWith('granted');

    expect(container.textContent).not.toContain('通知权限');
    expect(container.textContent).not.toContain('需要在 Edge 和系统里允许通知。');
    expect(container.textContent).toContain('下次复习提醒：');
    expect(sendMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.getReminderStatus,
      version: MESSAGE_PROTOCOL_VERSION,
    });
  });

  it.each([
    ['denied', '通知权限：已在 Edge 或 Windows 中被阻止。'],
    ['unavailable', '通知权限：仅在已安装的 Edge 扩展中可用。'],
  ])('tells the person what to do when the permission is %s', async (permission, sentence) => {
    await openRemindersWith(permission);

    expect(container.textContent).toContain(sentence);
    expect(container.textContent).toContain('下次复习提醒：');
    expect(container.textContent).toContain('需要在 Edge 和系统里允许通知。');
  });

  it('credits every bundled font and links its licence', async () => {
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });
    act(() => findButton('高级')?.click());
    await act(async () => {
      findButton('显示高级选项')?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      '本产品使用霞鹜文楷（LXGW WenKai），SIL Open Font License 1.1。',
    );
    expect(container.textContent).toContain('本产品使用 MiSans 字体，由小米提供。');
    expect(container.textContent).toContain(
      '本产品使用思源黑体（Noto Sans SC），SIL Open Font License 1.1。',
    );
    const licences = [...container.querySelectorAll('dd a')];
    expect(licences.map((link) => link.getAttribute('href'))).toEqual([
      'fonts/LXGW-OFL.txt',
      'fonts/MiSans-LICENSE.pdf',
      'fonts/OFL.txt',
    ]);
    expect(licences.map((link) => link.textContent)).toEqual(['字体许可', '字体许可', '字体许可']);
  });

  it('changes categories without remounting the Settings view and moves heading focus', async () => {
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });
    const settingsView = container.querySelector('.settings-view');

    await act(async () => {
      findButton('提醒')?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('.settings-view')).toBe(settingsView);
    expect(findButton('提醒')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-settings-panel="general"]')?.hasAttribute('hidden')).toBe(
      true,
    );
    expect(document.activeElement?.textContent).toBe('下次到期提醒');
  });

  it('shows validation and saved confirmations as restrained state changes', async () => {
    vi.stubGlobal('chrome', { storage: { local: { set: vi.fn().mockResolvedValue(undefined) } } });
    const onSaved = vi.fn();
    await act(async () => {
      root.render(
        <SettingsView
          preferences={{ ...DEFAULT_PREFERENCES, reminderTime: 'invalid' }}
          onSaved={onSaved}
          onOpenData={() => undefined}
        />,
      );
    });

    act(() => findButton('保存设置')?.click());
    expect(container.textContent).toContain('请选择有效的每日提醒时间。');
    expect(container.querySelector('.motion-state-change .notice')).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={onSaved}
          onOpenData={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      findButton('保存设置')?.click();
      await Promise.resolve();
    });
    expect(onSaved).toHaveBeenCalledWith(DEFAULT_PREFERENCES);
    expect(container.textContent).toContain('已保存。');
  });

  it('expands advanced options and restores focus when they collapse', async () => {
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });

    act(() => findButton('高级')?.click());
    expect(container.querySelector('#settings-advanced-content')).toBeNull();
    act(() => findButton('显示高级选项')?.click());
    expect(container.textContent).toContain('排程诊断');
    const dataHeading = [...container.querySelectorAll('h3')].find(
      (heading) => heading.textContent === '排程诊断',
    );
    dataHeading?.focus();

    act(() => findButton('隐藏高级选项')?.click());

    expect(container.querySelector('#settings-advanced-content')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(document.activeElement?.textContent).toBe('显示高级选项');
  });

  it('shows read-only diagnostics for the most recently reviewed local card', async () => {
    const service = new FsrsService();
    const reviewedAt = new Date('2026-07-21T12:00:00.000Z');
    const scheduled = service.schedule(
      service.createInitialCard(reviewedAt),
      Rating.Good,
      reviewedAt,
    );
    const diagnosticLoader = vi.fn(async () => ({
      itemId: 'diagnostic-card',
      card: scheduled.card,
      latestRating: Rating.Good,
      latestLog: scheduled.log,
      configuration: service.getConfiguration(),
    }));
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
          diagnosticLoader={diagnosticLoader}
        />,
      );
    });

    act(() => findButton('高级')?.click());
    await act(async () => {
      findButton('显示高级选项')?.click();
      await Promise.resolve();
    });

    expect(diagnosticLoader).toHaveBeenCalledWith('standard');
    expect(container.textContent).toContain('排程诊断');
    expect(container.textContent).toContain('diagnostic-card');
    expect(container.textContent).toContain('FSRS-6.0');
    expect(container.textContent).toContain('Good');
    expect(container.querySelector('.scheduling-diagnostic input')).toBeNull();
  });

  it('changes category immediately without shared-element motion in reduced motion', async () => {
    const startViewTransition = vi.fn();
    Object.assign(document, { startViewTransition });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    await act(async () => {
      root.render(
        <SettingsView
          preferences={DEFAULT_PREFERENCES}
          onSaved={() => undefined}
          onOpenData={() => undefined}
        />,
      );
    });

    await act(async () => {
      findButton('提醒')?.click();
      await Promise.resolve();
    });

    expect(startViewTransition).not.toHaveBeenCalled();
    expect(findButton('提醒')?.getAttribute('aria-selected')).toBe('true');
  });

  function findButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }
});
