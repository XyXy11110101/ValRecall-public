import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { NATIVE_SYNC_MAX_BYTES } from './native-bridge';
import type {
  SyncOperation,
  SyncReceipt,
  SyncRequest,
  SyncResponse,
  SyncSnapshot,
} from './contracts';
import { readSyncSnapshot } from './contracts';
import { SYNC_MAX_SNAPSHOT_CHARACTERS, SYNC_PAGE_CHARACTERS } from './protocol';
import { DesktopSyncService, type DesktopSyncPort } from './service';

const DEVICE = 'phone-device-one';
const EPOCH = 'epoch-one';
const AT = '2026-10-10T23:30:00.000Z';
type Page = Extract<SyncResponse, { type: 'page' }>;

function snapshot(notes = ''): SyncSnapshot {
  return {
    version: 2,
    sequence: 1,
    taskSkips: [],
    epoch: EPOCH,
    generatedAt: '2026-10-13T15:00:00.000Z',
    timeZone: 'Europe/London',
    tasks: [
      {
        task: {
          id: 'task-one',
          schemaVersion: 1,
          title: '中文学习 🎹',
          notes,
          kind: 'routine',
          recurrence: 'daily',
          scheduledDate: null,
          scheduledTime: null,
          selectedWeekdays: [],
          linkedLearningItemId: null,
          priority: 'normal',
          archived: false,
          createdAt: AT,
          updatedAt: AT,
        },
        revision: 'task-revision-one',
      },
    ],
    completions: [],
    occurrences: [],
    wallet: structuredClone(DEFAULT_ALLOWANCE),
  };
}

function completion(): SyncOperation {
  return {
    id: 'completion-operation',
    kind: 'complete-task',
    at: AT,
    date: '2026-10-11',
    timeZone: 'Europe/London',
    taskId: 'task-one',
    taskRevision: 'task-revision-one',
    occurrenceRevision: null,
  };
}

function pull(token: string | null = null, cursor = 0, epoch = EPOCH): SyncRequest {
  return { version: 2, type: 'pull', epoch, token, cursor };
}

function fakePort(value = snapshot()) {
  return {
    getEpoch: vi.fn<DesktopSyncPort['getEpoch']>().mockResolvedValue(EPOCH),
    getSnapshot: vi.fn<DesktopSyncPort['getSnapshot']>().mockResolvedValue(value),
    applyOperations: vi.fn<DesktopSyncPort['applyOperations']>().mockResolvedValue([]),
  };
}

