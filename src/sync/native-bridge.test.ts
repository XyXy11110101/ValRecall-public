import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  NativeSyncController,
  NATIVE_SYNC_HOST,
  NATIVE_SYNC_MAX_BYTES,
  SYNC_CONTROL_TYPE,
  isNativeHostStatus,
  isPairingCode,
  registerNativeSyncRuntime,
  sendSyncControl,
  type NativeSyncDependencies,
  type NativeSyncPort,
  type NativeSyncRuntimeApi,
} from './native-bridge';
import { loadSyncEnabled, SYNC_ENABLED_STORAGE_KEY } from './settings';

const hostStatus = {
  serverId: 'server-one',
  paired: false,
  addresses: ['192.168.1.2'],
  port: 19284,
};
const pairing = {
  version: 1,
  serverId: 'server-one',
  host: '192.168.1.2',
  port: 19284,
  fingerprint: 'a'.repeat(64),
  secret: 's'.repeat(43),
  expiresAt: '2026-10-13T12:05:00.000Z',
};

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

function fixture(enabled = false, reply = true) {
  const onMessage = event<(message: unknown) => void>();
  const onDisconnect = event<() => void>();
  const emit = (message: unknown) => onMessage.listeners.forEach((listener) => listener(message));
  const port: NativeSyncPort = {
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage: vi.fn((message: unknown) => {
      const request = message as { id: string; type: string };
      if (reply && request.type !== 'result')
        queueMicrotask(() =>
          emit({
            version: 1,
            id: request.id,
            type: 'result',
            ok: true,
            payload: request.type === 'pairing.start' ? { ...hostStatus, pairing } : hostStatus,
          }),
        );
    }),
  };
  const dependencies: NativeSyncDependencies = {
    storage: {
      get: vi.fn(async () => ({ [SYNC_ENABLED_STORAGE_KEY]: enabled })),
      set: vi.fn(async () => undefined),
    },
    connect: vi.fn(() => port),
    getEpoch: vi.fn(async () => 'epoch-one'),
    onSync: vi.fn(async () => ({ applied: true })),
    consumeLastError: vi.fn(),
    timeoutMs: 50,
    retryDelayMs: 10,
  };
  return {
    dependencies,
    port,
    emit,
    onDisconnect,
    controller: new NativeSyncController(dependencies),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opt-in native bridge', () => {
  it('runs an explicit diagnostic without enabling sync, touching the ledger or saving preferences', async () => {
    const test = fixture();
    await test.controller.start();
    const result = await test.controller.control('diagnose');
    expect(result).toMatchObject({
      ok: true,
      state: {
        enabled: false,
        connected: false,
        status: null,
        diagnostics: { checks: { handshake: 'passed', phone: 'unknown' } },
      },
    });
    expect(test.dependencies.getEpoch).not.toHaveBeenCalled();
    expect(test.dependencies.onSync).not.toHaveBeenCalled();
    expect(test.dependencies.storage.set).not.toHaveBeenCalled();
    expect(test.port.postMessage).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      id: 'connection-check',
      type: 'status',
      payload: {},
    });
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    test.controller.stop();
  });

  it('reuses a connected port for diagnostics without refreshing the epoch or changing pairing', async () => {
    const test = fixture(true);
    await test.controller.start();
    vi.mocked(test.dependencies.getEpoch).mockClear();
    vi.mocked(test.port.postMessage).mockClear();
    const result = await test.controller.control('diagnose');
    expect(result.state.diagnostics?.checks.handshake).toBe('passed');
    expect(test.dependencies.connect).toHaveBeenCalledTimes(1);
    expect(test.dependencies.getEpoch).not.toHaveBeenCalled();
    expect(test.dependencies.storage.set).not.toHaveBeenCalled();
    expect(test.port.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'status', payload: {} }),
    );
    expect(test.port.disconnect).not.toHaveBeenCalled();
    test.controller.stop();
  });

  it('cancels an in-flight diagnostic when disposed and never starts data work', async () => {
    vi.useFakeTimers();
    const test = fixture(false, false);
    const work = test.controller.control('diagnose');
    await Promise.resolve();
    await Promise.resolve();
    test.controller.stop();
    const result = await work;
    expect(result.ok).toBe(false);
    expect(test.dependencies.getEpoch).not.toHaveBeenCalled();
    expect(test.dependencies.onSync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Specified native messaging host not found.', 'SYNC-HOST-NOT-FOUND'],
    ['Access to the specified native messaging host is forbidden.', 'SYNC-HOST-DENIED'],
    ['Failed to start native messaging host.', 'SYNC-HOST-START'],
    ['Native host has exited.', 'SYNC-HOST-EXIT'],
    ['Error when communicating with the native messaging host.', 'SYNC-PROTOCOL'],
  ])('reports a sanitized disconnect category for %s', async (message, code) => {
    const test = fixture(false, false);
    test.dependencies.retryDelayMs = 0;
    test.dependencies.consumeLastError = vi.fn(() => ({ message: `${message} private-value` }));
    vi.mocked(test.port.postMessage).mockImplementation(() => {
      queueMicrotask(() => [...test.onDisconnect.listeners].forEach((listener) => listener()));
    });
    const result = await test.controller.control('enable');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(code);
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(test.dependencies.connect).toHaveBeenCalledTimes(3);
    test.controller.stop();
  });

  it('distinguishes missing permission from local data failure without exposing details', async () => {
    for (const mode of ['permission', 'data'] as const) {
      const test = fixture();
      test.dependencies.retryDelayMs = 0;
      if (mode === 'permission') test.dependencies.hasPermission = vi.fn(async () => false);
      else
        vi.mocked(test.dependencies.getEpoch).mockRejectedValue(
          new Error('private ledger details'),
        );
      const result = await test.controller.control('enable');
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toContain(mode === 'permission' ? 'SYNC-PERMISSION' : 'SYNC-DATA');
      expect(JSON.stringify(result)).not.toContain('private ledger details');
      expect(test.dependencies.connect).not.toHaveBeenCalled();
      test.controller.stop();
    }
  });

  it('keeps unknown native failures generic and never returns arbitrary error strings', async () => {
    const test = fixture();
    test.dependencies.retryDelayMs = 0;
    vi.mocked(test.dependencies.connect).mockImplementation(() => {
      throw new Error('private local path or token');
    });
    const result = await test.controller.control('enable');
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private local path or token');
    test.controller.stop();
  });

  it('reinitializes a connected host after database restore before allowing new pairing', async () => {
    const test = fixture(true);
    await test.controller.start();
    vi.mocked(test.dependencies.getEpoch).mockResolvedValue('restored-epoch');
    const result = await test.controller.control('pair');
    expect(result.ok).toBe(true);
    const commands = vi.mocked(test.port.postMessage).mock.calls.map(([message]) => message);
    expect(commands).toContainEqual(
      expect.objectContaining({ type: 'init', payload: { epoch: 'restored-epoch' } }),
    );
    expect(commands.at(-1)).toMatchObject({ type: 'pairing.start' });
    expect(test.dependencies.connect).toHaveBeenCalledTimes(1);
    test.controller.stop();
  });
  it('does not start a native process when the setting is missing, invalid or disabled', async () => {
    for (const value of [undefined, null, 'true', 1, false]) {
      expect(
        await loadSyncEnabled({
          get: async () => ({ [SYNC_ENABLED_STORAGE_KEY]: value }),
          set: async () => undefined,
        }),
      ).toBe(false);
    }
    const test = fixture();
    await test.controller.start();
    expect((await test.controller.control('status')).state.enabled).toBe(false);
    expect(test.dependencies.connect).not.toHaveBeenCalled();
    test.controller.stop();
  });

  it('persists only the enabled preference and initializes before exposing the connection', async () => {
    const test = fixture();
    await test.controller.start();
    const result = await test.controller.control('enable');
    expect(result.ok).toBe(true);
    expect(result.state.connected).toBe(true);
    expect(test.dependencies.storage.set).toHaveBeenCalledExactlyOnceWith({
      [SYNC_ENABLED_STORAGE_KEY]: true,
    });
    expect(test.port.postMessage).toHaveBeenNthCalledWith(1, {
      version: 1,
      id: 'extension-1',
      type: 'init',
      payload: { epoch: 'epoch-one' },
    });
    const paired = await test.controller.control('pair');
    expect(paired.state.status?.pairing).toEqual(pairing);
    expect(test.dependencies.storage.set).toHaveBeenCalledTimes(1);
    const disabled = await test.controller.control('disable');
    expect(disabled.state).toEqual({ enabled: false, connected: false, status: null });
    expect(test.dependencies.storage.set).toHaveBeenLastCalledWith({
      [SYNC_ENABLED_STORAGE_KEY]: false,
    });
    expect(test.port.disconnect).toHaveBeenCalledTimes(1);
    test.controller.stop();
  });

  it('never starts a process if opt-in cannot be saved', async () => {
    const test = fixture();
    vi.mocked(test.dependencies.storage.set).mockRejectedValue(new Error('disk failure'));
    expect((await test.controller.control('enable')).ok).toBe(false);
    expect(test.dependencies.connect).not.toHaveBeenCalled();
    expect(test.controller.getState().enabled).toBe(false);
  });

  it('does not connect or retry when optional native messaging permission is missing', async () => {
    const test = fixture(true);
    test.dependencies.hasPermission = vi.fn(async () => false);
    await expect(test.controller.start()).rejects.toThrow();
    expect(test.dependencies.connect).not.toHaveBeenCalled();
    expect(test.dependencies.hasPermission).toHaveBeenCalledTimes(1);
    test.controller.stop();
  });

  it('limits unresponsive host attempts and clears every timeout', async () => {
    vi.useFakeTimers();
    const test = fixture(true, false);
    const result = test.controller.start().catch(() => 'failed');
    await vi.runAllTimersAsync();
    expect(await result).toBe('failed');
    expect(test.dependencies.connect).toHaveBeenCalledTimes(3);
    expect(test.controller.getState().connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    test.controller.stop();
  });

  it('uses a finite recovery budget after unexpected disconnects', async () => {
    const test = fixture(true);
    await test.controller.start();
    for (let count = 0; count < 5; count += 1) {
      [...test.onDisconnect.listeners].forEach((listener) => listener());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(test.dependencies.connect).toHaveBeenCalledTimes(3);
    expect(test.controller.getState().connected).toBe(false);
    test.controller.stop();
  });

  it('routes a validated native sync envelope and never exposes handler failures', async () => {
    const test = fixture(true);
    await test.controller.start();
    const payload = { version: 1, deviceId: 'phone-one', request: { operation: 'probe' } };
    test.emit({ version: 1, id: 'phone-request', type: 'sync', payload });
    await Promise.resolve();
    expect(test.dependencies.onSync).toHaveBeenCalledWith(payload);
    expect(test.port.postMessage).toHaveBeenLastCalledWith({
      version: 1,
      id: 'phone-request',
      type: 'result',
      ok: true,
      payload: { applied: true },
    });
    vi.mocked(test.dependencies.onSync).mockRejectedValueOnce(new Error('private handler details'));
    test.emit({ version: 1, id: 'failed-request', type: 'sync', payload });
    await Promise.resolve();
    expect(test.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'failed-request', ok: false }),
    );
    expect(JSON.stringify(vi.mocked(test.port.postMessage).mock.calls)).not.toContain(
      'private handler details',
    );
    test.controller.stop();
  });

  it('fails closed on oversized or malformed native input without passing it to data handlers', async () => {
    for (const payload of [
      { version: 2, deviceId: 'phone', request: {} },
      { version: 1, deviceId: 'phone', request: 'x'.repeat(NATIVE_SYNC_MAX_BYTES) },
    ]) {
      const test = fixture(true);
      await test.controller.start();
      test.emit({ version: 1, id: 'unsafe', type: 'sync', payload });
      await Promise.resolve();
      expect(test.dependencies.onSync).not.toHaveBeenCalled();
      expect(test.controller.getState().connected).toBe(false);
      test.controller.stop();
    }
  });

  it('does not reply through a replaced connection after shutdown', async () => {
    const test = fixture(true);
    let resolve!: (value: unknown) => void;
    vi.mocked(test.dependencies.onSync).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await test.controller.start();
    test.emit({
      version: 1,
      id: 'pending',
      type: 'sync',
      payload: { version: 1, deviceId: 'phone', request: {} },
    });
    const previousCalls = vi.mocked(test.port.postMessage).mock.calls.length;
    test.controller.stop();
    resolve({ applied: true });
    await Promise.resolve();
    expect(test.port.postMessage).toHaveBeenCalledTimes(previousCalls);
  });
});

