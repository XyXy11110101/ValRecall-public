import { isCapturePageResponse } from '../models/messages';
import { captureSourceDraft } from './capture-source-draft';
import type { PersistedMetaRecord } from './types';

export const DATABASE_NAME = 'valrecall';
export const DATABASE_VERSION = 6;

export const STORE_NAMES = {
  items: 'items',
  screenshots: 'screenshots',
  reviews: 'reviews',
  meta: 'meta',
  dailyTasks: 'dailyTasks',
  taskCompletions: 'taskCompletions',
  notes: 'notes',
  intakeReceipts: 'intakeReceipts',
  wallet: 'wallet',
  syncReceipts: 'syncReceipts',
  taskRevisions: 'taskRevisions',
  occurrenceRevisions: 'occurrenceRevisions',
  taskSkips: 'taskSkips',
  drafts: 'drafts',
  learningReceipts: 'learningReceipts',
  reviewSessions: 'reviewSessions',
} as const;

export const INDEX_NAMES = {
  itemDue: 'by-due',
  itemUpdated: 'by-updated',
  reviewItem: 'by-item',
  reviewItemAndDate: 'by-item-and-date',
  taskScheduledDate: 'by-scheduled-date',
  taskLinkedLearningItem: 'by-linked-learning-item',
  completionTask: 'by-task',
  completionLocalDate: 'by-local-date',
  completionTaskAndDate: 'by-task-and-date',
} as const;

interface Migration {
  version: number;
  migrate(database: IDBDatabase, transaction: IDBTransaction): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    migrate(database, transaction) {
      const items = database.createObjectStore(STORE_NAMES.items, { keyPath: 'id' });
      items.createIndex(INDEX_NAMES.itemDue, 'fsrsCard.due', { unique: false });
      items.createIndex(INDEX_NAMES.itemUpdated, 'updatedAt', { unique: false });

      database.createObjectStore(STORE_NAMES.screenshots, { keyPath: 'id' });

      const reviews = database.createObjectStore(STORE_NAMES.reviews, { keyPath: 'id' });
      reviews.createIndex(INDEX_NAMES.reviewItem, 'itemId', { unique: false });
      reviews.createIndex(INDEX_NAMES.reviewItemAndDate, ['itemId', 'reviewedAt'], {
        unique: false,
      });

      const meta = database.createObjectStore(STORE_NAMES.meta, { keyPath: 'key' });
      const schemaRecord: PersistedMetaRecord<number> = {
        key: 'databaseSchemaVersion',
        value: 1,
        updatedAt: new Date().toISOString(),
      };
      meta.put(schemaRecord);

      // Keep the transaction parameter in the migration signature for future
      // data migrations that need access to stores created by older versions.
      void transaction;
    },
  },
  {
    version: 2,
    migrate(database, transaction) {
      const tasks = database.createObjectStore(STORE_NAMES.dailyTasks, { keyPath: 'id' });
      tasks.createIndex(INDEX_NAMES.taskScheduledDate, 'scheduledDate', { unique: false });
      tasks.createIndex(INDEX_NAMES.taskLinkedLearningItem, 'linkedLearningItemId', {
        unique: false,
      });

      const completions = database.createObjectStore(STORE_NAMES.taskCompletions, {
        keyPath: 'id',
      });
      completions.createIndex(INDEX_NAMES.completionTask, 'taskId', { unique: false });
      completions.createIndex(INDEX_NAMES.completionLocalDate, 'localDate', { unique: false });
      completions.createIndex(INDEX_NAMES.completionTaskAndDate, ['taskId', 'localDate'], {
        unique: true,
      });

      const schemaRecord: PersistedMetaRecord<number> = {
        key: 'databaseSchemaVersion',
        value: 2,
        updatedAt: new Date().toISOString(),
      };
      transaction.objectStore(STORE_NAMES.meta).put(schemaRecord);
    },
  },
  {
    version: 3,
    migrate(database, transaction) {
      database.createObjectStore(STORE_NAMES.notes, { keyPath: 'id' });
      const receipts = database.createObjectStore(STORE_NAMES.intakeReceipts, { keyPath: 'id' });
      receipts.createIndex('by-fingerprint', 'fingerprint');
      transaction.objectStore(STORE_NAMES.meta).put({
        key: 'databaseSchemaVersion',
        value: 3,
        updatedAt: new Date().toISOString(),
      });
    },
  },
  {
    version: 4,
    migrate(database, transaction) {
      database.createObjectStore(STORE_NAMES.wallet, { keyPath: 'key' });
      database.createObjectStore(STORE_NAMES.syncReceipts, { keyPath: 'id' });
      database.createObjectStore(STORE_NAMES.taskRevisions, { keyPath: 'taskId' });
      database.createObjectStore(STORE_NAMES.occurrenceRevisions, { keyPath: ['taskId', 'date'] });
      transaction
        .objectStore(STORE_NAMES.meta)
        .put({ key: 'databaseSchemaVersion', value: 4, updatedAt: new Date().toISOString() });
    },
  },
  {
    version: 5,
    migrate(database, transaction) {
      const skips = database.createObjectStore(STORE_NAMES.taskSkips, {
        keyPath: ['taskId', 'date'],
      });
      skips.createIndex(INDEX_NAMES.completionTask, 'taskId', { unique: false });
      transaction.objectStore(STORE_NAMES.meta).put({
        key: 'databaseSchemaVersion',
        value: 5,
        updatedAt: new Date().toISOString(),
      });
    },
  },
  {
    version: 6,
    migrate(database, transaction) {
      const drafts = database.createObjectStore(STORE_NAMES.drafts, { keyPath: 'id' });
      drafts.createIndex('by-scope', 'scope');
      const pending = transaction.objectStore(STORE_NAMES.meta).get('runtime.pendingCapture');
      pending.addEventListener('success', () => {
        const raw: unknown = pending.result;
        const value = raw && typeof raw === 'object' && 'value' in raw ? raw.value : undefined;
        if (isCapturePageResponse(value) && value.ok) drafts.put(captureSourceDraft(value.draft));
      });
      database.createObjectStore(STORE_NAMES.learningReceipts, { keyPath: 'id' });
      database.createObjectStore(STORE_NAMES.reviewSessions, { keyPath: 'id' });
      transaction.objectStore(STORE_NAMES.meta).put({
        key: 'databaseSchemaVersion',
        value: 6,
        updatedAt: new Date().toISOString(),
      });
    },
  },
];

export function runMigrations(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  newVersion: number,
): void {
  for (const migration of migrations) {
    if (migration.version > oldVersion && migration.version <= newVersion) {
      migration.migrate(database, transaction);
    }
  }
}
