import { describe, expect, it } from 'vitest';
import type { DailyTask } from '../models/daily-task';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import {
  isSyncReceipt,
  isSyncWallet,
  readSyncOperation,
  readSyncRequest,
  readSyncSnapshot,
  readSyncTask,
  validDateTime,
  type SyncOperation,
  type SyncSnapshot,
} from './contracts';
import { SYNC_BATCH_LIMIT } from './protocol';

const AT = '2026-10-10T23:30:00.000Z';

function task(changes: Partial<DailyTask> = {}): DailyTask {
  return {
    id: 'phone-task-one',
    schemaVersion: 1,
    title: '练琴 / piano 🎹',
    notes: '保留原文，不自动翻译。',
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
    ...changes,
  };
}

function create(changes: Partial<DailyTask> = {}): SyncOperation {
  return { id: 'operation-create', kind: 'create-task', at: AT, task: task(changes) };
}

function complete(): SyncOperation {
  return {
    id: 'operation-complete',
    kind: 'complete-task',
    at: AT,
    date: '2026-10-11',
    timeZone: 'Europe/London',
    taskId: 'legacy:task/with-unicode-学习',
    taskRevision: 'task-revision-one',
    occurrenceRevision: null,
  };
}

function snapshot(): SyncSnapshot {
  return {
    version: 2,
    sequence: 1,
    taskSkips: [],
    epoch: 'epoch-one',
    generatedAt: '2026-10-13T15:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    tasks: [{ task: task(), revision: 'task-revision-one' }],
    completions: [
      { id: 'completion-one', taskId: 'phone-task-one', localDate: '2026-10-11', completedAt: AT },
    ],
    occurrences: [
      { taskId: 'phone-task-one', date: '2026-10-11', revision: 'occurrence-one', rewardAmount: 2 },
    ],
    wallet: structuredClone(DEFAULT_ALLOWANCE),
  };
}

