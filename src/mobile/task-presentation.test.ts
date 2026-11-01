// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { MobileOutboxEntry, MobileState } from '../database/mobile-repository';
import type { DailyTask } from '../models/daily-task';
import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import {
  completionEstimate,
  confirmationMessage,
  confirmedCompletions,
  confirmedFromReceipts,
  creationEstimate,
  groupMobileTasks,
  pendingEstimate,
} from './task-presentation';

const now = new Date('2026-10-13T23:30:00Z');
const task = (id: string): DailyTask => ({
  id,
  schemaVersion: 1,
  title: id,
  notes: null,
  kind: 'routine',
  recurrence: 'daily',
  scheduledDate: null,
  scheduledTime: null,
  selectedWeekdays: [],
  linkedLearningItemId: null,
  priority: 'normal',
  archived: false,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
});
function state(
  outbox: MobileOutboxEntry[] = [],
  overrides: Partial<MobileState> = {},
): MobileState {
  return {
    epoch: 'epoch-1',
    snapshot: {
      version: 2,
      sequence: 1,
      taskSkips: [],
      epoch: 'epoch-1',
      generatedAt: now.toISOString(),
      timeZone: 'Asia/Shanghai',
      tasks: [
        { task: task('a'), revision: 'rev-1' },
        { task: task('b'), revision: 'rev-1' },
      ],
      completions: [],
      occurrences: [],
      wallet: { ...structuredClone(DEFAULT_ALLOWANCE), balance: 12 },
    },
    outbox,
    archives: [],
    ...overrides,
  };
}
const complete = (
  id: string,
  taskId: string,
  status: MobileOutboxEntry['status'] = 'pending',
): MobileOutboxEntry => ({
  id,
  epoch: 'epoch-1',
  operation: {
    id,
    kind: 'complete-task',
    at: now.toISOString(),
    date: '2026-10-14',
    timeZone: 'Asia/Shanghai',
    taskId,
    taskRevision: 'rev-1',
    occurrenceRevision: null,
  },
  attempted: true,
  status,
  receipt: null,
  sequence: 1,
});
const receipt = (
  entry: MobileOutboxEntry,
  reward: number,
  status: 'applied' | 'duplicate' | 'conflict' = 'applied',
) => ({
  ...entry,
  status: status === 'conflict' ? ('conflict' as const) : ('acknowledged' as const),
  receipt: { operationId: entry.id, status, reward, walletDelta: reward, message: '' },
});

describe('phone task order', () => {
  it("lists today's tasks first and overdue ones after them, oldest first", () => {
    const once = (id: string, date: string): DailyTask => ({
      ...task(id),
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: date,
    });
    const base = state();
    const groups = groupMobileTasks(
      {
        ...base,
        snapshot: {
          ...base.snapshot!,
          tasks: [
            { task: once('late-1', '2026-10-12'), revision: 'rev-1' },
            { task: task('daily'), revision: 'rev-1' },
            { task: once('late-2', '2026-10-10'), revision: 'rev-1' },
            { task: once('today', '2026-10-14'), revision: 'rev-1' },
          ],
        },
      },
      '2026-10-14',
    );
    expect(groups.open.map((row) => row.task.id)).toEqual(['daily', 'today', 'late-2', 'late-1']);
  });
});

