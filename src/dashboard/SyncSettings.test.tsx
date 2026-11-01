import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncSettings } from './SyncSettings';
import type { NativeHostStatus, SyncControlResponse } from '../sync/native-bridge';
import { emptyNativeDiagnosticReport } from '../sync/native-diagnostics';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hostStatus: NativeHostStatus = {
  serverId: 'desktop',
  paired: false,
  addresses: ['192.168.1.2', '10.0.0.2'],
  port: 19284,
};
const off: SyncControlResponse = {
  version: 1,
  ok: true,
  state: { enabled: false, connected: false, status: null },
};
const connected = (status = hostStatus): SyncControlResponse => ({
  version: 1,
  ok: true,
  state: { enabled: true, connected: true, status },
});

describe('Android local sync settings', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: { id: 'extension' },
      permissions: { request: vi.fn(async () => true) },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function status(): string | null | undefined {
    return container.querySelector('[role="status"]')?.textContent;
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent === text,
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }

  it('starts with a read-only status request and explicitly enables local sync', async () => {
    const driver = vi.fn().mockResolvedValueOnce(off).mockResolvedValue(connected());
    await act(async () => root.render(<SyncSettings driver={driver} />));
    expect(driver).toHaveBeenCalledExactlyOnceWith('status');
    expect(container.textContent).not.toContain('Wi-Fi');
    expect(status()).toBe('未启用');
    expect(button('生成配对二维码').disabled).toBe(true);
    await act(async () => button('启用手机同步').click());
    expect(driver).toHaveBeenLastCalledWith('enable');
    expect(status()).toBe('已连接，未配对手机');
    expect(button('生成配对二维码').disabled).toBe(false);
  });

  it('says the remaining sync states in a few words', async () => {
    let finish!: (response: SyncControlResponse) => void;
    const driver = vi.fn(
      () =>
        new Promise<SyncControlResponse>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => root.render(<SyncSettings driver={driver} />));
    expect(status()).toBe('正在读取…');
    await act(async () =>
      finish({ ...off, state: { enabled: true, connected: false, status: null } }),
    );
    expect(status()).toBe('等待同步助手连接');
    await act(async () => {
      button('刷新同步状态').click();
    });
    await act(async () => finish(connected({ ...hostStatus, paired: true })));
    expect(status()).toBe('已配对手机');
  });

  it('checks the connection only on request and exposes a safe timestamped report without enabling', async () => {
    const report = emptyNativeDiagnosticReport();
    report.checks.permission = 'passed';
    report.checks.discovery = 'failed';
    report.errorCode = 'SYNC-HOST-NOT-FOUND';
    const driver = vi
      .fn()
      .mockResolvedValueOnce(off)
      .mockResolvedValue({
        version: 1,
        ok: false,
        state: { ...off.state, diagnostics: report },
        error: '助手清单未找到。',
      } satisfies SyncControlResponse);
    const permission = vi.fn(async () => true);
    await act(async () =>
      root.render(<SyncSettings driver={driver} requestPermission={permission} />),
    );
    expect(driver).toHaveBeenCalledExactlyOnceWith('status');
    await act(async () => button('检查连接').click());
    expect(driver).toHaveBeenLastCalledWith('diagnose');
    expect(permission).not.toHaveBeenCalled();
    expect(button('启用手机同步').disabled).toBe(false);
    expect(button('生成配对二维码').disabled).toBe(true);
    expect(container.textContent).toContain('助手发现：未通过');
    expect(container.textContent).toContain('手机连接：未验证');
    const text = container.querySelector<HTMLTextAreaElement>(
      '#valrecall-native-diagnostic-report',
    )!.value;
    expect(text).toContain(report.checkedAt);
    expect(text).toContain('SYNC-HOST-NOT-FOUND');
    expect(text).toContain('最近手机请求：');
  });

  it('generates a local QR, changes address and removes it when expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    const status: NativeHostStatus = {
      ...hostStatus,
      pairing: {
        version: 1,
        serverId: 'desktop',
        host: '192.168.1.2',
        port: 19284,
        fingerprint: 'a'.repeat(64),
        secret: 's'.repeat(43),
        expiresAt: '2026-10-13T12:05:00.000Z',
      },
    };
    const driver = vi.fn().mockResolvedValueOnce(connected()).mockResolvedValue(connected(status));
    await act(async () => root.render(<SyncSettings driver={driver} />));
    await act(async () => button('生成配对二维码').click());
    const svg = container.querySelector('svg[aria-label="手机配对二维码"]');
    expect(svg).not.toBeNull();
    const original = svg?.querySelector('path')?.getAttribute('d');
    expect(container.innerHTML).not.toContain(status.pairing?.secret);
    expect(container.querySelector('img')).toBeNull();
    const select = container.querySelector('select')!;
    act(() => {
      select.value = '10.0.0.2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('svg path')?.getAttribute('d')).not.toBe(original);
    const details = container.querySelector('details')!;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    const fallback = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="一次性配对码"]',
    )!;
    expect(fallback.readOnly).toBe(true);
    expect(JSON.parse(fallback.value)).toEqual({ ...status.pairing, host: '10.0.0.2' });
    await act(async () => vi.advanceTimersByTimeAsync(300_001));
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).toContain('二维码已过期');
  });

  it('asks before unpairing and keeps existing state on cancellation', async () => {
    const driver = vi.fn().mockResolvedValue(connected({ ...hostStatus, paired: true }));
    const confirmAction = vi.fn(() => false);
    await act(async () =>
      root.render(<SyncSettings driver={driver} confirmAction={confirmAction} />),
    );
    expect(button('生成配对二维码').disabled).toBe(true);
    await act(async () => button('解除手机配对').click());
    expect(driver).toHaveBeenCalledTimes(1);
    expect(confirmAction).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('解除配对'));
    confirmAction.mockReturnValue(true);
    await act(async () => button('解除手机配对').click());
    expect(driver).toHaveBeenLastCalledWith('revoke');
  });

  it('closes phone sync without asking', async () => {
    const driver = vi.fn().mockResolvedValueOnce(connected()).mockResolvedValue(off);
    const confirmAction = vi.fn(() => false);
    await act(async () =>
      root.render(<SyncSettings driver={driver} confirmAction={confirmAction} />),
    );
    await act(async () => button('关闭手机同步').click());
    expect(confirmAction).not.toHaveBeenCalled();
    expect(driver).toHaveBeenLastCalledWith('disable');
    expect(status()).toBe('未启用');
    expect(button('启用手机同步').disabled).toBe(false);
  });

  it('serializes rapid actions and exposes a recoverable connection failure', async () => {
    let finish!: (response: SyncControlResponse) => void;
    const driver = vi
      .fn()
      .mockResolvedValueOnce(off)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    await act(async () => root.render(<SyncSettings driver={driver} />));
    await act(async () => {
      button('启用手机同步').click();
      button('启用手机同步').click();
    });
    expect(driver).toHaveBeenCalledTimes(2);
    expect(button('启用手机同步').disabled).toBe(true);
    await act(async () =>
      finish({
        version: 1,
        ok: false,
        state: { enabled: true, connected: false, status: null },
        error: '无法连接 Windows 同步助手。',
      }),
    );
    expect(container.textContent).toContain('无法连接 Windows 同步助手');
    // A decorative, still worried head in today's outfit leads the error.
    const worried = container.querySelector('.notice img.companion-worried-face');
    expect(worried?.getAttribute('src')).toMatch(
      /^assets\/companion\/chibi\/[a-z0-9]+\/head-worried\.svg$/,
    );
    expect(worried?.getAttribute('aria-hidden')).toBe('true');
    expect(button('关闭手机同步').disabled).toBe(false);
    expect(button('生成配对二维码').disabled).toBe(true);
  });

  it('reports missing installation and empty LAN interfaces without showing a QR', async () => {
    const driver = vi
      .fn()
      .mockRejectedValueOnce(new Error('private error'))
      .mockResolvedValue(connected({ ...hostStatus, addresses: [] }));
    await act(async () => root.render(<SyncSettings driver={driver} />));
    expect(container.textContent).toContain('请确认已安装 Windows 同步助手');
    expect(container.textContent).not.toContain('private error');
    await act(async () => button('刷新同步状态').click());
    expect(container.textContent).toContain('没有找到局域网地址');
    expect(button('生成配对二维码').disabled).toBe(true);
  });

  it('requests native messaging only from enable and respects a declined permission', async () => {
    const driver = vi.fn().mockResolvedValue(off);
    const requestPermission = vi.fn(async () => false);
    await act(async () =>
      root.render(<SyncSettings driver={driver} requestPermission={requestPermission} />),
    );
    expect(requestPermission).not.toHaveBeenCalled();
    act(() => button('启用手机同步').click());
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await act(async () => Promise.resolve());
    expect(driver).toHaveBeenCalledExactlyOnceWith('status');
    expect(container.textContent).toContain('没有授权');
    expect(button('启用手机同步').disabled).toBe(false);
  });
});
