import { describe, expect, it, vi } from 'vitest';

import {
  NativeSyncController,
  type NativeHostStatus,
  type NativeSyncDependencies,
  type NativeSyncPort,
} from '../sync/native-bridge';
import { SYNC_ENABLED_STORAGE_KEY } from '../sync/settings';

// Only in the public repository: it checks lines the export rewrites in the native bridge.
const ALREADY_PAIRED = '请先解除原有手机配对，再连接新手机。';

const unpaired: NativeHostStatus = {
  serverId: 'server-one',
  paired: false,
  addresses: ['192.168.1.2'],
  port: 19284,
};
const paired: NativeHostStatus = { ...unpaired, paired: true };
const pairing = {
  version: 1 as const,
  serverId: 'server-one',
  host: '192.168.1.2',
  port: 19284 as const,
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

type Reply = { ok: true; payload: unknown } | { ok: false; error: string };

/** A fake helper port, in the way native-bridge.test.ts fakes it. The answers are per test. */
function fixture(answer: (type: string) => Reply) {
  const onMessage = event<(message: unknown) => void>();
  const onDisconnect = event<() => void>();
  const sent: string[] = [];
  const port: NativeSyncPort = {
    onMessage,
    onDisconnect,
    disconnect: vi.fn(),
    postMessage: vi.fn((message: unknown) => {
      const request = message as { id: string; type: string };
      sent.push(request.type);
      queueMicrotask(() =>
        onMessage.listeners.forEach((listener) =>
          listener({ version: 1, id: request.id, type: 'result', ...answer(request.type) }),
        ),
      );
    }),
  };
  const dependencies: NativeSyncDependencies = {
    storage: {
      get: vi.fn(async () => ({ [SYNC_ENABLED_STORAGE_KEY]: true })),
      set: vi.fn(async () => undefined),
    },
    connect: vi.fn(() => port),
    getEpoch: vi.fn(async () => 'epoch-one'),
    onSync: vi.fn(async () => ({ applied: true })),
    consumeLastError: vi.fn(),
    timeoutMs: 50,
    retryDelayMs: 0,
  };
  return { controller: new NativeSyncController(dependencies), sent };
}

describe('pair command, public edition', () => {
  it('says to unpair first when the connection already knows a phone is paired', async () => {
    const test = fixture(() => ({ ok: true, payload: paired }));
    await test.controller.start();

    const result = await test.controller.control('pair');

    expect(result).toMatchObject({ ok: false, error: ALREADY_PAIRED });
    expect(test.sent).not.toContain('pairing.start');
    test.controller.stop();
  });

  it('asks the helper first, so a page from before the phone paired gets the same answer', async () => {
    let helperStatus = unpaired;
    const test = fixture(() => ({ ok: true, payload: helperStatus }));
    await test.controller.start();
    expect(test.controller.getState().status?.paired).toBe(false);

    helperStatus = paired;
    const result = await test.controller.control('pair');

    expect(result).toMatchObject({
      ok: false,
      error: ALREADY_PAIRED,
      state: { connected: true, status: { paired: true } },
    });
    expect(test.sent).not.toContain('pairing.start');
    test.controller.stop();
  });

  it('starts pairing after the fresh status when no phone is paired', async () => {
    const test = fixture((type) => ({
      ok: true,
      payload: type === 'pairing.start' ? { ...unpaired, pairing } : unpaired,
    }));
    await test.controller.start();

    const result = await test.controller.control('pair');

    expect(result.ok).toBe(true);
    expect(result.state.status?.pairing).toEqual(pairing);
    expect(test.sent).toEqual(['init', 'status', 'pairing.start']);
    test.controller.stop();
  });

  it('keeps the last status when the fresh one is not valid, and still starts', async () => {
    const test = fixture((type) => ({
      ok: true,
      payload:
        type === 'status'
          ? { serverId: 'server-one', paired: 'yes' }
          : type === 'pairing.start'
            ? { ...unpaired, pairing }
            : unpaired,
    }));
    await test.controller.start();

    const result = await test.controller.control('pair');

    expect(result.ok).toBe(true);
    expect(test.sent.at(-1)).toBe('pairing.start');
    test.controller.stop();
  });

  it('does not start when the helper cannot answer the status', async () => {
    const test = fixture((type) =>
      type === 'status' ? { ok: false, error: 'busy' } : { ok: true, payload: unpaired },
    );
    await test.controller.start();

    const result = await test.controller.control('pair');

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('SYNC-HOST-REQUEST'),
    });
    expect(test.sent).not.toContain('pairing.start');
    test.controller.stop();
  });

  it('does not send the extra status for any other command', async () => {
    const test = fixture(() => ({ ok: true, payload: unpaired }));
    await test.controller.start();

    await test.controller.control('status');
    await test.controller.control('revoke');

    expect(test.sent).toEqual(['init', 'status', 'pairing.revoke']);
    test.controller.stop();
  });
});
