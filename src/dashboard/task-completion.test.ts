import { describe, expect, it, vi } from 'vitest';
import { changeTaskCompletion, type TaskCompletionPort } from './task-completion';
import { applyTaskCompletionReward, DEFAULT_ALLOWANCE } from '../shared/allowance';

const now = new Date(2026, 9, 1, 12);
const date = '2026-10-01';
function fixture() {
  let completed = false;
  const calls: string[] = [];
  const port: TaskCompletionPort = {
    complete: vi.fn(async () => {
      calls.push('complete');
      const created = !completed;
      completed = true;
      return {
        created,
        completion: { id: 'c', taskId: 't', localDate: date, completedAt: now.toISOString() },
      };
    }),
    undo: vi.fn(async () => {
      calls.push('undo');
      const changed = completed;
      completed = false;
      return changed;
    }),
  };
  const rewards = {
    complete: vi.fn(async () => {
      calls.push('reward');
      return applyTaskCompletionReward(DEFAULT_ALLOWANCE, date);
    }),
    undo: vi.fn(async () => {
      calls.push('reverse');
      return applyTaskCompletionReward(DEFAULT_ALLOWANCE, date);
    }),
  };
  return { port, rewards, calls };
}
describe('task completion and allowance coordination', () => {
  it('uses the atomic repository port without any secondary task or wallet write', async () => {
    const { port, rewards } = fixture();
    const result = {
      changed: true,
      reward: applyTaskCompletionReward(DEFAULT_ALLOWANCE, date),
      warning: null,
    };
    port.atomic = vi.fn(async () => result);
    expect(await changeTaskCompletion(port, 't', date, true, now, rewards)).toBe(result);
    expect(port.atomic).toHaveBeenCalledWith('t', date, true, now);
    expect(port.complete).not.toHaveBeenCalled();
    expect(port.undo).not.toHaveBeenCalled();
    expect(rewards.complete).not.toHaveBeenCalled();
    expect(rewards.undo).not.toHaveBeenCalled();
    vi.mocked(port.atomic).mockRejectedValueOnce(new Error('atomic failure'));
    await expect(changeTaskCompletion(port, 't', date, true, now, rewards)).rejects.toThrow(
      'atomic failure',
    );
    expect(port.complete).not.toHaveBeenCalled();
  });
  it('serializes complete and undo with their rewards and ignores duplicate intent', async () => {
    const { port, rewards, calls } = fixture();
    const results = await Promise.all(
      [true, true, false, false].map((completed) =>
        changeTaskCompletion(port, 't', date, completed, now, rewards),
      ),
    );
    expect(results.map((result) => result.changed)).toEqual([true, false, true, false]);
    expect(calls).toEqual(['complete', 'reward', 'complete', 'undo', 'reverse', 'undo']);
    expect(rewards.complete).toHaveBeenCalledOnce();
    expect(rewards.undo).toHaveBeenCalledOnce();
  });
  it('retains saved completion on reward failure and never retries the award on repeated completion', async () => {
    const { port, rewards } = fixture();
    rewards.complete.mockRejectedValue(new Error('storage unavailable'));
    const result = await changeTaskCompletion(port, 't', date, true, now, rewards);
    expect(result.changed).toBe(true);
    expect(result.warning).toContain('零花钱没更新');
    expect(result.reward).toBeNull();
    expect((await changeTaskCompletion(port, 't', date, true, now, rewards)).changed).toBe(false);
    expect(rewards.complete).toHaveBeenCalledOnce();
  });
  it('does not award historical dates or failed content writes', async () => {
    const { port, rewards } = fixture();
    await changeTaskCompletion(port, 't', '2026-09-30', true, now, rewards);
    expect(rewards.complete).not.toHaveBeenCalled();
    vi.mocked(port.complete).mockRejectedValueOnce(new Error('write failed'));
    await expect(changeTaskCompletion(port, 'other', date, true, now, rewards)).rejects.toThrow(
      'write failed',
    );
    expect(rewards.complete).not.toHaveBeenCalled();
  });
});
