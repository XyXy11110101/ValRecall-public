import { describe, expect, it, vi } from 'vitest';
import { saveTaskDraft, saveTaskDraftWithReward } from './task-save';
import { applyTaskCreationReward, DEFAULT_ALLOWANCE } from '../shared/allowance';
import { createDefaultTaskDraft } from './TaskForm';
import type { DailyTask } from '../models/daily-task';

describe('task draft identity', () => {
  it('keeps an id over failure/retry and recognizes a committed task after a lost response', async () => {
    const values = { ...createDefaultTaskDraft('2026-10-20'), title: 'Read' };
    let stored: DailyTask | undefined;
    const port = {
      getTask: vi.fn(async () => stored),
      createTask: vi.fn(async () => {
        stored = {
          ...values,
          id: 'stable',
          schemaVersion: 1,
          archived: false,
          createdAt: '',
          updatedAt: '',
        };
        throw new Error('response lost');
      }),
    };
    expect((await saveTaskDraft(port, 'stable', values)).id).toBe('stable');
    await saveTaskDraft(port, 'stable', values);
    expect(port.createTask).toHaveBeenCalledOnce();
    expect(port.createTask).toHaveBeenCalledWith({ ...values, id: 'stable' });
  });

  it('surfaces a failed write and retries the same id without reporting success first', async () => {
    const values = { ...createDefaultTaskDraft('2026-10-20'), title: 'Read' };
    const port = { createTask: vi.fn().mockRejectedValue(new Error('disk full')) };
    await expect(saveTaskDraft(port, 'stable', values)).rejects.toThrow('disk full');
    await expect(saveTaskDraft(port, 'stable', values)).rejects.toThrow('disk full');
    expect(port.createTask.mock.calls.map(([input]) => input.id)).toEqual(['stable', 'stable']);
  });

  it('reports the committed grant only for the call that created the task', async () => {
    const values = { ...createDefaultTaskDraft('2026-10-20'), title: 'Read' };
    const reward = applyTaskCreationReward(DEFAULT_ALLOWANCE, '2026-10-20');
    let stored: DailyTask | undefined;
    const port = {
      getTask: vi.fn(async () => stored),
      createTask: vi.fn(),
      createTaskWithReward: vi.fn(async (input: DailyTask) => {
        stored = { ...input, schemaVersion: 1, archived: false, createdAt: '', updatedAt: '' };
        return { task: stored, reward };
      }),
    };
    const first = await saveTaskDraftWithReward(port, 'fresh', values);
    expect(first.reward).toEqual(reward);
    expect(first.task.id).toBe('fresh');
    // A retry finds the task already saved: no second grant is reported.
    expect((await saveTaskDraftWithReward(port, 'fresh', values)).reward).toBeNull();
    expect(port.createTaskWithReward).toHaveBeenCalledOnce();
    expect(port.createTask).not.toHaveBeenCalled();
  });

  it('reports no grant for a task recovered after a lost response, or without a receipt port', async () => {
    const values = { ...createDefaultTaskDraft('2026-10-20'), title: 'Read' };
    let stored: DailyTask | undefined;
    const lost = {
      getTask: vi.fn(async () => stored),
      createTask: vi.fn(),
      createTaskWithReward: vi.fn(async (input: DailyTask) => {
        stored = { ...input, schemaVersion: 1, archived: false, createdAt: '', updatedAt: '' };
        throw new Error('response lost');
      }),
    };
    expect(await saveTaskDraftWithReward(lost, 'lost', values)).toMatchObject({
      task: { id: 'lost' },
      reward: null,
    });
    const plain = {
      createTask: vi.fn(async (input: DailyTask) => ({
        ...input,
        schemaVersion: 1 as const,
        archived: false,
        createdAt: '',
        updatedAt: '',
      })),
    };
    expect((await saveTaskDraftWithReward(plain, 'plain', values)).reward).toBeNull();
  });
});
