// @vitest-environment node

import { IDBFactory } from 'fake-indexeddb';
import { createEmptyCard } from 'ts-fsrs';
import { beforeEach, describe, expect, it } from 'vitest';

import { DAILY_TASK_SCHEMA_VERSION, type NewDailyTask } from '../models/daily-task';
import { ValRecallRepository } from './repository';
import { EXPORT_SCHEMA_VERSION, type NewVideoLearningItem } from './types';

const initialNow = new Date(2026, 6, 20, 23, 30);

function learningItem(id: string): NewVideoLearningItem {
  return {
    id,
    platform: 'bilibili',
    sourceUrl: `https://www.bilibili.com/video/${id}`,
    videoId: id,
    videoTitle: `Lesson ${id}`,
    timestampSeconds: 30,
    timestampDisplay: '00:30',
    itemType: 'Do',
    coreLesson: 'Practise one angle at a time.',
    recallPrompt: 'What should you practise?',
    referenceAnswer: 'One angle at a time.',
    fsrsCard: createEmptyCard(initialNow),
  };
}

function routine(overrides: Partial<NewDailyTask> = {}): NewDailyTask {
  return {
    title: 'Warm up deliberately',
    kind: 'routine',
    recurrence: 'daily',
    ...overrides,
  };
}

describe('ValRecallRepository daily tasks', () => {
  let repository: ValRecallRepository;
  let factory: IDBFactory;
  let now: Date;
  let sequence: number;

  beforeEach(() => {
    factory = new IDBFactory();
    now = new Date(initialNow);
    sequence = 0;
    repository = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'task-repository',
      clock: () => new Date(now),
      idGenerator: () => `generated-${(sequence += 1)}`,
    });
  });

  it('reports only one created completion across competing connections and keeps the legacy return shape', async () => {
    await repository.createTask(routine({ id: 'same' }));
    const other = new ValRecallRepository({
      indexedDBFactory: factory,
      databaseName: 'task-repository',
      clock: () => now,
    });
    try {
      const results = await Promise.all([
        repository.completeTaskForDateWithResult('same'),
        other.completeTaskForDateWithResult('same'),
      ]);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(results[0]!.completion).toEqual(results[1]!.completion);
      expect(await repository.completeTaskForDate('same')).toEqual(results[0]!.completion);
      expect(await repository.undoTaskCompletion('same', '2026-07-20')).toBe(true);
      expect(await other.undoTaskCompletion('same', '2026-07-20')).toBe(false);
    } finally {
      other.close();
    }
  });

  it('creates, validates, updates, filters and archives task definitions', async () => {
    const created = await repository.createTask(
      routine({ id: 'daily', title: ' 每日热身 ', priority: 'high', scheduledTime: '09:15' }),
    );
    expect(created).toMatchObject({
      id: 'daily',
      schemaVersion: DAILY_TASK_SCHEMA_VERSION,
      title: '每日热身',
      priority: 'high',
      archived: false,
    });

    now = new Date(2026, 6, 21, 8, 0);
    const updated = await repository.updateTask('daily', {
      notes: 'Keep the routine short.',
      recurrence: 'selected_weekdays',
      selectedWeekdays: [3, 1],
    });
    expect(updated.selectedWeekdays).toEqual([1, 3]);
    expect(updated.updatedAt).toBe(now.toISOString());
    await expect(
      repository.listTasks({ priority: 'high', status: 'active' }),
    ).resolves.toHaveLength(1);
    await repository.archiveTask('daily');
    await expect(repository.listTasks({ status: 'active' })).resolves.toEqual([]);
    await expect(repository.listTasks({ status: 'archived' })).resolves.toMatchObject([
      { id: 'daily', archived: true },
    ]);

    await expect(
      repository.createTask(routine({ id: 'invalid-weekdays', recurrence: 'selected_weekdays' })),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
    await expect(
      repository.createTask({
        id: 'invalid-once',
        title: 'Once',
        kind: 'one_off',
        recurrence: 'daily',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATA' });
  });

  it('validates practice links and clears the link when its learning item is deleted', async () => {
    await expect(
      repository.createTask({
        id: 'missing-link',
        title: 'Practise the lesson',
        kind: 'practice',
        recurrence: 'specific_date',
        scheduledDate: '2026-07-21',
        linkedLearningItemId: 'missing-item',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await repository.createItem(learningItem('BV1linked'), new Blob(['image']));
    await repository.createTask({
      id: 'linked-practice',
      title: 'Practise one angle',
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-21',
      linkedLearningItemId: 'BV1linked',
    });

    await repository.updateTask('linked-practice', { linkedLearningItemId: null });
    await expect(repository.getTask('linked-practice')).resolves.toMatchObject({
      linkedLearningItemId: null,
    });
    await repository.updateTask('linked-practice', { linkedLearningItemId: 'BV1linked' });

    await repository.deleteItem('BV1linked');

    await expect(repository.getTask('linked-practice')).resolves.toMatchObject({
      linkedLearningItemId: null,
    });
  });

  it('preserves recurring completion history when the task definition is edited', async () => {
    await repository.createTask(routine({ id: 'editable-daily', scheduledTime: '08:00' }));
    const completion = await repository.completeTaskForDate('editable-daily', '2026-07-20');

    now = new Date(2026, 6, 21, 12, 0);
    await repository.updateTask('editable-daily', {
      title: 'Edited daily routine',
      notes: 'The old completion must remain a historical fact.',
      scheduledTime: '09:30',
    });

    await expect(repository.listTaskCompletions('editable-daily')).resolves.toEqual([completion]);
    await expect(repository.getTaskDaySummary('2026-07-20')).resolves.toMatchObject({
      total: 1,
      completed: 1,
      remaining: 0,
    });
    await expect(repository.getTaskDaySummary('2026-07-21')).resolves.toMatchObject({
      total: 1,
      completed: 0,
      remaining: 1,
    });
  });

  it('projects local-day totals, completion and recurrence without changing definitions', async () => {
    await repository.createTask(routine({ id: 'daily', scheduledTime: '10:00' }));
    await repository.createTask(
      routine({
        id: 'monday',
        recurrence: 'selected_weekdays',
        selectedWeekdays: [1],
        scheduledTime: '09:00',
      }),
    );
    await repository.createTask({
      id: 'one-off',
      title: 'Play two focused matches',
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-20',
    });
    await repository.createTask(routine({ id: 'archived', archived: true }));

    const before = await repository.getTaskDaySummary('2026-07-20');
    expect(before).toMatchObject({ total: 3, completed: 0, remaining: 3 });
    expect(before.occurrences.map((entry) => entry.task.id)).toEqual([
      'monday',
      'daily',
      'one-off',
    ]);

    const first = await repository.completeTaskForDate('daily', '2026-07-20');
    const duplicate = await repository.completeTaskForDate('daily', '2026-07-20');
    expect(duplicate.id).toBe(first.id);
    await expect(repository.listTaskCompletions('daily')).resolves.toHaveLength(1);
    await expect(repository.getTaskDaySummary('2026-07-20')).resolves.toMatchObject({
      total: 3,
      completed: 1,
      remaining: 2,
    });
    await expect(repository.getTaskDaySummary('2026-07-21')).resolves.toMatchObject({
      total: 2,
      completed: 0,
      remaining: 2,
    });
    await expect(repository.countRemainingTasksToday(new Date(2026, 6, 20, 23, 59))).resolves.toBe(
      2,
    );

    await expect(repository.undoTaskCompletion('daily', '2026-07-20')).resolves.toBe(true);
    await expect(repository.undoTaskCompletion('daily', '2026-07-20')).resolves.toBe(false);
    await expect(repository.getTaskDaySummary('2026-07-20')).resolves.toMatchObject({
      completed: 0,
      remaining: 3,
    });
  });

  it('retains one-off completion history after its date and reopens it only by undo', async () => {
    await repository.createTask({
      id: 'once',
      title: 'Explain the lesson aloud',
      kind: 'one_off',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-20',
    });
    await repository.completeTaskForDate('once', '2026-07-20');

    await expect(repository.getTaskDaySummary('2026-07-20')).resolves.toMatchObject({
      total: 1,
      completed: 1,
      remaining: 0,
    });
    await expect(repository.getTaskDaySummary('2026-07-21')).resolves.toMatchObject({ total: 0 });
    await expect(repository.listTaskCompletions('once')).resolves.toHaveLength(1);

    await repository.undoTaskCompletion('once', '2026-07-20');
    await expect(repository.getTaskDaySummary('2026-07-20')).resolves.toMatchObject({
      completed: 0,
      remaining: 1,
    });
  });

  it('keeps FSRS bytes unchanged and cascades completions only when deleting the task', async () => {
    await repository.createItem(learningItem('BV1fsrs'), new Blob(['image']));
    await repository.createTask(routine({ id: 'task-with-completion' }));
    const before = (await repository.exportData()).items[0];

    await repository.completeTaskForDate('task-with-completion', '2026-07-20');

    const after = (await repository.exportData()).items[0];
    expect(after).toEqual(before);
    await repository.deleteTask('task-with-completion');
    await expect(repository.getTask('task-with-completion')).resolves.toBeUndefined();
    await expect(repository.listTaskCompletions('task-with-completion')).resolves.toEqual([]);
    await expect(repository.getItem('BV1fsrs')).resolves.toBeDefined();
  });

  it('round-trips tasks in full and task-only exports and clears unresolved imported links', async () => {
    await repository.createItem(learningItem('BV1export'), new Blob(['image']));
    await repository.createTask({
      id: 'export-practice',
      title: 'Apply the lesson',
      notes: '中文和 English remain intact.',
      kind: 'practice',
      recurrence: 'specific_date',
      scheduledDate: '2026-07-20',
      linkedLearningItemId: 'BV1export',
    });
    await repository.completeTaskForDate('export-practice', '2026-07-20');

    const full = await repository.exportData();
    expect(full.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(full.tasks).toHaveLength(1);
    expect(full.taskCompletions).toHaveLength(1);
    const taskOnly = await repository.exportTasks();

    const emptyRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'task-import-with-missing-link',
      clock: () => new Date(initialNow),
      idGenerator: () => 'import-id',
    });
    await expect(emptyRepository.importTasks(taskOnly, 'replace')).resolves.toEqual({
      tasks: 1,
      taskCompletions: 1,
    });
    await expect(emptyRepository.getTask('export-practice')).resolves.toMatchObject({
      linkedLearningItemId: null,
      notes: '中文和 English remain intact.',
    });

    const fullWithUnknownLink = structuredClone(full);
    if (!fullWithUnknownLink.tasks[0]) throw new Error('Expected a full task export fixture.');
    fullWithUnknownLink.tasks[0].linkedLearningItemId = 'missing-after-full-import';
    const fullImportRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'full-import-with-missing-link',
      clock: () => new Date(initialNow),
    });
    await fullImportRepository.importData(fullWithUnknownLink, 'replace');
    await expect(fullImportRepository.getTask('export-practice')).resolves.toMatchObject({
      linkedLearningItemId: null,
    });

    const mergeIntoExisting = structuredClone(full);
    mergeIntoExisting.items = [];
    mergeIntoExisting.reviews = [];
    mergeIntoExisting.screenshots = [];
    const mergeRepository = new ValRecallRepository({
      indexedDBFactory: new IDBFactory(),
      databaseName: 'full-merge-with-existing-link',
      clock: () => new Date(initialNow),
    });
    await mergeRepository.createItem(learningItem('BV1export'), new Blob(['existing-image']));
    await mergeRepository.importData(mergeIntoExisting, 'merge');
    await expect(mergeRepository.getTask('export-practice')).resolves.toMatchObject({
      linkedLearningItemId: 'BV1export',
    });

    await repository.clearAll();
    await expect(repository.importData(full, 'replace')).resolves.toMatchObject({
      items: 1,
      tasks: 1,
      taskCompletions: 1,
    });
    await expect(repository.getTask('export-practice')).resolves.toMatchObject({
      linkedLearningItemId: 'BV1export',
    });
  });

  it('accepts schema-v2 backups without tasks and rejects malformed task graphs atomically', async () => {
    await repository.createItem(learningItem('BV1legacy'), new Blob(['image']));
    const current = await repository.exportData();
    const { tasks: _tasks, taskCompletions: _taskCompletions, ...legacyFields } = current;
    void _tasks;
    void _taskCompletions;
    const legacy = { ...legacyFields, schemaVersion: 2 };

    await repository.createTask(routine({ id: 'replace-me' }));
    Reflect.deleteProperty(legacy, 'notes');
    Reflect.deleteProperty(legacy, 'intakeReceipts');
    await expect(repository.importData(legacy, 'replace')).resolves.toMatchObject({
      items: 1,
      tasks: 0,
      taskCompletions: 0,
    });
    await expect(repository.listTasks()).resolves.toEqual([]);

    const keep = await repository.createTask(routine({ id: 'keep-task' }));
    const malformed = await repository.exportTasks();
    if (!malformed.tasks[0]) throw new Error('Expected a task export fixture.');
    malformed.tasks[0].selectedWeekdays = [7];
    await expect(repository.importTasks(malformed, 'replace')).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    await expect(repository.getTask(keep.id)).resolves.toMatchObject({ id: 'keep-task' });

    const brokenCompletion = await repository.exportTasks();
    brokenCompletion.taskCompletions.push({
      id: 'broken-completion',
      taskId: 'missing-task',
      localDate: '2026-07-20',
      completedAt: initialNow.toISOString(),
    });
    await expect(repository.importTasks(brokenCompletion)).rejects.toMatchObject({
      code: 'INVALID_DATA',
    });
    await expect(repository.getTask(keep.id)).resolves.toMatchObject({ id: 'keep-task' });
  });
});
