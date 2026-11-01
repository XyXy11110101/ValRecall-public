import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkNativeConnection,
  connectedNativeDiagnosticReport,
  emptyNativeDiagnosticReport,
  isNativeDiagnosticReport,
} from './native-diagnostics';
import { isNativeHostStatus, type NativeSyncPort } from './native-bridge';

function event<T>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
  };
}

function fixture() {
  const onMessage = event<(value: unknown) => void>();
  const onDisconnect = event<() => void>();
  const port: NativeSyncPort = {
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage: vi.fn(() =>
      queueMicrotask(() =>
        onMessage.listeners.forEach((listener) =>
          listener({
            version: 1,
            id: 'connection-check',
            type: 'result',
            ok: false,
            error: 'Enable phone sync in ValRecall before pairing.',
          }),
        ),
      ),
    ),
  };
  return {
    port,
    onMessage,
    onDisconnect,
    dependencies: {
      connect: vi.fn(() => port),
      hasPermission: vi.fn(async () => true),
      consumeLastError: vi.fn((): unknown => undefined),
      isStatus: isNativeHostStatus,
      timeoutMs: 50,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('status-only native diagnostic probe', () => {
  it('uses the installed uninitialized helper without init, pairing, data or preferences', async () => {
    const test = fixture();
    const report = await checkNativeConnection(test.dependencies);
    expect(isNativeDiagnosticReport(report)).toBe(true);
    expect(report).toMatchObject({
      errorCode: null,
      phoneSeenAt: null,
      checks: {
        permission: 'passed',
        discovery: 'passed',
        launch: 'passed',
        handshake: 'passed',
        lan: 'unknown',
        phone: 'unknown',
      },
    });
    expect(test.port.postMessage).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      id: 'connection-check',
      type: 'status',
      payload: {},
    });
    expect(test.dependencies.connect).toHaveBeenCalledTimes(1);
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    expect(test.onMessage.listeners.size + test.onDisconnect.listeners.size).toBe(0);
  });

  it('does not connect or request permission when permission is absent', async () => {
    const test = fixture();
    test.dependencies.hasPermission.mockResolvedValue(false);
    expect(await checkNativeConnection(test.dependencies)).toMatchObject({
      errorCode: 'SYNC-PERMISSION',
      checks: { permission: 'failed', discovery: 'unknown' },
    });
    expect(test.dependencies.connect).not.toHaveBeenCalled();
  });

  it.each([
    ['Specified native messaging host not found.', 'SYNC-HOST-NOT-FOUND', 'failed', 'unknown'],
    ['Failed to start native messaging host.', 'SYNC-HOST-START', 'passed', 'failed'],
    ['Native host has exited.', 'SYNC-HOST-EXIT', 'passed', 'passed'],
    [
      'Access to the specified native messaging host is forbidden.',
      'SYNC-HOST-DENIED',
      'unknown',
      'unknown',
    ],
  ])(
    'classifies %s without misreporting later stages or leaking browser details',
    async (message, code, discovery, launch) => {
      const test = fixture();
      test.dependencies.consumeLastError.mockReturnValue({
        message: `${message} PRIVATE_PATH_TOKEN`,
      });
      vi.mocked(test.port.postMessage).mockImplementation(() =>
        queueMicrotask(() => test.onDisconnect.listeners.forEach((listener) => listener())),
      );
      const report = await checkNativeConnection(test.dependencies);
      expect(report).toMatchObject({
        errorCode: code,
        checks: { discovery, launch, lan: 'unknown', phone: 'unknown' },
      });
      expect(test.dependencies.consumeLastError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(report)).not.toContain('PRIVATE_PATH_TOKEN');
      expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds a silent process to one attempt and clears timers/listeners', async () => {
    vi.useFakeTimers();
    const test = fixture();
    vi.mocked(test.port.postMessage).mockImplementation(() => undefined);
    const work = checkNativeConnection(test.dependencies);
    await vi.runAllTimersAsync();
    expect(await work).toMatchObject({
      errorCode: 'SYNC-TIMEOUT',
      checks: { discovery: 'unknown', launch: 'unknown', handshake: 'failed' },
    });
    expect(test.dependencies.connect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(test.onMessage.listeners.size + test.onDisconnect.listeners.size).toBe(0);
  });

  it('cancels an owned probe without leaving a native process or timer', async () => {
    vi.useFakeTimers();
    const test = fixture();
    const abort = new AbortController();
    vi.mocked(test.port.postMessage).mockImplementation(() => undefined);
    const work = checkNativeConnection({ ...test.dependencies, signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    expect(await work).toMatchObject({ errorCode: 'SYNC-UNKNOWN' });
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a process after cancellation during the permission check', async () => {
    const test = fixture();
    const abort = new AbortController();
    abort.abort();
    expect(
      await checkNativeConnection({ ...test.dependencies, signal: abort.signal }),
    ).toMatchObject({ errorCode: 'SYNC-UNKNOWN' });
    expect(test.dependencies.connect).not.toHaveBeenCalled();
  });

  it('closes the owned process even if listener setup fails', async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.port.onMessage.addListener = () => {
      throw new Error('private failure');
    };
    const report = await checkNativeConnection(test.dependencies);
    expect(report.errorCode).toBe('SYNC-UNKNOWN');
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(report)).not.toContain('private failure');
  });

  it.each([
    { version: 2, id: 'connection-check', type: 'result', ok: true },
    { version: 1, id: 'wrong-id', type: 'result', ok: false, error: 'private' },
    {
      version: 1,
      id: 'connection-check',
      type: 'result',
      ok: true,
      payload: { addresses: ['8.8.8.8'] },
    },
    { version: 1, id: 'connection-check', type: 'result', ok: false, error: 'x'.repeat(900_000) },
  ])('rejects malformed or oversized response without claiming a handshake', async (value) => {
    const test = fixture();
    vi.mocked(test.port.postMessage).mockImplementation(() =>
      queueMicrotask(() => test.onMessage.listeners.forEach((listener) => listener(value))),
    );
    expect(await checkNativeConnection(test.dependencies)).toMatchObject({
      errorCode: 'SYNC-PROTOCOL',
      checks: { handshake: 'failed', lan: 'unknown' },
    });
  });

  it('retains only a safe category for unknown helper refusals', async () => {
    const test = fixture();
    vi.mocked(test.port.postMessage).mockImplementation(() =>
      queueMicrotask(() =>
        test.onMessage.listeners.forEach((listener) =>
          listener({
            version: 1,
            id: 'connection-check',
            type: 'result',
            ok: false,
            error: 'private path and token',
          }),
        ),
      ),
    );
    const report = await checkNativeConnection(test.dependencies);
    expect(report).toMatchObject({
      errorCode: 'SYNC-HOST-REQUEST',
      checks: { handshake: 'passed', lan: 'unknown' },
    });
    expect(JSON.stringify(report)).not.toContain('private');
  });

  it('does not confuse paired state or LAN listening with a phone exchange', () => {
    const report = connectedNativeDiagnosticReport(
      { serverId: 'pc', paired: true, addresses: ['192.168.1.2'], port: 19284 },
      null,
    );
    expect(report.checks).toMatchObject({ lan: 'passed', phone: 'unknown' });
    expect(isNativeDiagnosticReport(report)).toBe(true);
    expect(
      connectedNativeDiagnosticReport(
        { serverId: 'pc', paired: false, addresses: [], port: 19284 },
        null,
      ).checks.lan,
    ).toBe('failed');
  });

  it('validates all cross-context report fields, rejects extras and inconsistent evidence', () => {
    const original = emptyNativeDiagnosticReport();
    expect(isNativeDiagnosticReport(original)).toBe(true);
    for (const patch of [
      { secret: 'private' },
      { version: 2 },
      { checkedAt: 'invalid' },
      { errorCode: 'injected' },
      { checks: { ...original.checks, phone: 'passed' } },
      { checks: { ...original.checks, handshake: 'passed' } },
      { checks: { ...original.checks, token: 'private' } },
      { checks: { ...original.checks, launch: { toString: null } } },
    ])
      expect(isNativeDiagnosticReport({ ...original, ...patch })).toBe(false);
  });
});