describe('dashboard-only controls and response validation', () => {
  it('allows dashboard routes but rejects other documents, extension IDs and protocols', async () => {
    const test = fixture();
    const onMessage: NativeSyncRuntimeApi['runtime']['onMessage'] & {
      listeners: Set<Parameters<NativeSyncRuntimeApi['runtime']['onMessage']['addListener']>[0]>;
    } = event();
    const api: NativeSyncRuntimeApi = {
      runtime: {
        id: 'extension',
        getURL: (path) => `chrome-extension://extension/${path}`,
        connectNative: vi.fn(() => test.port),
        onMessage,
      },
      storage: { local: test.dependencies.storage },
      permissions: { contains: async () => true },
    };
    const registration = registerNativeSyncRuntime(api, test.dependencies);
    await registration.ready;
    const listener = [...onMessage.listeners][0]!;
    const request = { version: 1, type: SYNC_CONTROL_TYPE, command: 'enable' };
    const respond = vi.fn();
    for (const sender of [
      { id: 'extension', url: 'https://www.bilibili.com/video/test' },
      { id: 'other', url: api.runtime.getURL('dashboard.html') },
      { id: 'extension', url: api.runtime.getURL('dashboard.html.evil?view=settings') },
      { id: 'extension', url: api.runtime.getURL('sidepanel.html#settings') },
    ]) {
      expect(listener(request, sender, respond)).toBe(false);
    }
    const sender = {
      id: 'extension',
      url: api.runtime.getURL('dashboard.html?view=settings#general'),
    };
    expect(listener({ ...request, version: 2 }, sender, respond)).toBe(false);
    expect(api.runtime.connectNative).not.toHaveBeenCalled();
    expect(listener(request, sender, respond)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(api.runtime.connectNative).toHaveBeenCalledWith(NATIVE_SYNC_HOST);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    registration.dispose();
    expect(onMessage.listeners.size).toBe(0);
  });

  it('validates pairing addresses, fingerprints, ports and host ownership', () => {
    expect(isPairingCode(pairing)).toBe(true);
    for (const patch of [
      { host: '8.8.8.8' },
      { host: '169.254.1.2' },
      { host: '192.168.1.999' },
      { host: '192.168.01.2' },
      { port: 443 },
      { fingerprint: 'A'.repeat(64) },
      { expiresAt: 'tomorrow' },
      { secret: 'short' },
    ])
      expect(isPairingCode({ ...pairing, ...patch })).toBe(false);
    expect(isNativeHostStatus({ ...hostStatus, pairing })).toBe(true);
    expect(isNativeHostStatus({ ...hostStatus, pairing: { ...pairing, serverId: 'other' } })).toBe(
      false,
    );
    expect(isNativeHostStatus({ ...hostStatus, addresses: ['8.8.8.8'] })).toBe(false);
  });

  it('validates dashboard responses and sends only a versioned control command', async () => {
    const sendMessage = vi.fn(async () => ({
      version: 1,
      ok: true,
      state: { enabled: false, connected: false, status: null },
    }));
    vi.stubGlobal('chrome', { runtime: { id: 'extension', sendMessage } });
    await expect(sendSyncControl('status')).resolves.toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith({
      version: 1,
      type: SYNC_CONTROL_TYPE,
      command: 'status',
    });
    sendMessage.mockResolvedValueOnce({
      version: 1,
      ok: true,
      state: { enabled: false, connected: true, status: null },
    });
    await expect(sendSyncControl('status')).rejects.toThrow('无效状态');
  });
});
