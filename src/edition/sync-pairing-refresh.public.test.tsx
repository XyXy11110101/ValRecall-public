import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncSettings, type SyncSettingsProps } from '../dashboard/SyncSettings';
import type { NativeHostStatus, SyncControlResponse } from '../sync/native-bridge';
import { emptyNativeDiagnosticReport } from '../sync/native-diagnostics';

// Only in the public repository: it checks an effect the export adds to the sync settings.
vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const start = new Date('2026-10-13T12:00:00.000Z');
const FIVE_MINUTES = 5 * 60_000;

function unpaired(expiresInMs = FIVE_MINUTES): NativeHostStatus {
  return {
    serverId: 'desktop',
    paired: false,
    addresses: ['192.168.1.2'],
    port: 19284,
    pairing: {
      version: 1,
      serverId: 'desktop',
      host: '192.168.1.2',
      port: 19284,
      fingerprint: 'a'.repeat(64),
      secret: 's'.repeat(43),
      expiresAt: new Date(start.getTime() + expiresInMs).toISOString(),
    },
  };
}
const paired: NativeHostStatus = {
  serverId: 'desktop',
  paired: true,
  addresses: ['192.168.1.2'],
  port: 19284,
};
const connected = (status: NativeHostStatus): SyncControlResponse => ({
  version: 1,
  ok: true,
  state: { enabled: true, connected: true, status },
});
const failed: SyncControlResponse = {
  version: 1,
  ok: false,
  state: { enabled: true, connected: false, status: null },
  error: 'should not be shown',
};

describe('phone pairing page refresh, public edition', () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    unmount();
    container.remove();
    vi.useRealTimers();
  });

  function unmount() {
    if (mounted) act(() => root.unmount());
    mounted = false;
  }

  async function render(driver: NonNullable<SyncSettingsProps['driver']>) {
    await act(async () => root.render(<SyncSettings driver={driver} />));
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function statusLine() {
    return container.querySelector('[role="status"]')?.textContent;
  }

  function qr() {
    return container.querySelector('svg[aria-label="手机配对二维码"]');
  }

  function button(text: string) {
    const found = [...container.querySelectorAll('button')].find(
      (entry) => entry.textContent === text,
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  }

  it('updates when the driver reports paired, and tells the user it will', async () => {
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockResolvedValueOnce(connected(unpaired()))
      .mockResolvedValue(connected(paired));
    await render(driver);
    expect(qr()).not.toBeNull();
    expect(container.textContent).toContain('手机完成配对后，这里会自动更新。');
    expect(container.textContent).not.toContain('查看结果');

    await advance(3_000);
    expect(driver).toHaveBeenCalledTimes(2);
    expect(driver).toHaveBeenLastCalledWith('status');
    expect(qr()).not.toBeNull();

    await advance(3_000);
    expect(statusLine()).toBe('已配对手机');
    expect(qr()).toBeNull();
  });

  it('stops asking once the phone has paired', async () => {
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockResolvedValue(connected(paired));
    await render(driver);
    await advance(3_000);
    expect(driver).toHaveBeenCalledTimes(2);

    await advance(60_000);
    expect(driver).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops asking on unmount', async () => {
    const driver = vi.fn().mockResolvedValue(connected(unpaired()));
    await render(driver);
    await advance(3_000);
    expect(driver).toHaveBeenCalledTimes(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(driver).toHaveBeenCalledTimes(2);
  });

  it('stops at the limit even if the code has not expired', async () => {
    const driver = vi.fn().mockResolvedValue(connected(unpaired(60 * 60_000)));
    await render(driver);

    await advance(100 * 3_000);
    expect(driver).toHaveBeenCalledTimes(101);
    await advance(10 * 3_000);
    expect(driver).toHaveBeenCalledTimes(101);
  });

  it('stops when the code expires', async () => {
    const driver = vi.fn().mockResolvedValue(connected(unpaired(10_000)));
    await render(driver);

    // In small steps, because React only renders between them.
    for (let second = 0; second < 30; second += 1) await advance(1_000);
    expect(driver).toHaveBeenCalledTimes(4);
    expect(container.textContent).toContain('二维码已过期');
  });

  it('does not ask when no code is showing', async () => {
    const driver = vi.fn().mockResolvedValue(connected({ ...paired, paired: false }));
    await render(driver);

    await advance(30_000);
    expect(driver).toHaveBeenCalledTimes(1);
    expect(statusLine()).toBe('已连接，未配对手机');
  });

  it('shows nothing for a failed answer and keeps asking', async () => {
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockResolvedValueOnce(failed)
      .mockRejectedValueOnce(new Error('private error'))
      .mockResolvedValue(connected(paired));
    await render(driver);

    await advance(3_000);
    expect(container.querySelector('.notice')).toBeNull();
    expect(qr()).not.toBeNull();
    expect(statusLine()).toBe('已连接，未配对手机');

    await advance(3_000);
    expect(container.querySelector('.notice')).toBeNull();
    expect(container.textContent).not.toContain('private error');

    await advance(3_000);
    expect(statusLine()).toBe('已配对手机');
  });

  it('skips a round while a command from the user is running', async () => {
    let finish!: (response: SyncControlResponse) => void;
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockImplementationOnce(
        () =>
          new Promise<SyncControlResponse>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(connected(unpaired()));
    await render(driver);

    await act(async () => button('刷新同步状态').click());
    expect(driver).toHaveBeenCalledTimes(2);
    await advance(9_000);
    expect(driver).toHaveBeenCalledTimes(2);

    await act(async () => finish(connected(unpaired())));
    await advance(3_000);
    expect(driver).toHaveBeenCalledTimes(3);
  });

  it('lets a command from the user win over an answer still on its way', async () => {
    let finishRound!: (response: SyncControlResponse) => void;
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockImplementationOnce(
        () =>
          new Promise<SyncControlResponse>((resolve) => {
            finishRound = resolve;
          }),
      )
      .mockResolvedValue(connected(paired));
    await render(driver);

    await advance(3_000);
    await act(async () => button('刷新同步状态').click());
    expect(statusLine()).toBe('已配对手机');

    await act(async () => finishRound(connected(unpaired())));
    expect(statusLine()).toBe('已配对手机');
    expect(qr()).toBeNull();
  });

  it('does not start another round while one is unanswered', async () => {
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockImplementation(() => new Promise(() => undefined));
    await render(driver);

    await advance(30_000);
    expect(driver).toHaveBeenCalledTimes(2);
  });

  it('keeps a code on screen in the same address and keeps the diagnostic report', async () => {
    const report = emptyNativeDiagnosticReport();
    report.checks.permission = 'passed';
    const driver = vi
      .fn()
      .mockResolvedValueOnce(connected(unpaired()))
      .mockResolvedValueOnce({
        ...connected(unpaired()),
        state: { ...connected(unpaired()).state, diagnostics: report },
      })
      .mockResolvedValue(connected(unpaired()));
    await render(driver);

    await act(async () => button('检查连接').click());
    expect(container.querySelector('#valrecall-native-diagnostic-report')).not.toBeNull();

    await advance(3_000);
    expect(driver).toHaveBeenCalledTimes(3);
    expect(container.querySelector('#valrecall-native-diagnostic-report')).not.toBeNull();
    expect(qr()).not.toBeNull();
  });
});