describe('phone completion moments', () => {
  it('estimates only the reward the saved completion adds, whatever else changed', () => {
    const after = state([complete('c1', 'a')]);
    expect(completionEstimate(after, 'c1')).toBe(5);
    expect(completionEstimate(after, 'missing')).toBe(0);
    // Another pending completion in the outbox does not change this one's estimate.
    const both = state([complete('c0', 'b'), { ...complete('c1', 'a'), sequence: 2 }]);
    expect(completionEstimate(both, 'c1')).toBe(5);
  });

  it('confirms a pending completion once, when the computer acknowledges it', () => {
    const pending = complete('c1', 'a');
    const before = state([pending]);
    const acknowledged = state([receipt(pending, 5)]);
    expect(confirmedCompletions(before, acknowledged)).toEqual([
      { operationId: 'c1', taskId: 'a', amount: 5 },
    ]);
    // The acknowledged entry is no longer pending, so the next state cannot announce it again.
    const settled = state([], {
      snapshot: {
        ...state().snapshot!,
        completions: [
          { id: 'c1', taskId: 'a', localDate: '2026-10-14', completedAt: now.toISOString() },
        ],
        occurrences: [{ taskId: 'a', date: '2026-10-14', revision: 'r', rewardAmount: 5 }],
      },
    });
    expect(confirmedCompletions(acknowledged, settled)).toEqual([]);
  });

  it('reads the confirmed amount from the snapshot when the receipt was already applied', () => {
    const before = state([complete('c1', 'a')]);
    const after = state([], {
      snapshot: {
        ...state().snapshot!,
        sequence: 2,
        completions: [
          { id: 'c1', taskId: 'a', localDate: '2026-10-14', completedAt: now.toISOString() },
        ],
        occurrences: [{ taskId: 'a', date: '2026-10-14', revision: 'r', rewardAmount: null }],
      },
    });
    expect(confirmedCompletions(before, after)).toEqual([
      { operationId: 'c1', taskId: 'a', amount: null },
    ]);
  });

  it('never confirms on first load, epoch change, conflict, or a completion that vanished', () => {
    const pending = complete('c1', 'a');
    expect(confirmedCompletions(null, state([receipt(pending, 5)]))).toEqual([]);
    expect(
      confirmedCompletions(state([pending]), state([receipt(pending, 5)], { epoch: 'epoch-2' })),
    ).toEqual([]);
    expect(
      confirmedCompletions(state([pending]), state([receipt(pending, 0, 'conflict')])),
    ).toEqual([]);
    expect(confirmedCompletions(state([pending]), state([]))).toEqual([]);
    expect(
      confirmedCompletions(
        state([{ ...pending, status: 'isolated' }]),
        state([receipt(pending, 5)]),
      ),
    ).toEqual([]);
  });

  it('never confirms a completion that vanished without being sent or a new snapshot', () => {
    const completedSnapshot = {
      ...state().snapshot!,
      sequence: 2,
      completions: [
        { id: 'pc', taskId: 'a', localDate: '2026-10-14', completedAt: now.toISOString() },
      ],
      occurrences: [{ taskId: 'a', date: '2026-10-14', revision: 'r', rewardAmount: 5 }],
    };
    // Undone on the phone before it was ever sent, while the computer completed it itself.
    const unsent = { ...complete('c1', 'a'), attempted: false };
    expect(
      confirmedCompletions(state([unsent]), state([], { snapshot: completedSnapshot })),
    ).toEqual([]);
    // Sent, but the stored snapshot has not moved on yet.
    expect(
      confirmedCompletions(
        state([complete('c1', 'a')], { snapshot: { ...completedSnapshot, sequence: 1 } }),
        state([], { snapshot: { ...completedSnapshot, sequence: 1 } }),
      ),
    ).toEqual([]);
  });

  it('says what was confirmed, keeping unknown amounts unknown', () => {
    expect(confirmationMessage([{ operationId: 'a', taskId: 'a', amount: 5 }])).toBe('+5 元已到账');
    expect(confirmationMessage([{ operationId: 'a', taskId: 'a', amount: 0 }])).toBe(
      '电脑已确认完成',
    );
    expect(confirmationMessage([{ operationId: 'a', taskId: 'a', amount: null }])).toBe(
      '电脑已确认完成',
    );
    expect(
      confirmationMessage([
        { operationId: 'a', taskId: 'a', amount: 5 },
        { operationId: 'b', taskId: 'b', amount: 5 },
      ]),
    ).toBe('+10 元已到账');
    expect(
      confirmationMessage([
        { operationId: 'a', taskId: 'a', amount: null },
        { operationId: 'b', taskId: 'b', amount: 0 },
      ]),
    ).toBe('电脑已确认 2 项完成');
  });
});