describe('sync operation boundary', () => {
  it('accepts only an explicit positive spend amount and strips wallet overrides', () => {
    const operation = { id: 'spend-one', kind: 'spend-allowance', at: AT, amount: 5, note: '零食' };
    expect(readSyncOperation({ ...operation, balance: 999, reward: 999 })).toEqual(operation);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', null])(
    'rejects an invalid spend amount %s',
    (amount) => {
      expect(() =>
        readSyncOperation({ id: 'spend-one', kind: 'spend-allowance', at: AT, amount, note: '' }),
      ).toThrow();
    },
  );

  it.each([undefined, null, 2, '字'.repeat(501)])('rejects malformed spend note %#', (note) => {
    expect(() =>
      readSyncOperation({ id: 'spend-one', kind: 'spend-allowance', at: AT, amount: 5, note }),
    ).toThrow();
  });
  it('allows offline creation and a delayed completion without replacing its original PC-zone day', () => {
    expect(readSyncOperation(create())).toEqual(create());
    expect(readSyncOperation(complete())).toEqual(complete());
  });

  it('retains an explicitly captured completion revision and strips unrelated inbound fields', () => {
    const operation = { ...complete(), occurrenceRevision: 'occurrence-two' };
    expect(readSyncOperation({ ...operation, reward: 1_000, wallet: { balance: 1_000 } })).toEqual(
      operation,
    );
  });

  it('reconstructs the task fields without destructively normalizing Chinese or English text', () => {
    const input = { ...task(), accountToken: 'synthetic-not-a-credential' };
    expect(readSyncTask(input)).toEqual(task());
    expect(readSyncTask(input)).not.toHaveProperty('accountToken');
  });

  it('copies mutable weekdays so the validated result cannot change with its input', () => {
    const input = task({ recurrence: 'selected_weekdays', selectedWeekdays: [1, 3] });
    const parsed = readSyncTask(input);
    input.selectedWeekdays.push(7);
    expect(parsed.selectedWeekdays).toEqual([1, 3]);
  });

  it.each([
    ['spending', { ...complete(), kind: 'spend' }],
    ['editing', { ...complete(), kind: 'edit-task' }],
    ['deleting', { ...complete(), kind: 'delete-task' }],
    ['undoing', { ...complete(), kind: 'undo-task' }],
    ['wrong calendar day', { ...complete(), date: '2026-10-10' }],
    ['nonexistent day', { ...complete(), date: '2026-02-30' }],
    ['unknown timezone', { ...complete(), timeZone: 'Somewhere/Imaginary' }],
    ['empty task ID', { ...complete(), taskId: '' }],
    ['oversized task ID', { ...complete(), taskId: 'x'.repeat(513) }],
    ['missing task revision', { ...complete(), taskRevision: undefined }],
    ['invalid task revision', { ...complete(), taskRevision: 'revision with spaces' }],
    ['missing occurrence revision', { ...complete(), occurrenceRevision: undefined }],
    ['invalid occurrence revision', { ...complete(), occurrenceRevision: 12 }],
    ['invalid operation ID', { ...complete(), id: '../operation' }],
  ])('rejects %s before persistence', (_label, operation) => {
    expect(() => readSyncOperation(operation)).toThrow();
  });

  it.each([
    ['practice task', { kind: 'practice', recurrence: 'daily' }],
    ['archived task', { archived: true }],
    ['linked learning item', { linkedLearningItemId: 'learning-one' }],
    ['overlong title', { title: '字'.repeat(501) }],
    ['overlong notes', { notes: '字'.repeat(8_001) }],
    ['different creation timestamp', { createdAt: '2026-10-10T10:00:00.000Z' }],
    ['different update timestamp', { updatedAt: '2026-10-10T10:00:00.000Z' }],
    ['non-mobile ID', { id: 'legacy/task' }],
    ['invalid weekday', { recurrence: 'selected_weekdays', selectedWeekdays: [7] }],
    ['duplicated weekday', { recurrence: 'selected_weekdays', selectedWeekdays: [1, 1] }],
    ['invalid time', { scheduledTime: '25:00' }],
    ['one-off without date', { kind: 'one_off', recurrence: 'specific_date' }],
  ])('rejects a mobile create with %s', (_label, changes) => {
    expect(() => readSyncOperation({ ...create(), task: { ...task(), ...changes } })).toThrow();
  });

  it('accepts the mobile text limits and a properly dated one-off task', () => {
    const operation = create({
      title: '字'.repeat(500),
      notes: '字'.repeat(8_000),
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-11',
    });
    expect(readSyncOperation(operation)).toEqual(operation);
  });

  it('does not restrict legacy desktop task IDs or long text when reading a snapshot', () => {
    const legacy = task({
      id: 'desktop:习惯/one',
      title: '既有任务'.repeat(500),
      notes: '文'.repeat(20_000),
    });
    expect(readSyncTask(legacy)).toEqual(legacy);
  });
});

describe('sync timestamp contract', () => {
  it.each([
    '2026-02-30T12:00:00.000Z',
    '2025-02-29T12:00:00.000Z',
    '2026-13-01T12:00:00.000Z',
    '2026-10-13T25:00:00.000Z',
    '2026-10-13T12:00:00',
    '2026-10-13',
    'not a date',
    null,
    1_234,
  ])('rejects an invalid or timezone-ambiguous timestamp: %s', (value) => {
    expect(validDateTime(value)).toBe(false);
  });

  it.each(['2024-02-29T12:00:00.000Z', '2026-10-13T12:00:00Z'])('accepts %s', (value) => {
    expect(validDateTime(value)).toBe(true);
  });

  it('rejects invalid timestamps even when task and operation timestamps agree', () => {
    const at = '2026-02-30T12:00:00.000Z';
    expect(() =>
      readSyncOperation({ ...create(), at, task: task({ createdAt: at, updatedAt: at }) }),
    ).toThrow();
  });
});

describe('sync request boundary', () => {
  it('accepts an empty push and exactly the bounded operation count', () => {
    expect(
      readSyncRequest({ version: 2, type: 'push', epoch: 'epoch-one', operations: [] }),
    ).toMatchObject({ operations: [] });
    const operations = Array.from({ length: SYNC_BATCH_LIMIT }, (_, index) => ({
      ...complete(),
      id: `operation-${index}`,
    }));
    expect(
      readSyncRequest({ version: 2, type: 'push', epoch: 'epoch-one', operations }),
    ).toMatchObject({ operations });
  });

  it('rejects excess operations and duplicate operation identities', () => {
    const operations = Array.from({ length: SYNC_BATCH_LIMIT + 1 }, (_, index) => ({
      ...complete(),
      id: `operation-${index}`,
    }));
    expect(() =>
      readSyncRequest({ version: 2, type: 'push', epoch: 'epoch-one', operations }),
    ).toThrow();
    expect(() =>
      readSyncRequest({
        version: 2,
        type: 'push',
        epoch: 'epoch-one',
        operations: [complete(), complete()],
      }),
    ).toThrow();
  });

  it.each([
    { version: 1, type: 'pull', epoch: 'epoch-one', token: null, cursor: 0 },
    { version: 2, type: 'pull', epoch: '../epoch', token: null, cursor: 0 },
    { version: 2, type: 'pull', epoch: 'epoch-one', token: null, cursor: 1 },
    { version: 2, type: 'pull', epoch: 'epoch-one', token: 'page-token', cursor: -1 },
    { version: 2, type: 'pull', epoch: 'epoch-one', token: 'page-token', cursor: 1.5 },
    {
      version: 2,
      type: 'pull',
      epoch: 'epoch-one',
      token: 'page-token',
      cursor: Number.MAX_SAFE_INTEGER + 1,
    },
    { version: 2, type: 'pull', epoch: 'epoch-one', token: {}, cursor: 0 },
    { version: 2, type: 'replace-wallet', epoch: 'epoch-one' },
  ])('rejects invalid request %#', (request) => {
    expect(() => readSyncRequest(request)).toThrow();
  });

  it('reconstructs the pull allowlist', () => {
    expect(
      readSyncRequest({
        version: 2,
        type: 'pull',
        epoch: 'epoch-one',
        token: 'page-token',
        cursor: 48_000,
        extra: true,
      }),
    ).toEqual({
      version: 2,
      type: 'pull',
      epoch: 'epoch-one',
      token: 'page-token',
      cursor: 48_000,
    });
  });
});

describe('wallet, receipt and snapshot guards', () => {
  it.each([0, 2, 5])('reads both historical and current task rewards: %s', (reward) => {
    expect(isSyncReceipt({ operationId: 'op-one', status: 'applied', reward, message: '' })).toBe(
      true,
    );
  });
  it('keeps the existing balance rather than recomputing it from truncated history', () => {
    const value = snapshot();
    value.wallet.balance = 321;
    value.wallet.totalEarned = 400;
    value.wallet.totalSpent = 79;
    value.wallet.ledgerSeq = 1_500;
    const parsed = readSyncSnapshot(value);
    expect(parsed.wallet).toEqual(value.wallet);
    parsed.wallet.balance = 123;
    expect(value.wallet.balance).toBe(321);
  });

  it.each(['applied', 'duplicate', 'conflict'])('accepts a %s receipt', (status) => {
    expect(isSyncReceipt({ operationId: 'op-one', status, reward: 0, message: '已处理' })).toBe(
      true,
    );
  });

  it.each([
    { status: ['applied'] },
    { status: { toString: (): string => 'applied' } },
    { status: 'unknown' },
    { reward: -2 },
    { reward: 3 },
    { message: '文'.repeat(2_001) },
    { operationId: '' },
  ])('rejects malformed receipt %#', (change) => {
    expect(
      isSyncReceipt({
        operationId: 'op-one',
        status: 'applied',
        reward: 2,
        message: '已保存',
        ...change,
      }),
    ).toBe(false);
  });

  it.each([
    { balance: -1.5 },
    { balance: 1.5 },
    { balance: Number.MAX_SAFE_INTEGER + 1 },
    { totalEarned: Number.NaN },
    { lastCheckInDate: '2026-02-30' },
    { ledger: new Array(201).fill({}) },
  ])('rejects malformed wallet %#', (change) => {
    expect(isSyncWallet({ ...structuredClone(DEFAULT_ALLOWANCE), ...change })).toBe(false);
  });

  it.each([{ kind: ['earn'] }, { source: ['task'] }])(
    'does not coerce ledger enum arrays into strings %#',
    (change) => {
      const ledger = [
        {
          id: 'entry-one',
          at: AT,
          date: '2026-10-11',
          kind: 'earn',
          source: 'task',
          amount: 2,
          note: '任务',
          balanceAfter: 2,
          ...change,
        },
      ];
      expect(isSyncWallet({ ...structuredClone(DEFAULT_ALLOWANCE), ledger })).toBe(false);
    },
  );

  it.each(['tasks', 'completions', 'occurrences'] as const)('rejects duplicate %s', (field) => {
    const value = snapshot();
    const entries = value[field];
    const duplicated: unknown = { ...value, [field]: [entries[0], entries[0]] };
    expect(() => readSyncSnapshot(duplicated)).toThrow();
  });

  it('rejects invalid nested records instead of returning a partially accepted snapshot', () => {
    expect(() => readSyncSnapshot({ ...snapshot(), timeZone: 'Imaginary/Clock' })).toThrow();
    expect(() =>
      readSyncSnapshot({ ...snapshot(), tasks: [{ task: task(), revision: '' }] }),
    ).toThrow();
    expect(() =>
      readSyncSnapshot({
        ...snapshot(),
        completions: [{ id: 'one', taskId: 'one', localDate: '2026-02-30', completedAt: AT }],
      }),
    ).toThrow();
    expect(() =>
      readSyncSnapshot({
        ...snapshot(),
        occurrences: [{ taskId: 'one', date: '2026-10-11', revision: {} }],
      }),
    ).toThrow();
  });
});
