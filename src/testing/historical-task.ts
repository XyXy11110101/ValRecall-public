import type { DailyTask } from '../models/daily-task';
import type { DatabaseOpener } from '../database/wallet';
import { STORE_NAMES } from '../database/migrations';
import { transactionComplete } from '../database/idb';
import { bumpTaskRevision } from '../database/sync-repository';

/** Seed pre-creation-reward data for migration/completion tests, without granting new money. */
export async function seedHistoricalTask(
  database: DatabaseOpener,
  now: Date,
  id = 'task-one',
  title = 'Synthetic task',
): Promise<DailyTask> {
  const task: DailyTask = {
    id,
    title,
    schemaVersion: 1,
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
  };
  const tx = (await database.open()).transaction(
    [STORE_NAMES.dailyTasks, STORE_NAMES.taskRevisions, STORE_NAMES.wallet],
    'readwrite',
  );
  const done = transactionComplete(tx);
  tx.objectStore(STORE_NAMES.dailyTasks).add(task);
  bumpTaskRevision(tx, id);
  await done;
  return task;
}
