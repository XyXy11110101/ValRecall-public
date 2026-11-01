// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { TASK_ALL_DONE_PRAISES, TASK_LATE_PRAISES, TASK_PRAISES } from './allowance';
import {
  TASK_ALREADY_COMPLETED_MESSAGE,
  TASK_ALREADY_OPEN_MESSAGE,
  taskCelebrationFor,
  taskChangeMessage,
  taskCompletionMessage,
  taskCreationCelebrationFor,
  taskCreationMessage,
  taskPraise,
  taskUndoMessage,
  type CommittedTaskChange,
} from './task-celebration';

const today = '2026-10-24';
const rewarded = (amount = 5, seq = 7): CommittedTaskChange => ({
  changed: true,
  reward: { state: { ledgerSeq: seq, ledger: [{ id: `al-${seq}` }] }, reward: amount },
  warning: null,
});
const input = (overrides: Partial<Parameters<typeof taskCelebrationFor>[0]> = {}) => ({
  completing: true,
  result: rewarded(),
  taskId: 'task',
  localDate: today,
  today,
  remainingToday: 2,
  fallbackId: 'fallback',
  ...overrides,
});

describe('todo completion celebration gating', () => {
  it('celebrates a committed reward with its receipt id and actual amount', () => {
    expect(taskCelebrationFor(input())).toEqual({
      id: 'al-7',
      taskId: 'task',
      localDate: today,
      amount: 5,
      kind: 'rewarded',
      praise: TASK_PRAISES[7 % TASK_PRAISES.length],
    });
    expect(taskCelebrationFor(input({ result: rewarded(2) }))?.amount).toBe(2);
  });

  it('never celebrates an undo, even though undo reports the reversed amount', () => {
    expect(taskCelebrationFor(input({ completing: false }))).toBeNull();
  });

  it('never celebrates a change that was not committed by this call', () => {
    expect(taskCelebrationFor(input({ result: { ...rewarded(), changed: false } }))).toBeNull();
  });

  it('stamps without a coin when the reward could not be confirmed', () => {
    const celebration = taskCelebrationFor(
      input({ result: { ...rewarded(), warning: '历史奖励金额无法确认' } }),
    );
    expect(celebration?.amount).toBe(0);
    expect(celebration?.kind).toBe('plain');
  });

  it('thanks a late, unrewarded completion without inventing money', () => {
    const celebration = taskCelebrationFor(
      input({
        localDate: '2026-10-22',
        result: { changed: true, reward: null, warning: null },
        fallbackId: 'late-id',
      }),
    );
    expect(celebration).toMatchObject({ id: 'late-id', amount: 0, kind: 'late' });
    expect(celebration?.praise).toBe(TASK_LATE_PRAISES[0]);
  });

  it('marks the last open item of today as the all-done moment', () => {
    const celebration = taskCelebrationFor(input({ remainingToday: 0 }));
    expect(celebration?.kind).toBe('all-done');
    expect(TASK_ALL_DONE_PRAISES).toContain(celebration?.praise);
    expect(taskCelebrationFor(input({ remainingToday: null }))?.kind).toBe('rewarded');
  });

  it('picks praise deterministically, without randomness', () => {
    expect(taskPraise(3, 'rewarded')).toBe(taskPraise(3, 'rewarded'));
    expect(taskPraise(-8, 'rewarded')).toBe(TASK_PRAISES[8 % TASK_PRAISES.length]);
    const a = taskCelebrationFor(input({ result: { changed: true, reward: null, warning: null } }));
    const b = taskCelebrationFor(input({ result: { changed: true, reward: null, warning: null } }));
    expect(a?.praise).toBe(b?.praise);
  });

  it('keeps the existing receipt wording and states an undo plainly', () => {
    expect(taskCompletionMessage('rewarded', 5)).toBe('已完成，+5 元零花钱。');
    expect(taskCompletionMessage('plain', 0)).toBe('已完成。');
    expect(taskCompletionMessage('all-done', 5)).toBe('今天的待办都完成了，+5 元零花钱。');
    expect(taskCompletionMessage('all-done', 0)).toBe('今天的待办都完成了。');
    expect(taskUndoMessage(5)).toBe('已撤销完成，零花钱 −5 元。');
    expect(taskUndoMessage(0)).toBe('已撤销完成。');
  });

  it('keeps every praise line short enough for a two-line bubble', () => {
    for (const line of [...TASK_PRAISES, ...TASK_ALL_DONE_PRAISES, ...TASK_LATE_PRAISES]) {
      expect(line.length).toBeLessThanOrEqual(16);
      expect(line).toMatch(/./u);
    }
  });
});

describe('todo creation grant', () => {
  const grant = (amount = 5, id = 'al-11') => ({ state: { ledger: [{ id }] }, reward: amount });

  it('shows a coin only for a grant this call committed, keyed by its ledger entry', () => {
    expect(
      taskCreationCelebrationFor({ taskId: 'new', localDate: today, reward: grant() }),
    ).toEqual({
      id: 'al-11',
      taskId: 'new',
      localDate: today,
      amount: 5,
      kind: 'created',
      praise: '',
    });
    // No receipt (an existing task or a recovered lost response), no money, or a warning.
    expect(
      taskCreationCelebrationFor({ taskId: 'new', localDate: today, reward: null }),
    ).toBeNull();
    expect(
      taskCreationCelebrationFor({ taskId: 'new', localDate: today, reward: grant(0) }),
    ).toBeNull();
    expect(
      taskCreationCelebrationFor({
        taskId: 'new',
        localDate: today,
        reward: grant(),
        warning: '奖励未确认',
      }),
    ).toBeNull();
    expect(
      taskCreationCelebrationFor({
        taskId: 'new',
        localDate: today,
        reward: { state: { ledger: [] }, reward: 5 },
      }),
    ).toBeNull();
  });

  it('words the creation like the computer receipt and shares completion wording', () => {
    expect(taskCreationMessage(5)).toBe('待办已创建，+5 元零花钱。');
    expect(taskCreationMessage(0)).toBe('待办已创建。');
    const celebration = taskCelebrationFor(input());
    expect(taskChangeMessage({ completing: true, result: rewarded(), celebration })).toBe(
      '已完成，+5 元零花钱。',
    );
    expect(
      taskChangeMessage({
        completing: false,
        result: { ...rewarded(), changed: true },
        celebration: null,
      }),
    ).toBe('已撤销完成，零花钱 −5 元。');
    expect(
      taskChangeMessage({
        completing: false,
        result: { changed: true, reward: null, warning: null },
        celebration: null,
      }),
    ).toBe('已撤销完成。');
  });

  it('never claims a completion or an undo that committed nothing', () => {
    // Another device already reopened or completed the occurrence; the list was stale.
    expect(
      taskChangeMessage({
        completing: false,
        result: { changed: false, reward: null, warning: null },
        celebration: null,
      }),
    ).toBe(TASK_ALREADY_OPEN_MESSAGE);
    expect(TASK_ALREADY_OPEN_MESSAGE).toBe('这项待办还没完成。');
    expect(
      taskChangeMessage({
        completing: true,
        result: { ...rewarded(), changed: false },
        celebration: null,
      }),
    ).toBe(TASK_ALREADY_COMPLETED_MESSAGE);
    expect(TASK_ALREADY_COMPLETED_MESSAGE).toBe('这项待办已经完成了。');
  });
});