const create = (
  id: string,
  taskId: string,
  status: MobileOutboxEntry['status'] = 'pending',
): MobileOutboxEntry => ({
  id,
  epoch: 'epoch-1',
  operation: { id, kind: 'create-task', at: now.toISOString(), task: task(taskId) },
  attempted: false,
  status,
  receipt: null,
  sequence: 2,
});

describe('phone creation moments', () => {
  it('estimates the creation reward only for a pending create in the current epoch', () => {
    expect(creationEstimate(state([create('n1', 'new')]), 'n1')).toBe(5);
    expect(creationEstimate(state([create('n1', 'new')]), 'missing')).toBe(0);
    // Sent and confirmed already (a replayed save), a conflict, isolated or an old epoch.
    expect(creationEstimate(state([receipt(create('n1', 'new'), 5)]), 'n1')).toBe(0);
    expect(creationEstimate(state([receipt(create('n1', 'new'), 0, 'conflict')]), 'n1')).toBe(0);
    expect(creationEstimate(state([create('n1', 'new', 'isolated')]), 'n1')).toBe(0);
    expect(creationEstimate(state([{ ...create('n1', 'new'), epoch: 'old' }]), 'n1')).toBe(0);
    // Its reply was lost but the computer's snapshot already has the task: already paid.
    expect(creationEstimate(state([create('n1', 'a')]), 'n1')).toBe(0);
    // A completion entry is not a creation.
    expect(creationEstimate(state([complete('c1', 'a')]), 'c1')).toBe(0);
  });

  it('counts pending creations in the estimate once, beside completions', () => {
    const outbox = [
      create('n1', 'new'),
      { ...create('n1-again', 'new'), sequence: 3 },
      create('n2', 'other'),
      { ...complete('c1', 'a'), sequence: 4 },
      receipt(create('n3', 'paid'), 5),
    ];
    expect(pendingEstimate(state(outbox))).toBe(15);
    expect(completionEstimate(state(outbox), 'c1')).toBe(5);
    expect(creationEstimate(state(outbox), 'n2')).toBe(5);
  });

  it('confirms a created task once by its receipt, and says so without inventing money', () => {
    const pending = create('n1', 'new');
    expect(confirmedCompletions(state([pending]), state([receipt(pending, 5)]))).toEqual([
      { operationId: 'n1', taskId: 'new', amount: 5, kind: 'create-task' },
    ]);
    expect(
      confirmedCompletions(state([pending]), state([receipt(pending, 0, 'conflict')])),
    ).toEqual([]);
    // A vanished creation is never guessed from a snapshot.
    expect(
      confirmedCompletions(
        state([pending]),
        state([], { snapshot: { ...state().snapshot!, sequence: 2 } }),
      ),
    ).toEqual([]);
    expect(
      confirmationMessage([{ operationId: 'n1', taskId: 'new', amount: 5, kind: 'create-task' }]),
    ).toBe('+5 元已到账');
    expect(
      confirmationMessage([{ operationId: 'n1', taskId: 'new', amount: 0, kind: 'create-task' }]),
    ).toBe('电脑已确认新增待办');
    expect(
      confirmationMessage([
        { operationId: 'n1', taskId: 'new', amount: 5, kind: 'create-task' },
        { operationId: 'c1', taskId: 'a', amount: 5 },
      ]),
    ).toBe('+10 元已到账');
    expect(
      confirmationMessage([
        { operationId: 'n1', taskId: 'new', amount: 0, kind: 'create-task' },
        { operationId: 'c1', taskId: 'a', amount: null },
      ]),
    ).toBe('电脑已确认 2 项');
  });

  it('reads the sync summary receipts in the confirmation shape', () => {
    expect(
      confirmedFromReceipts([
        { operationId: 'c1', kind: 'complete-task', taskId: 'a', reward: 5 },
        { operationId: 'n1', kind: 'create-task', taskId: 'new', reward: 5 },
      ]),
    ).toEqual([
      { operationId: 'c1', taskId: 'a', amount: 5 },
      { operationId: 'n1', taskId: 'new', amount: 5, kind: 'create-task' },
    ]);
  });
});
