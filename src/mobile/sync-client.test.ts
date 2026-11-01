// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileRepository, mobileVisibleTasks } from '../database/mobile-repository';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import type { SyncOperation, SyncRequest, SyncResponse, SyncSnapshot } from '../sync/contracts';
import { SYNC_PAGE_CHARACTERS } from '../sync/protocol';
import { MOBILE_SYNC_REQUEST_BYTES, SyncClient, type SyncClientOptions } from './sync-client';
import { NativeBridgeError } from './bridge';

// Existing delivery fault tests target push/pull after a successful capability check.
class TestSyncClient extends SyncClient {
  constructor(repository: MobileRepository, options: SyncClientOptions) {
    super(repository, {
      ...options,
      request: async (request) => {
        if (request.type === 'capabilities')
          return { version: 2, type: 'capabilities', epoch: request.epoch, protocol: 2, wallet: 2 };
        const result = await options.request!(request);
        if (
          typeof result === 'object' &&
          result !== null &&
          'type' in result &&
          result.type === 'receipts' &&
          'receipts' in result &&
          Array.isArray(result.receipts)
        )
          return {
            ...result,
            receipts: result.receipts.map((row) => ({
              ...row,
              walletDelta: row.walletDelta ?? row.reward,
            })),
          };
        return result;
      },
    });
  }
}

const now = new Date('2026-10-13T12:00:00Z');
function snapshot(epoch = 'epoch-1'): SyncSnapshot {
  return {
    version: 2,
    sequence: 1,
    taskSkips: [],
    epoch,
    generatedAt: now.toISOString(),
    timeZone: 'Europe/London',
    tasks: [],
    completions: [],
    occurrences: [],
    wallet: structuredClone(DEFAULT_ALLOWANCE),
  };
}
function pairStatus(epoch = 'epoch-1'): Promise<unknown> {
  return Promise.resolve({ paired: true, deviceId: 'phone-1', epoch });
}
function page(state: SyncSnapshot, request: SyncRequest): SyncResponse {
  if (request.type !== 'pull') throw new Error('Expected pull');
  if (request.token === null) state.sequence++;
  const json = JSON.stringify(state);
  const end = Math.min(request.cursor + SYNC_PAGE_CHARACTERS, json.length);
  return {
    version: 2,
    type: 'page',
    epoch: state.epoch,
    token: 'snapshot-token',
    cursor: request.cursor,
    chunk: json.slice(request.cursor, end),
    nextCursor: end < json.length ? end : null,
  };
}
function receipts(request: SyncRequest): SyncResponse {
  if (request.type !== 'push') throw new Error('Expected push');
  return {
    version: 2,
    type: 'receipts',
    epoch: request.epoch,
    receipts: request.operations.map((operation) => ({
      operationId: operation.id,
      status: 'applied',
      reward: operation.kind === 'complete-task' ? 2 : 0,
      message: 'confirmed',
    })),
  };
}
function includeCreate(state: SyncSnapshot, operation: SyncOperation): void {
  if (operation.kind === 'create-task')
    state.tasks.push({ task: operation.task, revision: operation.id });
}

