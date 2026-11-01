// @vitest-environment node
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from './repository';
import { STORE_NAMES } from './migrations';

describe('task overview repository boundary', () => {
  it('reads only three task stores in one readonly transaction and preserves original atomic settlement', async () => {
    const now = new Date(2026, 9, 20, 12);
    const repo = new ValRecallRepository({ indexedDBFactory: new IDBFactory(), clock: () => now });
    const t = await repo.createTask({
      title: '逾期',
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-10-18',
    });
    const db = await repo.open();
    const tx = vi.spyOn(db, 'transaction');
    const before = await repo.getHomeTaskOverview('2026-10-20');
    expect(before.overdue[0]?.task.id).toBe(t.id);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledWith(
      [STORE_NAMES.dailyTasks, STORE_NAMES.taskCompletions, STORE_NAMES.taskSkips],
      'readonly',
    );
    tx.mockRestore();
    const first = await repo.changeTaskCompletionAtomic(t.id, '2026-10-18', true, now);
    const again = await repo.changeTaskCompletionAtomic(t.id, '2026-10-18', true, now);
    expect(first.reward?.reward).toBe(5);
    expect(again.reward).toBeNull();
    const completed = await repo.getHomeTaskOverview('2026-10-20');
    expect(completed.overdue).toEqual([]);
    expect(completed.completed[0]?.localDate).toBe('2026-10-18');
    await repo.changeTaskCompletionAtomic(t.id, '2026-10-18', false, now);
    expect((await repo.getHomeTaskOverview('2026-10-20')).overdue).toHaveLength(1);
    await repo.close();
  });

  it('rejects invalid dates and storage failures instead of returning an empty result', async () => {
    const repo = new ValRecallRepository({ indexedDBFactory: new IDBFactory() });
    await expect(repo.getHomeTaskOverview('bad-date')).rejects.toThrow();
    vi.spyOn(repo, 'open').mockRejectedValue(new Error('read failed'));
    await expect(repo.getHomeTaskOverview('2026-10-20')).rejects.toThrow('read failed');
  });
});