function fixture(value = snapshot()) {
  const port = fakePort(value);
  let now = Date.parse('2026-10-13T15:00:00.000Z');
  let serial = 0;
  const zone = vi.fn(() => 'Europe/London');
  const service = new DesktopSyncService(
    port,
    () => now,
    zone,
    () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
  );
  return {
    port,
    service,
    zone,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function page(value: SyncResponse): Page {
  if (value.type !== 'page') throw new Error('Expected a successful snapshot page.');
  return value;
}

/** Simulate both the native JSON envelope and the real UTF-8 network hop. */
function transport(value: Page): Page {
  const json = JSON.stringify({
    version: 2,
    id: 'host-synthetic',
    type: 'result',
    ok: true,
    payload: value,
  });
  const bytes = new TextEncoder().encode(json);
  expect(bytes.length).toBeLessThan(NATIVE_SYNC_MAX_BYTES);
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof decoded !== 'object' || decoded === null || !('payload' in decoded))
    throw new Error('Invalid test envelope.');
  return decoded.payload as Page;
}

async function download(service: DesktopSyncService, first: Page) {
  let current = transport(first);
  const chunks = [current.chunk];
  for (let count = 0; current.nextCursor !== null && count < 200; count++) {
    current = transport(
      page(await service.handle(DEVICE, pull(current.token, current.nextCursor))),
    );
    chunks.push(current.chunk);
  }
  expect(current.nextCursor).toBeNull();
  return chunks.join('');
}

describe('desktop sync operation gateway', () => {
  it('passes delayed operations with their captured timezone/date to the atomic repository', async () => {
    const { port, service } = fixture();
    const receipts: SyncReceipt[] = [
      { operationId: 'completion-operation', status: 'applied', reward: 2, message: '已确认' },
    ];
    port.applyOperations.mockResolvedValue(receipts);
    const operations = [completion()];
    expect(
      await service.handle(DEVICE, { version: 2, type: 'push', epoch: EPOCH, operations }),
    ).toEqual({ version: 2, type: 'receipts', epoch: EPOCH, receipts });
    expect(port.applyOperations).toHaveBeenCalledExactlyOnceWith(EPOCH, DEVICE, operations, false);
    expect(port.getSnapshot).not.toHaveBeenCalled();
  });

  it('does not infer a second reward when the repository returns a durable duplicate receipt', async () => {
    const { port, service } = fixture();
    const applied: SyncReceipt = {
      operationId: 'completion-operation',
      status: 'applied',
      reward: 2,
      message: '已保存',
    };
    const duplicate: SyncReceipt = {
      ...applied,
      status: 'duplicate',
      reward: 0,
      message: '已处理',
    };
    port.applyOperations.mockResolvedValueOnce([applied]).mockResolvedValueOnce([duplicate]);
    const input = { version: 2, type: 'push', epoch: EPOCH, operations: [completion()] };
    expect(await service.handle(DEVICE, input)).toMatchObject({ receipts: [applied] });
    expect(await service.handle(DEVICE, input)).toMatchObject({ receipts: [duplicate] });
    expect(port.applyOperations).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate operation IDs in a batch before opening the repository', async () => {
    const { port, service } = fixture();
    expect(
      await service.handle(DEVICE, {
        version: 2,
        type: 'push',
        epoch: EPOCH,
        operations: [completion(), completion()],
      }),
    ).toMatchObject({ type: 'error', code: 'INVALID_REQUEST' });
    expect(port.getEpoch).not.toHaveBeenCalled();
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it.each(['', '../device', 'a'.repeat(101), '手机设备'])(
    'rejects invalid device identity %s',
    async (device) => {
      const { port, service } = fixture();
      expect(await service.handle(device, pull())).toMatchObject({
        type: 'error',
        code: 'INVALID_REQUEST',
      });
      expect(port.getEpoch).not.toHaveBeenCalled();
    },
  );

  it('rejects a stale restore epoch without attempting any operation', async () => {
    const { port, service } = fixture();
    port.getEpoch.mockResolvedValue('restored-epoch');
    expect(
      await service.handle(DEVICE, {
        version: 2,
        type: 'push',
        epoch: EPOCH,
        operations: [completion()],
      }),
    ).toMatchObject({ type: 'error', code: 'EPOCH_CHANGED' });
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it('reports uncertain repository failure without automatically retrying mutations', async () => {
    const { port, service } = fixture();
    port.applyOperations.mockRejectedValue(new Error('synthetic storage failure'));
    expect(
      await service.handle(DEVICE, {
        version: 2,
        type: 'push',
        epoch: EPOCH,
        operations: [completion()],
      }),
    ).toMatchObject({ type: 'error', code: 'UNAVAILABLE' });
    expect(port.applyOperations).toHaveBeenCalledTimes(1);
  });

  it('enforces the exact 256 KiB serialized request boundary', async () => {
    const { port, service } = fixture();
    const base = { version: 2, type: 'push', epoch: EPOCH, operations: [], padding: '' };
    const overhead = new TextEncoder().encode(JSON.stringify(base)).length;
    const exact = { ...base, padding: 'x'.repeat(256 * 1024 - overhead) };
    expect(new TextEncoder().encode(JSON.stringify(exact))).toHaveLength(256 * 1024);
    expect(await service.handle(DEVICE, exact)).toMatchObject({ type: 'receipts' });
    port.applyOperations.mockClear();
    expect(await service.handle(DEVICE, { ...exact, padding: exact.padding + 'x' })).toMatchObject({
      type: 'error',
      code: 'INVALID_REQUEST',
    });
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it('measures UTF-8 bytes rather than UTF-16 string length for Chinese request bounds', async () => {
    const { port, service } = fixture();
    const input = {
      version: 2,
      type: 'push',
      epoch: EPOCH,
      operations: [],
      padding: '中'.repeat(90_000),
    };
    expect(JSON.stringify(input).length).toBeLessThan(256 * 1024);
    expect(await service.handle(DEVICE, input)).toMatchObject({
      type: 'error',
      code: 'INVALID_REQUEST',
    });
    expect(port.getEpoch).not.toHaveBeenCalled();
  });

  it('handles non-JSON and cyclic inputs without touching storage', async () => {
    const { port, service } = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, null, 1n, cyclic, () => undefined]) {
      expect(await service.handle(DEVICE, value)).toMatchObject({
        type: 'error',
        code: 'INVALID_REQUEST',
      });
    }
    expect(port.getEpoch).not.toHaveBeenCalled();
  });
});

describe('immutable paginated desktop snapshots', () => {
  it('uses the current PC zone only when beginning a new snapshot', async () => {
    const { port, service, zone } = fixture(snapshot('x'.repeat(60_000)));
    const first = page(await service.handle(DEVICE, pull()));
    zone.mockReturnValue('Asia/Shanghai');
    await service.handle(DEVICE, pull(first.token, first.nextCursor!));
    expect(port.getSnapshot).toHaveBeenCalledExactlyOnceWith('Europe/London');
    await service.handle(DEVICE, pull());
    expect(port.getSnapshot).toHaveBeenLastCalledWith('Asia/Shanghai');
  });

  it('reassembles Chinese, surrogate pairs, escaped controls and unpaired surrogates byte-for-byte', async () => {
    const data = snapshot('中文🎹📱\\"\n\t\u0000\ud800\udfff'.repeat(20_000));
    const { service } = fixture(data);
    const first = page(await service.handle(DEVICE, pull()));
    const joined = await download(service, first);
    expect(joined).toBe(JSON.stringify(data));
    expect(readSyncSnapshot(JSON.parse(joined))).toEqual(data);
  });

  it('does not corrupt a surrogate pair split exactly at the 48,000-character page boundary', async () => {
    const marker = 'boundary_marker';
    const probe = JSON.stringify(snapshot(marker));
    const notesOffset = probe.indexOf(marker);
    expect(notesOffset).toBeGreaterThan(0);
    const data = snapshot('a'.repeat(SYNC_PAGE_CHARACTERS - 1 - notesOffset) + '🎹后续');
    const serialized = JSON.stringify(data);
    expect(serialized.charCodeAt(SYNC_PAGE_CHARACTERS - 1)).toBe(0xd83c);
    expect(serialized.charCodeAt(SYNC_PAGE_CHARACTERS)).toBe(0xdfb9);
    const { service } = fixture(data);
    const first = page(await service.handle(DEVICE, pull()));
    expect(first.chunk.charCodeAt(first.chunk.length - 1)).toBe(0xd83c);
    expect(await download(service, first)).toBe(serialized);
  });

  it('freezes the serialized snapshot even if the underlying objects later change', async () => {
    const data = snapshot('x'.repeat(100_000));
    const expected = JSON.stringify(data);
    const { service } = fixture(data);
    const first = page(await service.handle(DEVICE, pull()));
    data.tasks[0]!.task.notes = 'mutated after first page';
    data.wallet.balance = 999;
    expect(await download(service, first)).toBe(expected);
  });

  it('allows safe page retries and out-of-order aligned reads without repeating mutations', async () => {
    const { service, port } = fixture(snapshot('x'.repeat(150_000)));
    const first = page(await service.handle(DEVICE, pull()));
    const request = pull(first.token, SYNC_PAGE_CHARACTERS * 2);
    const pageTwo = await service.handle(DEVICE, request);
    expect(await service.handle(DEVICE, request)).toEqual(pageTwo);
    expect(await service.handle(DEVICE, pull(first.token, 0))).toEqual(first);
    expect(port.getSnapshot).toHaveBeenCalledTimes(1);
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it('isolates snapshot tokens by both device and token', async () => {
    const { service } = fixture(snapshot('x'.repeat(100_000)));
    const first = page(await service.handle(DEVICE, pull()));
    expect(
      await service.handle('phone-device-other', pull(first.token, SYNC_PAGE_CHARACTERS)),
    ).toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
    expect(await service.handle(DEVICE, pull('wrong-token', SYNC_PAGE_CHARACTERS))).toMatchObject({
      code: 'SNAPSHOT_EXPIRED',
    });
    expect(await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS))).toMatchObject({
      type: 'page',
    });
  });

  it('retains only one snapshot and invalidates the previous token after a new pull', async () => {
    const { service } = fixture(snapshot('x'.repeat(100_000)));
    const first = page(await service.handle(DEVICE, pull()));
    const second = page(await service.handle('phone-device-other', pull()));
    expect(second.token).not.toBe(first.token);
    const expired = await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS));
    expect(expired.type).toBe('error');
    if (expired.type === 'error') expect(expired.code).toBe('SNAPSHOT_EXPIRED');
  });

  it('expires at the two-minute deadline without extending TTL on successful page reads', async () => {
    const { service, advance } = fixture(snapshot('x'.repeat(100_000)));
    const first = page(await service.handle(DEVICE, pull()));
    advance(119_999);
    expect(await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS))).toMatchObject({
      type: 'page',
    });
    advance(1);
    expect(await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS))).toMatchObject({
      code: 'SNAPSHOT_EXPIRED',
    });
  });

  it.each([1, SYNC_PAGE_CHARACTERS - 1, SYNC_PAGE_CHARACTERS * 10, Number.MAX_SAFE_INTEGER])(
    'rejects an unaligned or out-of-range cursor %s',
    async (cursor) => {
      const { service } = fixture(snapshot('x'.repeat(60_000)));
      const first = page(await service.handle(DEVICE, pull()));
      expect(await service.handle(DEVICE, pull(first.token, cursor))).toMatchObject({
        code: 'SNAPSHOT_EXPIRED',
      });
    },
  );

  it('invalidates the cached snapshot when a restored epoch is observed', async () => {
    const { port, service } = fixture(snapshot('x'.repeat(100_000)));
    const first = page(await service.handle(DEVICE, pull()));
    port.getEpoch.mockResolvedValue('restored-epoch');
    expect(await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS))).toMatchObject({
      code: 'EPOCH_CHANGED',
    });
    port.getEpoch.mockResolvedValue(EPOCH);
    expect(await service.handle(DEVICE, pull(first.token, SYNC_PAGE_CHARACTERS))).toMatchObject({
      code: 'SNAPSHOT_EXPIRED',
    });
  });

  it('detects restore between the epoch read and the atomic repository snapshot', async () => {
    const { port, service } = fixture({ ...snapshot(), epoch: 'restored-epoch' });
    expect(await service.handle(DEVICE, pull())).toMatchObject({ code: 'EPOCH_CHANGED' });
    expect(port.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 8,000,000 snapshot characters and rejects one more without truncation', async () => {
    const data = snapshot();
    const overhead = JSON.stringify(data).length;
    data.tasks[0]!.task.notes = 'x'.repeat(SYNC_MAX_SNAPSHOT_CHARACTERS - overhead);
    expect(JSON.stringify(data)).toHaveLength(SYNC_MAX_SNAPSHOT_CHARACTERS);
    const { service, port } = fixture(data);
    expect(await service.handle(DEVICE, pull())).toMatchObject({ type: 'page' });
    data.tasks[0]!.task.notes += 'x';
    expect(await service.handle(DEVICE, pull())).toMatchObject({ code: 'TOO_LARGE' });
    expect(port.applyOperations).not.toHaveBeenCalled();
  });

  it('returns a recoverable error when epoch or snapshot storage is unavailable', async () => {
    const { service, port } = fixture();
    port.getEpoch.mockRejectedValueOnce(new Error('synthetic unavailable'));
    expect(await service.handle(DEVICE, pull())).toMatchObject({ code: 'UNAVAILABLE' });
    port.getSnapshot.mockRejectedValueOnce(new Error('synthetic unavailable'));
    expect(await service.handle(DEVICE, pull())).toMatchObject({ code: 'UNAVAILABLE' });
  });
});