describe('mobile sync client fail-closed durable delivery', () => {
  let repository: MobileRepository;
  let factory: IDBFactory;

  it.each(['PERMISSION_DENIED', 'CERTIFICATE_CHANGED'])(
    'keeps actionable native failure %s without exposing raw errors or attempting writes',
    async (code) => {
      const repo = new MobileRepository({
        indexedDBFactory: new IDBFactory(),
        databaseName: 'native-error',
      });
      await repo.applySnapshot(snapshot());
      await repo.createTask({ title: 'Synthetic task', recurrence: 'daily' }, now);
      const client = new SyncClient(repo, {
        pairStatus,
        request: async () => {
          throw new NativeBridgeError('private-path-must-not-leak', code);
        },
      });
      await expect(client.sync()).rejects.toMatchObject({ code: 'ACTION_REQUIRED' });
      await expect(client.sync()).rejects.not.toThrow('private-path-must-not-leak');
      expect((await repo.load()).outbox[0]?.attempted).toBe(false);
      repo.close();
    },
  );
  let sequence: number;
  beforeEach(() => {
    factory = new IDBFactory();
    sequence = 0;
    repository = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'sync-client',
      clock: () => now,
      idGenerator: () => `id-${++sequence}`,
    });
  });

  it('starts with a pull only and never authorizes writes before pairing', async () => {
    const request = vi.fn(async (input: SyncRequest) => page(snapshot(), input));
    const client = new TestSyncClient(repository, { pairStatus: () => pairStatus(), request });
    const summary = await client.sync();
    expect(summary).toMatchObject({ pushed: 0, remaining: 0, snapshotUpdated: true });
    expect(request.mock.calls.map(([input]) => input.type)).toEqual(['pull']);
    expect((await repository.load()).snapshot).toEqual({ ...snapshot(), sequence: 2 });
    const unpaired = new TestSyncClient(repository, {
      pairStatus: async () => ({ paired: false }),
      request,
    });
    await expect(unpaired.sync()).rejects.toMatchObject({ code: 'NOT_PAIRED' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('marks operations attempted before transport and keeps lost replies across reload', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '离线任务', recurrence: 'daily' });
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async () => {
        expect((await repository.load()).outbox[0]?.attempted).toBe(true);
        throw new Error('reply lost');
      },
    });
    await expect(client.sync()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    repository.close();
    const reopened = new MobileRepository({
      indexedDBFactory: factory,
      databaseName: 'sync-client',
    });
    expect((await reopened.load()).outbox[0]).toMatchObject({
      id: created.id,
      status: 'pending',
      attempted: true,
      receipt: null,
    });
    await expect(reopened.cancelNeverSent(created.id)).rejects.toMatchObject({
      code: 'CANCEL_UNSAFE',
    });
    reopened.close();
  });

  it('retries a lost response using the same operation ID and accepts duplicate confirmation', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '重试身份', recurrence: 'daily' });
    const server = snapshot();
    includeCreate(server, created.operation);
    const ids: string[] = [];
    let loseReply = true;
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => {
        if (request.type === 'pull') return page(server, request);
        if (request.type !== 'push') throw new Error('Expected push');
        ids.push(...request.operations.map((op) => op.id));
        if (loseReply) {
          loseReply = false;
          throw new Error('lost');
        }
        return {
          version: 2,
          type: 'receipts',
          epoch: request.epoch,
          receipts: [
            { operationId: created.id, status: 'duplicate', reward: 0, message: 'already saved' },
          ],
        };
      },
    });
    await expect(client.sync()).rejects.toThrow();
    await client.sync();
    expect(ids).toEqual([created.id, created.id]);
    expect((await repository.load()).outbox).toEqual([]);
    expect((await repository.load()).snapshot?.tasks).toHaveLength(1);
  });

  it('retains acknowledgements after pull failure and next sync does not send them again', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '已有回执', recurrence: 'daily' });
    const server = snapshot();
    includeCreate(server, created.operation);
    let failPull = true;
    const request = vi.fn(async (input: SyncRequest) => {
      if (input.type === 'push') return receipts(input);
      if (failPull) throw new Error('offline during snapshot');
      return page(server, input);
    });
    const client = new TestSyncClient(repository, { pairStatus: () => pairStatus(), request });
    await expect(client.sync()).rejects.toThrow();
    expect((await repository.load()).outbox[0]).toMatchObject({
      status: 'acknowledged',
      receipt: { operationId: created.id },
    });
    expect(mobileVisibleTasks(await repository.load())).toHaveLength(1);
    failPull = false;
    await client.sync();
    expect(request.mock.calls.filter(([input]) => input.type === 'push')).toHaveLength(1);
    expect((await repository.load()).outbox).toEqual([]);
  });

  it('rejects duplicate or wrong-epoch receipts without clearing any row', async () => {
    await repository.applySnapshot(snapshot());
    const one = await repository.createTask({ title: '一', recurrence: 'daily' });
    await repository.createTask({ title: '二', recurrence: 'daily' });
    const sameReceipt = { operationId: one.id, status: 'applied', reward: 0, message: '' };
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async () => ({
        version: 2,
        type: 'receipts',
        epoch: 'epoch-1',
        receipts: [sameReceipt, sameReceipt],
      }),
    });
    await expect(client.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect((await repository.load()).outbox.every((row) => row.status === 'pending')).toBe(true);
    const changed = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => ({ ...receipts(request), epoch: 'other' }),
    });
    await expect(changed.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect((await repository.load()).outbox).toHaveLength(2);
  });

  it('preserves a newly queued operation created while an earlier push is in flight', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '开始前', recurrence: 'daily' });
    const server = snapshot();
    includeCreate(server, created.operation);
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => {
        if (request.type === 'push') {
          await repository.createTask({ title: '同步中新增', recurrence: 'daily' });
          return receipts(request);
        }
        return page(server, request);
      },
    });
    const summary = await client.sync();
    expect(summary).toMatchObject({ pushed: 1, remaining: 1 });
    expect(mobileVisibleTasks(summary.state).map((entry) => entry.task.title)).toEqual([
      '开始前',
      '同步中新增',
    ]);
  });

  it('preserves conflicts through snapshot replacement and does not automatically retry them', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '冲突记录', recurrence: 'daily' });
    const request = vi.fn(async (input: SyncRequest) =>
      input.type === 'pull'
        ? page(snapshot(), input)
        : {
            version: 2,
            type: 'receipts',
            epoch: 'epoch-1',
            receipts: [
              { operationId: created.id, status: 'conflict', reward: 0, message: 'task changed' },
            ],
          },
    );
    const client = new TestSyncClient(repository, { pairStatus: () => pairStatus(), request });
    const summary = await client.sync();
    expect(summary.conflicts).toBe(1);
    expect(summary.state.outbox[0]?.operation).toEqual(created.operation);
    await client.sync();
    expect(request.mock.calls.filter(([input]) => input.type === 'push')).toHaveLength(1);
  });

  it('does not replay old work into a new epoch until explicit acceptance and never replays it afterward', async () => {
    await repository.applySnapshot(snapshot());
    const old = await repository.createTask({ title: '旧电脑记录', recurrence: 'daily' });
    const before = await repository.load();
    const request = vi.fn(async (input: SyncRequest) => page(snapshot('epoch-2'), input));
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus('epoch-2'),
      request,
    });
    await expect(client.sync()).rejects.toMatchObject({
      code: 'EPOCH_CHANGED',
      newEpoch: 'epoch-2',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await repository.load()).toEqual(before);
    await repository.acceptNewEpoch('epoch-2');
    await client.sync();
    expect(request.mock.calls.map(([input]) => input.type)).toEqual(['pull']);
    expect((await repository.load()).outbox[0]).toMatchObject({
      id: old.id,
      epoch: 'epoch-1',
      status: 'isolated',
    });
    expect((await repository.load()).archives).toHaveLength(1);
  });

  it('keeps all operations when the computer reports restoration during an in-flight push', async () => {
    await repository.applySnapshot(snapshot());
    await repository.createTask({ title: '恢复发生时', recurrence: 'daily' });
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async () => ({
        version: 2,
        type: 'error',
        code: 'EPOCH_CHANGED',
        message: '电脑已恢复',
      }),
    });
    await expect(client.sync()).rejects.toMatchObject({ code: 'EPOCH_CHANGED' });
    expect((await repository.load()).outbox[0]).toMatchObject({
      status: 'pending',
      attempted: true,
    });
    expect((await repository.load()).snapshot?.epoch).toBe('epoch-1');
  });

  it('assembles coherent pages and rejects changing tokens or malformed snapshots atomically', async () => {
    const large = snapshot();
    await repository.applySnapshot(large);
    const created = await repository.createTask({
      title: '大资料',
      notes: '字'.repeat(8_000),
      recurrence: 'daily',
    });
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    for (let index = 0; index < 8; index++)
      large.tasks.push({
        task: { ...created.operation.task, id: `task-${index}` },
        revision: `rev-${index}`,
      });
    const good = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) =>
        request.type === 'push' ? receipts(request) : page(large, request),
    });
    await good.sync();
    expect((await repository.load()).snapshot?.tasks).toHaveLength(8);
    const before = await repository.load();
    const bad = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => ({
        ...page(large, request),
        token: request.type === 'pull' && request.cursor > 0 ? 'wrong-token' : 'snapshot-token',
      }),
    });
    await expect(bad.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(await repository.load()).toEqual(before);
    const malformed = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async () => ({
        version: 2,
        type: 'page',
        epoch: 'epoch-1',
        token: 'snapshot-token',
        cursor: 0,
        chunk: '{"bad":true}',
        nextCursor: null,
      }),
    });
    await expect(malformed.sync()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(await repository.load()).toEqual(before);
  });

  it('enforces the two-minute local snapshot deadline without discarding acknowledgements', async () => {
    await repository.applySnapshot(snapshot());
    const row = await repository.createTask({ title: '超时回执', recurrence: 'daily' });
    let time = 0;
    const client = new TestSyncClient(repository, {
      clock: () => time,
      pairStatus: () => pairStatus(),
      request: async (request) => {
        if (request.type === 'push') return receipts(request);
        time = 120_000;
        return page(snapshot(), request);
      },
    });
    await expect(client.sync()).rejects.toMatchObject({ code: 'SNAPSHOT_EXPIRED' });
    expect((await repository.load()).outbox[0]).toMatchObject({
      id: row.id,
      status: 'acknowledged',
    });
  });

  it('limits batches both by operation count and UTF-8 bytes, not JavaScript characters', async () => {
    await repository.applySnapshot(snapshot());
    for (let index = 0; index < 12; index++)
      await repository.createTask({
        title: `长任务${index}`,
        notes: '字'.repeat(8_000),
        recurrence: 'daily',
      });
    const requests: SyncRequest[] = [];
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => {
        requests.push(request);
        return request.type === 'push' ? receipts(request) : page(snapshot(), request);
      },
    });
    await client.sync();
    const batches = requests.filter((request) => request.type === 'push');
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every(
        (batch) =>
          new TextEncoder().encode(JSON.stringify(batch)).length <= MOBILE_SYNC_REQUEST_BYTES,
      ),
    ).toBe(true);
    expect(batches.reduce((total, batch) => total + batch.operations.length, 0)).toBe(12);
    expect(batches.every((batch) => batch.operations.length <= 50)).toBe(true);
  });

  it('reports what the computer applied, even when the same pull removed the entries', async () => {
    await repository.applySnapshot(snapshot());
    const created = await repository.createTask({ title: '手机新增', recurrence: 'daily' }, now);
    if (created.operation.kind !== 'create-task') throw new Error('fixture');
    const completed = await repository.enqueueCompletion(created.operation.task.id, now);
    const spent = await repository.createTask({ title: '冲突', recurrence: 'daily' }, now);
    const server = snapshot();
    includeCreate(server, created.operation);
    const client = new TestSyncClient(repository, {
      pairStatus: () => pairStatus(),
      request: async (request) => {
        if (request.type !== 'push') return page(server, request);
        const result = receipts(request);
        if (result.type !== 'receipts') throw new Error('fixture');
        return {
          ...result,
          receipts: result.receipts.map((row) =>
            row.operationId === spent.id
              ? { ...row, status: 'conflict' as const, reward: 0, message: 'task changed' }
              : row,
          ),
        };
      },
    });
    const summary = await client.sync();
    // Acknowledged and settled in one go: the outbox no longer holds the two entries.
    expect(summary.state.outbox.map((entry) => entry.id)).toEqual([spent.id]);
    expect(summary.applied).toEqual([
      {
        operationId: created.id,
        kind: 'create-task',
        taskId: created.operation.task.id,
        reward: 0,
      },
      {
        operationId: completed.id,
        kind: 'complete-task',
        taskId: created.operation.task.id,
        reward: 2,
      },
    ]);
    // Nothing new was pushed, so nothing is reported again.
    expect((await client.sync()).applied).toEqual([]);
  });

  it('shares one in-flight sync per client', async () => {
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (input: SyncRequest) => {
      await wait;
      return page(snapshot(), input);
    });
    const client = new TestSyncClient(repository, { pairStatus: () => pairStatus(), request });
    const first = client.sync();
    const second = client.sync();
    expect(first).toBe(second);
    release?.();
    await first;
    expect(request).toHaveBeenCalledTimes(1);
  });
});
