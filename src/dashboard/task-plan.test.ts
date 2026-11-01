import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from '../database/repository';
import { editState } from '../database/edit-commit';
import type { DailyTask } from '../models/daily-task';
import { TASK_REWARD } from '../shared/allowance';
import { applyTaskPlan, rowPlanActions, undoTaskPlan, type TaskPlanPort } from './task-plan';

function task(changes: Partial<DailyTask> = {}): DailyTask {
  return {
    id: 'a',
    schemaVersion: 1,
    title: 'A',
    notes: null,
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: '2026-10-28',
    scheduledTime: null,
    selectedWeekdays: [],
    linkedLearningItemId: null,
    priority: 'normal',
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...changes,
  };
}
const port = (): TaskPlanPort & {
  changeTaskSkipAtomic: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  archiveTask: ReturnType<typeof vi.fn>;
} => ({
  changeTaskSkipAtomic: vi.fn().mockResolvedValue({ changed: true }),
  updateTask: vi.fn().mockResolvedValue(task()),
  archiveTask: vi.fn().mockResolvedValue(task()),
});
const now = new Date(2026, 9, 30, 12);
const row = (t: DailyTask, localDate: string) => ({ task: t, localDate, completion: null });

describe('task plan actions', () => {
  it('chooses by recurrence, not kind', () => {
    expect(rowPlanActions(task())).toEqual(['move-tomorrow', 'drop']);
    expect(rowPlanActions(task({ recurrence: 'daily', scheduledDate: null }))).toEqual([
      'skip-today',
    ]);
    expect(rowPlanActions(task({ kind: 'practice' }))).toEqual(['move-tomorrow', 'drop']);
    expect(
      rowPlanActions(
        task({ kind: 'practice', recurrence: 'selected_weekdays', scheduledDate: null }),
      ),
    ).toEqual(['skip-today']);
  });

  it('skips a recurring occurrence and restores that same occurrence', async () => {
    const plan = port();
    const daily = task({ recurrence: 'daily', scheduledDate: null });
    const receipt = await applyTaskPlan(plan, row(daily, '2026-10-30'), 'skip-today', now);
    expect(plan.changeTaskSkipAtomic).toHaveBeenLastCalledWith('skip-task', 'a', '2026-10-30', now);
    await undoTaskPlan(plan, receipt, now);
    expect(plan.changeTaskSkipAtomic).toHaveBeenLastCalledWith(
      'restore-task',
      'a',
      '2026-10-30',
      now,
    );
    expect(plan.updateTask).not.toHaveBeenCalled();
    expect(plan.archiveTask).not.toHaveBeenCalled();
  });

  it('moves to tomorrow from the clock, across a month end, and undo restores the old date', async () => {
    const plan = port();
    const receipt = await applyTaskPlan(
      plan,
      row(task(), '2026-10-28'),
      'move-tomorrow',
      new Date(2026, 9, 31, 12),
    );
    expect(plan.updateTask).toHaveBeenLastCalledWith('a', { scheduledDate: '2026-11-01' });
    await undoTaskPlan(plan, receipt, now);
    expect(plan.updateTask).toHaveBeenLastCalledWith('a', { scheduledDate: '2026-10-28' });
  });

  it('drops by archiving, and undo un-archives', async () => {
    const plan = port();
    const receipt = await applyTaskPlan(plan, row(task(), '2026-10-30'), 'drop', now);
    expect(plan.archiveTask).toHaveBeenLastCalledWith('a', true);
    await undoTaskPlan(plan, receipt, now);
    expect(plan.archiveTask).toHaveBeenLastCalledWith('a', false);
  });

  it('passes a failure on so the caller can report it', async () => {
    const plan = port();
    plan.archiveTask.mockRejectedValue(new Error('disk'));
    await expect(applyTaskPlan(plan, row(task(), '2026-10-30'), 'drop', now)).rejects.toThrow(
      'disk',
    );
  });
});

describe('a note saved through the plan port', () => {
  function repository() {
    const clock = { now: new Date(2026, 9, 30, 12) };
    return {
      clock,
      repo: new ValRecallRepository({
        indexedDBFactory: new IDBFactory(),
        databaseName: 'task-plan-note',
        clock: () => clock.now,
      }),
    };
  }
  const draft = {
    title: '写论文第三节',
    kind: 'one_off',
    recurrence: 'specific_date',
    scheduledDate: '2026-10-30',
  } as const;

  it('is the repository call the port stands for, and empty is stored as null', async () => {
    const { repo } = repository();
    const plan: TaskPlanPort = repo;
    const task = await repo.createTask(draft);
    expect((await plan.updateTask(task.id, { notes: '第三节先写结论' })).notes).toBe(
      '第三节先写结论',
    );
    expect((await plan.updateTask(task.id, { notes: null })).notes).toBeNull();
    expect((await repo.getTask(task.id))?.notes).toBeNull();
    repo.close();
  });

  it('gives the task an edit form can still save over, and only that one', async () => {
    const { repo, clock } = repository();
    const task = await repo.createTask(draft);
    clock.now = new Date(2026, 9, 30, 12, 1);
    const saved = await repo.updateTask(task.id, { notes: '第三节先写结论' });
    await expect(
      repo.updateTask(task.id, { title: '旧版本' }, { expectedState: editState(task) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      repo.updateTask(task.id, { title: '新标题' }, { expectedState: editState(saved) }),
    ).resolves.toMatchObject({ title: '新标题', notes: '第三节先写结论' });
    repo.close();
  });

  it('stays on the task after it is completed, and moves no money', async () => {
    const { repo, clock } = repository();
    const task = await repo.createTask(draft);
    await repo.updateTask(task.id, { notes: '第三节先写结论' });
    const result = await repo.changeTaskCompletionAtomic(task.id, '2026-10-30', true, clock.now);
    expect(result.reward?.reward).toBe(TASK_REWARD);
    await repo.updateTask(task.id, { notes: '写完以后又想到一点' });
    const overview = await repo.getHomeTaskOverview('2026-10-30');
    expect(overview.completed.map((row) => row.task.notes)).toEqual(['写完以后又想到一点']);
    const again = await repo.changeTaskCompletionAtomic(task.id, '2026-10-30', true, clock.now);
    expect(again.changed).toBe(false);
    repo.close();
  });
});
