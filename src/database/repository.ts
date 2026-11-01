import { consumeDraft, type DraftToken } from './drafts';
import { applyTaskCreationReward, type TaskAllowanceResult } from '../shared/allowance';
import { checkEditState, type EditCommit } from './edit-commit';
import { exportReliability, importReliability, mergeReliability } from './reliability-backup';
import type { IntakeCommit } from './intake-commits';
import {
  finishLearningCommit,
  replayLearningCommit,
  LEARNING_COMMIT_STORES,
  type LearningCommit,
} from './learning-commits';
import type { ShortTermReviewMode } from '../fsrs';
import {
  buildHomeTaskOverview,
  skippedTodayOccurrences,
  type HomeTaskOverview,
} from '../models/task-overview';
import type { IntakeSelection } from '../intake/package';
import {
  CATEGORY_CATALOG_META_KEY,
  CATEGORY_SCHEMA_VERSION,
  categoryNameIssue,
  categoryNameKey,
  sortCategoriesByName,
  type CategorySummary,
  type MomentCategory,
  type PersistedCategoryCatalog,
  type PersistedMomentCategory,
} from '../models/category';
import {
  DAILY_TASK_SCHEMA_VERSION,
  TASK_EXPORT_SCHEMA_VERSION,
  cloneDailyTask,
  cloneTaskCompletion,
  isDailyTaskKind,
  isLocalDateKey,
  isTaskPriority,
  isTaskRecurrence,
  isTaskScheduledOnDate,
  localDateKey,
  sortTaskOccurrences,
  taskCompletionValidationIssues,
  taskValidationIssues,
  type DailyTask,
  type DailyTaskUpdate,
  type ListTasksOptions,
  type NewDailyTask,
  type TaskCompletion,
  type TaskSkip,
  type TaskDaySummary,
  type TaskImportResult,
  type TaskOccurrence,
  type ValRecallTaskExport,
} from '../models/daily-task';
import { validateLearningItemDraft, validateTextMomentDraft } from '../models/learning-item';
import { isNoteSource, type NoteRecord } from '../models/note';
import { isVideoPlatform } from '../models/platform';
import { isReadingSource } from '../models/reading';
import {
  LIBRARY_IMAGE_STORED_MAX_BYTES,
  importedLibraryImageIssue,
  isLibraryImageMimeType,
  preparedLibraryImageIssue,
} from '../shared/library-image';
import { hasConsistentVideoIdentity, isSupportedVideoUrl } from '../shared/video-url';
import {
  MAX_IMPORTED_SCREENSHOT_BYTES,
  assertUnique,
  base64ToBlob,
  blobToBase64,
  importBoolean,
  importDate,
  importNullableString,
  importRecord,
  importString,
  migrateImportedItem,
  validateExport,
} from './backup';
import { DatabaseConnection } from './connection';
import { DatabaseError } from './errors';
import { requestResult, transactionComplete } from './idb';
import { processIntake, readNote, readReceipt, updateNoteStore } from './intake-store';
import {
  SyncRepository,
  bumpTaskRevision,
  bumpOccurrenceRevision,
  rotateSyncEpoch,
  reviseImportedCompletion,
  preserveTaskProvenance,
  type AtomicTaskChange,
} from './sync-repository';
import { WalletRepository, putWallet, readAllowanceState, walletInTransaction } from './wallet';
import { readSyncBackup } from './sync-backup';
import { readTaskSkip, validateTaskSkips, mergeTaskSkips } from './task-skips';
import type { IntakeReceipt, IntakeResult } from './intake-types';
import {
  cardFromPersisted,
  cardToPersisted,
  itemFromPersisted,
  itemToPersisted,
  migratePersistedItem,
  reviewRecordFromPersisted,
  reviewRecordToPersisted,
} from './mappers';
import { DATABASE_NAME, DATABASE_VERSION, INDEX_NAMES, STORE_NAMES } from './migrations';
import {
  collectRecentItems,
  collectUpcomingReviewPage,
  countActiveItemsInIndexRange,
  countReviewRowsBetween,
  validQueryDate,
  validUpcomingCursor,
  validUpcomingLimit,
} from './queries';
import {
  cardFromReviewSchedulingState,
  reviewSchedulingStateFromCard,
  reviewSchedulingStatesMatch,
} from './review-state';
import {
  scanStatisticsRows,
  statisticsAccumulator,
  type LearningStatistics,
  type StatisticsDays,
} from './statistics';
import {
  EXPORT_SCHEMA_VERSION,
  LEARNING_ITEM_SCHEMA_VERSION,
  type Clock,
  type ExportedScreenshot,
  type IdGenerator,
  type ImageLearningItem,
  type ImportMode,
  type ImportResult,
  type LearningItem,
  type LearningItemUpdate,
  type ListItemsOptions,
  type ListUpcomingReviewItemsOptions,
  type NewImageAsset,
  type NewImageLearningItem,
  type NewTextLearningItem,
  type NewVideoLearningItem,
  type PersistedLearningItem,
  type PersistedMetaRecord,
  type PersistedReviewRecord,
  type ReviewPersistence,
  type ReviewRecord,
  type SaveReviewInput,
  type ScreenshotRecord,
  type UpcomingReviewItemsPage,
  type ValRecallExport,
  type VideoLearningItem,
} from './types';

export interface ValRecallRepositoryOptions {
  databaseName?: string;
  indexedDBFactory?: IDBFactory;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

const systemClock: Clock = () => new Date();

function cloneCategory(category: MomentCategory): MomentCategory {
  return {
    ...category,
    createdAt: cloneDate(category.createdAt),
    updatedAt: cloneDate(category.updatedAt),
    lastUsedAt: cloneDate(category.lastUsedAt),
  };
}

function categoryFromUnknown(value: unknown, label: string): MomentCategory {
  const record = importRecord(value, label);
  if (record.schemaVersion !== CATEGORY_SCHEMA_VERSION) {
    throw new DatabaseError('INVALID_DATA', `${label}.schemaVersion is not supported.`);
  }
  const id = importString(record.id, `${label}.id`);
  const name = importString(record.name, `${label}.name`);
  const issue = categoryNameIssue(name);
  if (issue || name !== name.trim()) {
    throw new DatabaseError('INVALID_DATA', `${label}.name is invalid. ${issue ?? ''}`.trim());
  }
  return {
    id,
    schemaVersion: CATEGORY_SCHEMA_VERSION,
    name,
    createdAt: new Date(importDate(record.createdAt, `${label}.createdAt`)),
    updatedAt: new Date(importDate(record.updatedAt, `${label}.updatedAt`)),
    lastUsedAt: new Date(importDate(record.lastUsedAt, `${label}.lastUsedAt`)),
  };
}

function categoryToPersisted(category: MomentCategory): PersistedMomentCategory {
  return {
    id: category.id,
    schemaVersion: CATEGORY_SCHEMA_VERSION,
    name: category.name,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    lastUsedAt: category.lastUsedAt.toISOString(),
  };
}

function categoriesFromUnknown(value: unknown, label: string): MomentCategory[] {
  if (!Array.isArray(value)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be an array.`);
  }
  const categories = value.map((entry, index) => categoryFromUnknown(entry, `${label}[${index}]`));
  assertUnique(
    categories.map((category) => category.id),
    'category',
  );
  const nameKeys = categories.map((category) => categoryNameKey(category.name));
  if (new Set(nameKeys).size !== nameKeys.length) {
    throw new DatabaseError('INVALID_DATA', 'Category names must be unique.');
  }
  return categories;
}

function categoryCatalogFromUnknown(value: unknown): MomentCategory[] {
  if (value === undefined) return [];
  const catalog = importRecord(value, 'category catalog');
  if (catalog.schemaVersion !== CATEGORY_SCHEMA_VERSION) {
    throw new DatabaseError('INVALID_DATA', 'The category catalog version is not supported.');
  }
  return categoriesFromUnknown(catalog.categories, 'category catalog.categories');
}

function categoryCatalogValue(categories: readonly MomentCategory[]): PersistedCategoryCatalog {
  return {
    schemaVersion: CATEGORY_SCHEMA_VERSION,
    categories: categories.map(categoryToPersisted),
  };
}

function categoryCatalogRecord(
  categories: readonly MomentCategory[],
  updatedAt: Date,
): PersistedMetaRecord<PersistedCategoryCatalog> {
  return {
    key: CATEGORY_CATALOG_META_KEY,
    value: categoryCatalogValue(categories),
    updatedAt: updatedAt.toISOString(),
  };
}

function findCategory(categories: readonly MomentCategory[], id: string): MomentCategory | null {
  return categories.find((category) => category.id === id) ?? null;
}

function normalizedCategoryName(value: string): string {
  const issue = categoryNameIssue(value);
  if (issue) throw new DatabaseError('INVALID_DATA', issue);
  return value.trim().replace(/\s+/gu, ' ');
}

function assertAvailableCategoryName(
  categories: readonly MomentCategory[],
  name: string,
  exceptId?: string,
): void {
  const key = categoryNameKey(name);
  if (
    categories.some(
      (category) => category.id !== exceptId && categoryNameKey(category.name) === key,
    )
  ) {
    throw new DatabaseError('CONFLICT', `A Category named “${name}” already exists.`);
  }
}

async function categoriesFromMetaStore(store: IDBObjectStore): Promise<MomentCategory[]> {
  const record = (await requestResult(store.get(CATEGORY_CATALOG_META_KEY))) as
    PersistedMetaRecord<PersistedCategoryCatalog> | undefined;
  return categoryCatalogFromUnknown(record?.value);
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function deleteIndexEntries(index: IDBIndex, key: IDBValidKey): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(key));
    request.addEventListener('error', () => reject(request.error), { once: true });
    request.addEventListener('success', () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }

      cursor.delete();
      cursor.continue();
    });
  });
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function isConstraintError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'ConstraintError';
}

function searchableText(item: LearningItem): string {
  const sourceText =
    item.sourceType === 'text' || item.sourceType === 'image'
      ? [item.title]
      : [item.videoTitle, item.uploader];
  const reading = item.sourceType === 'text' ? item.readingSource : undefined;
  const note = item.sourceType === 'text' ? item.noteSource : undefined;
  return [
    note?.excerpt,
    note?.thought,
    note?.bookTitle,
    note?.location,
    reading?.excerpt,
    reading?.bookTitle,
    reading?.location,
    ...sourceText,
    item.personalNote,
    item.coreLesson,
    item.recallPrompt,
    ...item.tags,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLocaleLowerCase();
}

function itemAssetId(item: LearningItem): string | null {
  if (item.sourceType === 'image') return item.imageAssetId;
  if (item.sourceType === 'video' || item.sourceType === undefined) return item.screenshotId;
  return null;
}

function assetOwners(items: readonly LearningItem[], label: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const item of items) {
    const assetId = itemAssetId(item);
    if (assetId === null) continue;
    const existingOwner = owners.get(assetId);
    if (existingOwner !== undefined && existingOwner !== item.id) {
      throw new DatabaseError(
        'INVALID_DATA',
        `${label} assigns image asset ${assetId} to more than one learning item.`,
      );
    }
    owners.set(assetId, item.id);
  }
  return owners;
}

function assertSupportedItemSource(
  platform: NewVideoLearningItem['platform'],
  sourceUrl: string,
  canonicalUrl: string | null | undefined,
  videoId: string | null | undefined,
): void {
  if (!isSupportedVideoUrl(sourceUrl, platform)) {
    throw new DatabaseError(
      'INVALID_DATA',
      `The source URL is not a supported ${platform} video URL.`,
    );
  }
  if (
    canonicalUrl !== null &&
    canonicalUrl !== undefined &&
    !isSupportedVideoUrl(canonicalUrl, platform)
  ) {
    throw new DatabaseError(
      'INVALID_DATA',
      `The canonical URL is not a supported ${platform} video URL.`,
    );
  }
  if (!hasConsistentVideoIdentity(platform, sourceUrl, canonicalUrl, videoId)) {
    throw new DatabaseError(
      'INVALID_DATA',
      'The source URL, canonical URL, and video identifier do not describe the same video.',
    );
  }
}

function normalizeTask(task: DailyTask, label = 'task'): DailyTask {
  const initialIssues = taskValidationIssues(task);
  if (initialIssues.length > 0) {
    throw new DatabaseError('INVALID_DATA', `${label} is invalid. ${initialIssues.join(' ')}`);
  }
  const normalized: DailyTask = {
    ...task,
    title: task.title.trim(),
    notes: task.notes,
    scheduledDate: task.scheduledDate,
    scheduledTime: task.scheduledTime,
    selectedWeekdays: [...task.selectedWeekdays].sort((left, right) => left - right),
    linkedLearningItemId: task.linkedLearningItemId,
  };
  return normalized;
}

function createTaskRecord(input: NewDailyTask, id: string, now: Date): DailyTask {
  const createdAt = input.createdAt ?? now.toISOString();
  const updatedAt = input.updatedAt ?? createdAt;
  return normalizeTask({
    id: input.id ?? id,
    schemaVersion: DAILY_TASK_SCHEMA_VERSION,
    title: input.title,
    notes: input.notes ?? null,
    kind: input.kind,
    recurrence: input.recurrence,
    scheduledDate: input.scheduledDate ?? null,
    scheduledTime: input.scheduledTime ?? null,
    selectedWeekdays: input.selectedWeekdays ?? [],
    linkedLearningItemId: input.linkedLearningItemId ?? null,
    priority: input.priority ?? 'normal',
    archived: input.archived ?? false,
    createdAt: importDate(createdAt, 'task.createdAt'),
    updatedAt: importDate(updatedAt, 'task.updatedAt'),
  });
}

function taskFromUnknown(value: unknown, label: string): DailyTask {
  const record = importRecord(value, label);
  const kind = record.kind;
  const recurrence = record.recurrence;
  const priority = record.priority;
  if (!isDailyTaskKind(kind)) {
    throw new DatabaseError('INVALID_DATA', `${label}.kind is not supported.`);
  }
  if (!isTaskRecurrence(recurrence)) {
    throw new DatabaseError('INVALID_DATA', `${label}.recurrence is not supported.`);
  }
  if (!isTaskPriority(priority)) {
    throw new DatabaseError('INVALID_DATA', `${label}.priority is not supported.`);
  }
  if (!Array.isArray(record.selectedWeekdays)) {
    throw new DatabaseError('INVALID_DATA', `${label}.selectedWeekdays must be an array.`);
  }
  if (record.schemaVersion !== DAILY_TASK_SCHEMA_VERSION) {
    throw new DatabaseError(
      'INVALID_DATA',
      `${label}.schemaVersion must be ${DAILY_TASK_SCHEMA_VERSION}.`,
    );
  }
  return normalizeTask(
    {
      id: importString(record.id, `${label}.id`),
      schemaVersion: DAILY_TASK_SCHEMA_VERSION,
      title: importString(record.title, `${label}.title`, true),
      notes: importNullableString(record.notes, `${label}.notes`),
      kind,
      recurrence,
      scheduledDate: importNullableString(record.scheduledDate, `${label}.scheduledDate`),
      scheduledTime: importNullableString(record.scheduledTime, `${label}.scheduledTime`),
      selectedWeekdays: record.selectedWeekdays.map((weekday, index) => {
        if (typeof weekday !== 'number') {
          throw new DatabaseError(
            'INVALID_DATA',
            `${label}.selectedWeekdays[${index}] must be a number.`,
          );
        }
        return weekday;
      }),
      linkedLearningItemId: importNullableString(
        record.linkedLearningItemId,
        `${label}.linkedLearningItemId`,
      ),
      priority,
      archived: importBoolean(record.archived, `${label}.archived`),
      createdAt: importDate(record.createdAt, `${label}.createdAt`),
      updatedAt: importDate(record.updatedAt, `${label}.updatedAt`),
    },
    label,
  );
}

function taskCompletionFromUnknown(value: unknown, label: string): TaskCompletion {
  const record = importRecord(value, label);
  const completion: TaskCompletion = {
    id: importString(record.id, `${label}.id`),
    taskId: importString(record.taskId, `${label}.taskId`),
    localDate: importString(record.localDate, `${label}.localDate`),
    completedAt: importDate(record.completedAt, `${label}.completedAt`),
  };
  const issues = taskCompletionValidationIssues(completion);
  if (issues.length > 0) {
    throw new DatabaseError('INVALID_DATA', `${label} is invalid. ${issues.join(' ')}`);
  }
  return completion;
}

function completionPairKey(taskId: string, localDate: string): string {
  return `${taskId}\u0000${localDate}`;
}

function validateTaskGraph(
  tasksInput: readonly unknown[],
  completionsInput: readonly unknown[],
  skipsInput: readonly unknown[] = [],
): { tasks: DailyTask[]; taskCompletions: TaskCompletion[]; taskSkips: TaskSkip[] } {
  const tasks = tasksInput.map((task, index) => taskFromUnknown(task, `tasks[${index}]`));
  const taskCompletions = completionsInput.map((completion, index) =>
    taskCompletionFromUnknown(completion, `taskCompletions[${index}]`),
  );
  assertUnique(
    tasks.map((task) => task.id),
    'task',
  );
  assertUnique(
    taskCompletions.map((completion) => completion.id),
    'task completion',
  );
  assertUnique(
    taskCompletions.map((completion) => completionPairKey(completion.taskId, completion.localDate)),
    'task completion date',
  );
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const completion of taskCompletions) {
    if (!taskIds.has(completion.taskId)) {
      throw new DatabaseError(
        'INVALID_DATA',
        `Imported task completion ${completion.id} references an unknown task.`,
      );
    }
  }
  return {
    tasks,
    taskCompletions,
    taskSkips: validateTaskSkips(skipsInput, tasks, taskCompletions),
  };
}

function validateTaskExport(value: unknown): {
  exportedAt: string;
  tasks: DailyTask[];
  taskCompletions: TaskCompletion[];
  taskSkips: TaskSkip[];
} {
  const record = importRecord(value, 'Task import data');
  if (record.application !== 'ValRecall') {
    throw new DatabaseError('INVALID_DATA', 'This file is not a ValRecall export.');
  }
  if (record.schemaVersion !== 1 && record.schemaVersion !== TASK_EXPORT_SCHEMA_VERSION) {
    throw new DatabaseError(
      'INVALID_DATA',
      `Unsupported task export schema version: ${String(record.schemaVersion)}.`,
    );
  }
  if (!Array.isArray(record.tasks) || !Array.isArray(record.taskCompletions)) {
    throw new DatabaseError('INVALID_DATA', 'The ValRecall task export is incomplete.');
  }
  if (
    (record.schemaVersion === 2 && !Array.isArray(record.taskSkips)) ||
    (record.taskSkips !== undefined && !Array.isArray(record.taskSkips)) ||
    (record.schemaVersion === 1 && Array.isArray(record.taskSkips) && record.taskSkips.length > 0)
  )
    throw new DatabaseError('INVALID_DATA', '任务备份的跳过记录无效。');
  return {
    exportedAt: importDate(record.exportedAt, 'exportedAt'),
    ...validateTaskGraph(
      record.tasks,
      record.taskCompletions,
      (record.taskSkips as unknown[] | undefined) ?? [],
    ),
  };
}

function buildTaskDaySummary(
  tasks: readonly DailyTask[],
  completions: readonly TaskCompletion[],
  localDate: string,
  skips: readonly TaskSkip[] = [],
): TaskDaySummary {
  if (!isLocalDateKey(localDate)) {
    throw new DatabaseError('INVALID_DATA', 'Task date must use a real YYYY-MM-DD local date.');
  }
  const completionByTask = new Map(
    completions
      .filter((completion) => completion.localDate === localDate)
      .map((completion) => [completion.taskId, completion] as const),
  );
  const oneOffIds = new Set(
    tasks.filter((task) => task.recurrence === 'specific_date').map((task) => task.id),
  );
  for (const completion of completions)
    if (oneOffIds.has(completion.taskId)) completionByTask.set(completion.taskId, completion);
  const occurrences = sortTaskOccurrences(
    tasks
      .filter(
        (task) =>
          !skips.some((skip) => skip.taskId === task.id && skip.date === localDate) &&
          (isTaskScheduledOnDate(task, localDate) ||
            (!task.archived &&
              task.recurrence === 'specific_date' &&
              task.scheduledDate! < localDate &&
              !completions.some((row) => row.taskId === task.id))),
      )
      .map((task): TaskOccurrence => ({
        task: cloneDailyTask(task),
        localDate:
          task.recurrence === 'specific_date'
            ? (completionByTask.get(task.id)?.localDate ?? task.scheduledDate!)
            : localDate,
        completion: completionByTask.has(task.id)
          ? cloneTaskCompletion(completionByTask.get(task.id) as TaskCompletion)
          : null,
      })),
  );
  const completed = occurrences.filter((occurrence) => occurrence.completion !== null).length;
  return {
    localDate,
    total: occurrences.length,
    completed,
    remaining: occurrences.length - completed,
    occurrences,
  };
}

function taskCompletionsForMerge(
  existing: readonly TaskCompletion[],
  incoming: readonly TaskCompletion[],
): TaskCompletion[] {
  const existingByPair = new Map(
    existing.map((completion) => [
      completionPairKey(completion.taskId, completion.localDate),
      completion,
    ]),
  );
  return incoming.filter((completion) => {
    const pairOwner = existingByPair.get(
      completionPairKey(completion.taskId, completion.localDate),
    );
    return pairOwner === undefined || pairOwner.id === completion.id;
  });
}

function clearMissingTaskLinks(
  tasks: readonly DailyTask[],
  learningItemIds: ReadonlySet<string>,
): DailyTask[] {
  return tasks.map((task) =>
    cloneDailyTask(
      task.linkedLearningItemId !== null && !learningItemIds.has(task.linkedLearningItemId)
        ? { ...task, linkedLearningItemId: null }
        : task,
    ),
  );
}

function stringKeys(keys: readonly IDBValidKey[]): Set<string> {
  return new Set(keys.filter((key): key is string => typeof key === 'string'));
}

export class ValRecallRepository implements ReviewPersistence {
  readonly databaseName: string;

  private readonly connection: DatabaseConnection;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;

  constructor(options: ValRecallRepositoryOptions = {}) {
    const factory = options.indexedDBFactory ?? globalThis.indexedDB;
    if (!factory) {
      throw new DatabaseError('OPEN_FAILED', 'IndexedDB is unavailable in this browser context.');
    }

    this.databaseName = options.databaseName ?? DATABASE_NAME;
    this.connection = new DatabaseConnection(factory, this.databaseName);
    this.clock = options.clock ?? systemClock;
    this.idGenerator = options.idGenerator ?? randomId;
  }

  open(): Promise<IDBDatabase> {
    return this.connection.open();
  }

  close(): void {
    this.connection.close();
  }

  async createItem(
    input: NewVideoLearningItem,
    screenshot: Blob,
    commit?: LearningCommit,
  ): Promise<VideoLearningItem> {
    const validation = validateLearningItemDraft({
      ...input,
      sourceUrl: input.sourceUrl,
      timestampSeconds: input.timestampSeconds,
    });
    if (!validation.valid || !input.videoTitle.trim()) {
      throw new DatabaseError(
        'INVALID_DATA',
        validation.issues.map((issue) => issue.message).join(' ') || 'A video title is required.',
      );
    }
    if (!screenshot) {
      throw new DatabaseError('INVALID_DATA', 'A screenshot is required for a new learning item.');
    }
    if (!isVideoPlatform(input.platform)) {
      throw new DatabaseError('INVALID_DATA', 'A supported video platform is required.');
    }
    assertSupportedItemSource(input.platform, input.sourceUrl, input.canonicalUrl, input.videoId);

    const now = cloneDate(input.createdAt ?? this.clock());
    const id = input.id ?? this.idGenerator();
    const screenshotId = input.screenshotId ?? `screenshot-${id}`;
    const card = cardFromPersisted(cardToPersisted(input.fsrsCard));

    const item: VideoLearningItem = {
      id,
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      sourceType: 'video',
      videoOrigin: 'capture',
      platform: input.platform,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl ?? null,
      videoId: input.videoId ?? null,
      videoTitle: input.videoTitle,
      uploader: input.uploader ?? null,
      description: input.description ?? null,
      timestampSeconds: input.timestampSeconds,
      timestampDisplay: input.timestampDisplay,
      videoDurationSeconds: input.videoDurationSeconds ?? null,
      chapterTitle: input.chapterTitle ?? null,
      screenshotId,
      subtitleBefore: [...(input.subtitleBefore ?? [])],
      subtitleCurrent: [...(input.subtitleCurrent ?? [])],
      subtitleAfter: [...(input.subtitleAfter ?? [])],
      subtitleCueData: [...(input.subtitleCueData ?? [])],
      categoryId: input.categoryId ?? null,
      itemType: input.itemType,
      personalNote: input.personalNote ?? '',
      situation: input.situation ?? '',
      coreLesson: input.coreLesson,
      mistakeToAvoid: input.mistakeToAvoid ?? '',
      recommendedAction: input.recommendedAction ?? '',
      reason: input.reason ?? '',
      recallPrompt: input.recallPrompt,
      referenceAnswer: input.referenceAnswer,
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: cloneDate(input.updatedAt ?? now),
      fsrsCard: card,
      reviewHistory: [],
      suspended: input.suspended ?? false,
      extractionDiagnostics: [...(input.extractionDiagnostics ?? [])],
    };

    if (commit) await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.items,
        STORE_NAMES.screenshots,
        STORE_NAMES.meta,
        ...(commit ? LEARNING_COMMIT_STORES : []),
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const replay = await replayLearningCommit(transaction, commit);
      if (replay) {
        const stored: unknown = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(replay.itemId),
        );
        if (stored === undefined) throw new DatabaseError('NOT_FOUND', '这条内容保存后已被删除。');
        const original = itemFromPersisted(migratePersistedItem(stored));
        if (original.sourceType !== 'video')
          throw new DatabaseError('CONFLICT', '保存类型与原操作不一致。');
        await done;
        return original;
      }
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(metaStore);
      if (item.categoryId !== null) {
        const selected = findCategory(categories, item.categoryId);
        if (selected) {
          selected.lastUsedAt = cloneDate(now);
          selected.updatedAt = cloneDate(now);
          metaStore.put(categoryCatalogRecord(categories, now));
        } else {
          // A Category may have been deleted in another tab while capture was open.
          // The optional organisation choice must not discard an otherwise valid Moment.
          item.categoryId = null;
        }
      }
      transaction.objectStore(STORE_NAMES.items).add(itemToPersisted(item));
      const screenshotRecord: ScreenshotRecord = {
        id: screenshotId,
        blob: screenshot,
        createdAt: now.toISOString(),
      };
      transaction.objectStore(STORE_NAMES.screenshots).put(screenshotRecord);
      await finishLearningCommit(transaction, item, now, commit);
      await done;
      return item;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Learning item ${id} already exists.`, error);
      }
      throw this.transactionError('条目保存失败，请重试。', error);
    }
  }

  async createTextItem(input: NewTextLearningItem, commit?: LearningCommit): Promise<LearningItem> {
    if (input.noteSource !== undefined && !isNoteSource(input.noteSource)) {
      throw new DatabaseError('INVALID_DATA', '笔记来源快照格式无效。');
    }
    if (input.readingSource !== undefined && !isReadingSource(input.readingSource)) {
      throw new DatabaseError('INVALID_DATA', '阅读来源格式无效，原文不能为空。');
    }
    const validation = validateTextMomentDraft(input);
    if (!validation.valid) {
      throw new DatabaseError(
        'INVALID_DATA',
        validation.issues.map((issue) => issue.message).join(' '),
      );
    }

    const now = cloneDate(input.createdAt ?? this.clock());
    const id = input.id ?? this.idGenerator();
    const item: LearningItem = {
      id,
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      sourceType: 'text',
      title: input.title,
      ...(input.readingSource ? { readingSource: { ...input.readingSource } } : {}),
      ...(input.noteSource ? { noteSource: { ...input.noteSource } } : {}),
      categoryId: input.categoryId ?? null,
      itemType: input.itemType,
      personalNote: input.personalNote ?? '',
      situation: input.situation ?? '',
      coreLesson: input.coreLesson,
      mistakeToAvoid: input.mistakeToAvoid ?? '',
      recommendedAction: input.recommendedAction ?? '',
      reason: input.reason ?? '',
      recallPrompt: input.recallPrompt,
      referenceAnswer: input.referenceAnswer,
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: cloneDate(input.updatedAt ?? now),
      fsrsCard: cardFromPersisted(cardToPersisted(input.fsrsCard)),
      reviewHistory: [],
      suspended: input.suspended ?? false,
      extractionDiagnostics: [],
    };

    if (commit) await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.items, STORE_NAMES.meta, ...(commit ? LEARNING_COMMIT_STORES : [])],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const replay = await replayLearningCommit(transaction, commit);
      if (replay) {
        const stored: unknown = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(replay.itemId),
        );
        if (stored === undefined) throw new DatabaseError('NOT_FOUND', '这条内容保存后已被删除。');
        const original = itemFromPersisted(migratePersistedItem(stored));
        if (original.sourceType !== 'text')
          throw new DatabaseError('CONFLICT', '保存类型与原操作不一致。');
        await done;
        return original;
      }
      // Check identity in the same write transaction: retries must report a
      // conflict before touching categories, even if a prior response was lost.
      const existing = await requestResult(transaction.objectStore(STORE_NAMES.items).getKey(id));
      if (existing !== undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError('CONFLICT', `Learning item ${id} already exists.`);
      }
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(metaStore);
      if (item.categoryId !== null) {
        const selected = findCategory(categories, item.categoryId);
        if (selected) {
          selected.lastUsedAt = cloneDate(now);
          selected.updatedAt = cloneDate(now);
          metaStore.put(categoryCatalogRecord(categories, now));
        } else {
          item.categoryId = null;
        }
      }
      transaction.objectStore(STORE_NAMES.items).add(itemToPersisted(item));
      await finishLearningCommit(transaction, item, now, commit);
      await done;
      return item;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Learning item ${id} already exists.`, error);
      }
      throw this.transactionError('文字片段保存失败，请重试。', error);
    }
  }

  async createImageItem(
    input: NewImageLearningItem,
    asset: NewImageAsset,
    commit?: LearningCommit,
  ): Promise<ImageLearningItem> {
    const validation = validateTextMomentDraft(input);
    const assetIssue = preparedLibraryImageIssue(asset);
    if (!validation.valid || assetIssue) {
      throw new DatabaseError(
        'INVALID_DATA',
        [validation.issues.map((issue) => issue.message).join(' '), assetIssue]
          .filter(Boolean)
          .join(' '),
      );
    }
    if (!isLibraryImageMimeType(asset.blob.type)) {
      throw new DatabaseError('INVALID_DATA', 'The prepared image type is unsupported.');
    }

    const now = cloneDate(input.createdAt ?? this.clock());
    const id = input.id ?? this.idGenerator();
    const imageAssetId = `image-${id}`;
    const item: ImageLearningItem = {
      id,
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      sourceType: 'image',
      title: input.title,
      imageAssetId,
      imageMimeType: asset.blob.type,
      imageWidth: asset.width,
      imageHeight: asset.height,
      categoryId: input.categoryId ?? null,
      itemType: input.itemType,
      personalNote: input.personalNote ?? '',
      situation: input.situation ?? '',
      coreLesson: input.coreLesson,
      mistakeToAvoid: input.mistakeToAvoid ?? '',
      recommendedAction: input.recommendedAction ?? '',
      reason: input.reason ?? '',
      recallPrompt: input.recallPrompt,
      referenceAnswer: input.referenceAnswer,
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: cloneDate(input.updatedAt ?? now),
      fsrsCard: cardFromPersisted(cardToPersisted(input.fsrsCard)),
      reviewHistory: [],
      suspended: input.suspended ?? false,
      extractionDiagnostics: [],
    };

    if (commit) await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.items,
        STORE_NAMES.screenshots,
        STORE_NAMES.meta,
        ...(commit ? LEARNING_COMMIT_STORES : []),
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      const replay = await replayLearningCommit(transaction, commit);
      if (replay) {
        const stored: unknown = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(replay.itemId),
        );
        if (stored === undefined) throw new DatabaseError('NOT_FOUND', '这条内容保存后已被删除。');
        const original = itemFromPersisted(migratePersistedItem(stored));
        if (original.sourceType !== 'image')
          throw new DatabaseError('CONFLICT', '保存类型与原操作不一致。');
        await done;
        return original;
      }
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const screenshotStore = transaction.objectStore(STORE_NAMES.screenshots);
      const [existingItem, existingAsset] = await Promise.all([
        requestResult(itemStore.get(id)),
        requestResult(screenshotStore.getKey(imageAssetId)),
      ]);
      if (existingItem !== undefined || existingAsset !== undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError(
          'CONFLICT',
          existingItem !== undefined
            ? `Learning item ${id} already exists.`
            : `Image asset ${imageAssetId} already exists.`,
        );
      }
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(metaStore);
      if (item.categoryId !== null) {
        const selected = findCategory(categories, item.categoryId);
        if (selected) {
          selected.lastUsedAt = cloneDate(now);
          selected.updatedAt = cloneDate(now);
          metaStore.put(categoryCatalogRecord(categories, now));
        } else {
          item.categoryId = null;
        }
      }
      itemStore.add(itemToPersisted(item));
      screenshotStore.add({
        id: imageAssetId,
        blob: asset.blob,
        createdAt: now.toISOString(),
      } satisfies ScreenshotRecord);
      await finishLearningCommit(transaction, item, now, commit);
      await done;
      return item;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Learning item ${id} already exists.`, error);
      }
      throw this.transactionError('图片片段保存失败，请重试。', error);
    }
  }

  async createManualVideoItem(
    input: NewVideoLearningItem,
    commit?: LearningCommit,
  ): Promise<VideoLearningItem> {
    const validation = validateLearningItemDraft({
      ...input,
      sourceUrl: input.sourceUrl,
      timestampSeconds: input.timestampSeconds ?? undefined,
    });
    if (!validation.valid || !input.videoTitle.trim()) {
      throw new DatabaseError(
        'INVALID_DATA',
        validation.issues.map((issue) => issue.message).join(' ') || 'A video title is required.',
      );
    }
    if (!isVideoPlatform(input.platform)) {
      throw new DatabaseError('INVALID_DATA', 'A supported video platform is required.');
    }
    if (
      (input.timestampSeconds === null && input.timestampDisplay !== null) ||
      (input.timestampSeconds !== null && !input.timestampDisplay?.trim())
    ) {
      throw new DatabaseError('INVALID_DATA', 'The optional video timestamp is inconsistent.');
    }
    assertSupportedItemSource(input.platform, input.sourceUrl, input.canonicalUrl, input.videoId);

    const now = cloneDate(input.createdAt ?? this.clock());
    const id = input.id ?? this.idGenerator();
    const item: VideoLearningItem = {
      id,
      schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
      sourceType: 'video',
      videoOrigin: 'library',
      platform: input.platform,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl ?? null,
      videoId: input.videoId ?? null,
      videoTitle: input.videoTitle,
      uploader: null,
      description: null,
      timestampSeconds: input.timestampSeconds,
      timestampDisplay: input.timestampDisplay,
      videoDurationSeconds: null,
      chapterTitle: null,
      screenshotId: null,
      subtitleBefore: [],
      subtitleCurrent: [],
      subtitleAfter: [],
      subtitleCueData: [],
      categoryId: input.categoryId ?? null,
      itemType: input.itemType,
      personalNote: input.personalNote ?? '',
      situation: input.situation ?? '',
      coreLesson: input.coreLesson,
      mistakeToAvoid: input.mistakeToAvoid ?? '',
      recommendedAction: input.recommendedAction ?? '',
      reason: input.reason ?? '',
      recallPrompt: input.recallPrompt,
      referenceAnswer: input.referenceAnswer,
      tags: [...(input.tags ?? [])],
      createdAt: now,
      updatedAt: cloneDate(input.updatedAt ?? now),
      fsrsCard: cardFromPersisted(cardToPersisted(input.fsrsCard)),
      reviewHistory: [],
      suspended: input.suspended ?? false,
      extractionDiagnostics: [],
    };

    if (commit) await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.items, STORE_NAMES.meta, ...(commit ? LEARNING_COMMIT_STORES : [])],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      const replay = await replayLearningCommit(transaction, commit);
      if (replay) {
        const stored: unknown = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(replay.itemId),
        );
        if (stored === undefined) throw new DatabaseError('NOT_FOUND', '这条内容保存后已被删除。');
        const original = itemFromPersisted(migratePersistedItem(stored));
        if (original.sourceType !== 'video')
          throw new DatabaseError('CONFLICT', '保存类型与原操作不一致。');
        await done;
        return original;
      }
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(metaStore);
      if (item.categoryId !== null) {
        const selected = findCategory(categories, item.categoryId);
        if (selected) {
          selected.lastUsedAt = cloneDate(now);
          selected.updatedAt = cloneDate(now);
          metaStore.put(categoryCatalogRecord(categories, now));
        } else {
          item.categoryId = null;
        }
      }
      transaction.objectStore(STORE_NAMES.items).add(itemToPersisted(item));
      await finishLearningCommit(transaction, item, now, commit);
      await done;
      return item;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Learning item ${id} already exists.`, error);
      }
      throw this.transactionError('Could not save the Video Moment.', error);
    }
  }

  async updateItem(
    id: string,
    changes: LearningItemUpdate,
    commit?: EditCommit,
  ): Promise<LearningItem> {
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.items, STORE_NAMES.meta, STORE_NAMES.drafts],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const persisted = (await requestResult(itemStore.get(id))) as
        PersistedLearningItem | undefined;
      if (!persisted) {
        throw new DatabaseError('NOT_FOUND', `Learning item ${id} was not found.`);
      }
      const current = itemFromPersisted(persisted);
      checkEditState(current, commit);
      const updatedAt = cloneDate(this.clock());
      if (
        changes.readingSource !== undefined &&
        (current.sourceType !== 'text' || !isReadingSource(changes.readingSource))
      ) {
        throw new DatabaseError('INVALID_DATA', '阅读来源格式无效，原文不能为空。');
      }
      const { title, videoTitle, ...commonChanges } = changes;
      const baseUpdate = {
        ...commonChanges,
        id: current.id,
        schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
        createdAt: current.createdAt,
        updatedAt,
        fsrsCard: changes.fsrsCard
          ? cardFromPersisted(cardToPersisted(changes.fsrsCard))
          : current.fsrsCard,
        reviewHistory: current.reviewHistory,
      };
      const updated: LearningItem =
        current.sourceType === 'text' || current.sourceType === 'image'
          ? { ...current, ...baseUpdate, title: title ?? current.title }
          : {
              ...current,
              ...baseUpdate,
              sourceType: 'video',
              videoTitle: videoTitle ?? current.videoTitle,
            };

      const validation =
        updated.sourceType === 'text' || updated.sourceType === 'image'
          ? validateTextMomentDraft(updated)
          : validateLearningItemDraft({
              ...updated,
              sourceUrl: updated.sourceUrl,
              timestampSeconds: updated.timestampSeconds ?? undefined,
            });
      if (!validation.valid || (updated.sourceType === 'video' && !updated.videoTitle.trim())) {
        throw new DatabaseError(
          'INVALID_DATA',
          validation.issues.map((issue) => issue.message).join(' ') || 'A video title is required.',
        );
      }
      if (updated.sourceType === 'video' || updated.sourceType === undefined) {
        assertSupportedItemSource(
          updated.platform,
          updated.sourceUrl,
          updated.canonicalUrl,
          updated.videoId,
        );
      }

      if (updated.categoryId !== null) {
        const metaStore = transaction.objectStore(STORE_NAMES.meta);
        const categories = await categoriesFromMetaStore(metaStore);
        const selected = findCategory(categories, updated.categoryId);
        if (!selected) {
          throw new DatabaseError(
            'NOT_FOUND',
            'That Category no longer exists. Reload the Library and choose another Category.',
          );
        }
        if (updated.categoryId !== current.categoryId) {
          selected.lastUsedAt = cloneDate(updatedAt);
          selected.updatedAt = cloneDate(updatedAt);
          metaStore.put(categoryCatalogRecord(categories, updatedAt));
        }
      }

      itemStore.put(itemToPersisted(updated));
      await consumeDraft(transaction, commit?.draft);
      await done;
      return updated;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Closed. */
      }
      await done.catch(() => undefined);
      if (error instanceof DatabaseError) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have aborted.
        }
        await done.catch(() => undefined);
        throw error;
      }
      throw this.transactionError('Could not update the learning item.', error);
    }
  }

  async deleteItem(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.items,
        STORE_NAMES.screenshots,
        STORE_NAMES.reviews,
        STORE_NAMES.dailyTasks,
        STORE_NAMES.taskRevisions,
        STORE_NAMES.wallet,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const [item, allItems] = (await Promise.all([
        requestResult(itemStore.get(id)),
        requestResult(itemStore.getAll()),
      ])) as [PersistedLearningItem | undefined, PersistedLearningItem[]];
      itemStore.delete(id);
      const assetId = item === undefined ? null : itemAssetId(itemFromPersisted(item));
      const assetHasAnotherOwner =
        assetId !== null &&
        allItems.some((candidate) => {
          if (candidate.id === id) return false;
          return itemAssetId(itemFromPersisted(candidate)) === assetId;
        });
      if (assetId !== null && !assetHasAnotherOwner) {
        transaction.objectStore(STORE_NAMES.screenshots).delete(assetId);
      }
      await deleteIndexEntries(
        transaction.objectStore(STORE_NAMES.reviews).index(INDEX_NAMES.reviewItem),
        id,
      );
      const linkedTasks = (await requestResult(
        transaction
          .objectStore(STORE_NAMES.dailyTasks)
          .index(INDEX_NAMES.taskLinkedLearningItem)
          .getAll(IDBKeyRange.only(id)),
      )) as unknown[];
      const taskStore = transaction.objectStore(STORE_NAMES.dailyTasks);
      const updatedAt = this.clock().toISOString();
      for (const [index, value] of linkedTasks.entries()) {
        const task = taskFromUnknown(value, `linked tasks[${index}]`);
        taskStore.put({ ...task, linkedLearningItemId: null, updatedAt });
        bumpTaskRevision(transaction, task.id);
      }
      await done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw this.transactionError('Could not delete the learning item.', error);
    }
  }

  async getItem(id: string): Promise<LearningItem | undefined> {
    const database = await this.open();
    const transaction = database.transaction([STORE_NAMES.items, STORE_NAMES.reviews], 'readonly');
    const done = transactionComplete(transaction);
    const itemRequest = transaction.objectStore(STORE_NAMES.items).get(id);
    const reviewRequest = transaction
      .objectStore(STORE_NAMES.reviews)
      .index(INDEX_NAMES.reviewItem)
      .getAll(IDBKeyRange.only(id));

    try {
      const [item, reviews] = await Promise.all([
        requestResult(itemRequest),
        requestResult(reviewRequest),
      ]);
      await done;
      if (!item) return undefined;

      return itemFromPersisted(
        item,
        (reviews as PersistedReviewRecord[]).map(reviewRecordFromPersisted),
      );
    } catch (error) {
      throw this.transactionError('Could not load the learning item.', error);
    }
  }

  async listItems(options: ListItemsOptions = {}): Promise<LearningItem[]> {
    const database = await this.open();
    const includeHistory = options.includeReviewHistory !== false;
    const transaction = database.transaction(
      includeHistory ? [STORE_NAMES.items, STORE_NAMES.reviews] : [STORE_NAMES.items],
      'readonly',
    );
    const done = transactionComplete(transaction);
    const itemsRequest = transaction.objectStore(STORE_NAMES.items).getAll();
    const reviewsRequest = includeHistory
      ? requestResult(transaction.objectStore(STORE_NAMES.reviews).getAll())
      : Promise.resolve([]);

    try {
      const [persistedItems, persistedReviews] = await Promise.all([
        requestResult(itemsRequest),
        reviewsRequest,
      ]);
      await done;

      const reviewsByItem = new Map<string, ReviewRecord[]>();
      for (const value of persistedReviews as PersistedReviewRecord[]) {
        const review = reviewRecordFromPersisted(value);
        const reviews = reviewsByItem.get(review.itemId) ?? [];
        reviews.push(review);
        reviewsByItem.set(review.itemId, reviews);
      }

      const now = (options.now ?? this.clock()).getTime();
      const query = options.query?.trim().toLocaleLowerCase();
      return (persistedItems as PersistedLearningItem[])
        .map((item) => itemFromPersisted(item, reviewsByItem.get(item.id)))
        .filter((item) => !options.itemType || item.itemType === options.itemType)
        .filter(
          (item) =>
            !options.platform ||
            (item.sourceType === 'video' && item.platform === options.platform),
        )
        .filter(
          (item) =>
            !options.source ||
            (options.source === 'text' || options.source === 'image'
              ? item.sourceType === options.source
              : item.sourceType === 'video' && item.platform === options.source),
        )
        .filter(
          (item) =>
            !Object.prototype.hasOwnProperty.call(options, 'categoryId') ||
            item.categoryId === options.categoryId,
        )
        .filter((item) => !query || searchableText(item).includes(query))
        .filter((item) => {
          switch (options.status ?? 'all') {
            case 'due':
              return !item.suspended && item.fsrsCard.due.getTime() <= now;
            case 'future':
              return !item.suspended && item.fsrsCard.due.getTime() > now;
            case 'suspended':
              return item.suspended;
            case 'all':
              return true;
          }
        })
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    } catch (error) {
      throw this.transactionError('Could not list learning items.', error);
    }
  }

  async listDueItems(
    now: Date = this.clock(),
    categoryId?: string | null,
  ): Promise<LearningItem[]> {
    const items = await this.listItems({
      status: 'due',
      now,
      ...(categoryId !== undefined ? { categoryId } : {}),
    });
    return items.sort((left, right) => left.fsrsCard.due.getTime() - right.fsrsCard.due.getTime());
  }

  /**
   * Reads future cards in persisted due order without touching screenshots or
   * review-history records. The cursor is the last returned due/primary-key pair.
   */
  async listUpcomingReviewItems(
    options: ListUpcomingReviewItemsOptions,
  ): Promise<UpcomingReviewItemsPage> {
    const after = validQueryDate(options.after, 'after');
    const before = options.before ? validQueryDate(options.before, 'before') : null;
    const limit = validUpcomingLimit(options.limit);
    const continuation = options.cursor ? validUpcomingCursor(options.cursor) : null;
    if (before !== null && before.getTime() <= after.getTime()) {
      return { items: [], nextCursor: null, hasMore: false, invalidCount: 0 };
    }

    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.items, 'readonly');
    const done = transactionComplete(transaction);
    const index = transaction.objectStore(STORE_NAMES.items).index(INDEX_NAMES.itemDue);
    const lower = continuation?.due ?? after.toISOString();
    const upper = before?.toISOString();
    const range =
      upper === undefined
        ? IDBKeyRange.lowerBound(lower, continuation === null)
        : IDBKeyRange.bound(lower, upper, continuation === null, true);

    try {
      const result = await collectUpcomingReviewPage(index, range, {
        after,
        before,
        limit,
        continuation,
      });
      await done;
      return result;
    } catch (error) {
      throw this.transactionError('Could not list upcoming reviews.', error);
    }
  }

  /** Counts active cards at or before the exact persisted due instant. */
  async countDueReviewItems(now: Date = this.clock(), categoryId?: string | null): Promise<number> {
    const dueAt = validQueryDate(now, 'now');
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.items, 'readonly');
    const done = transactionComplete(transaction);
    const index = transaction.objectStore(STORE_NAMES.items).index(INDEX_NAMES.itemDue);

    try {
      const count = await countActiveItemsInIndexRange(
        index,
        IDBKeyRange.upperBound(dueAt.toISOString()),
        categoryId,
      );
      await done;
      return count;
    } catch (error) {
      throw this.transactionError('Could not count due reviews.', error);
    }
  }

  async listCategories(): Promise<MomentCategory[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readonly');
    const done = transactionComplete(transaction);

    try {
      const categories = await categoriesFromMetaStore(transaction.objectStore(STORE_NAMES.meta));
      await done;
      return sortCategoriesByName(categories).map(cloneCategory);
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw this.transactionError('无法加载分类。', error);
    }
  }

  async getCategory(id: string): Promise<MomentCategory | undefined> {
    const categories = await this.listCategories();
    return categories.find((category) => category.id === id);
  }

  async createCategory(name: string): Promise<MomentCategory> {
    const normalizedName = normalizedCategoryName(name);
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readwrite');
    const done = transactionComplete(transaction);

    try {
      const store = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(store);
      assertAvailableCategoryName(categories, normalizedName);
      const now = cloneDate(this.clock());
      const category: MomentCategory = {
        id: `category-${this.idGenerator()}`,
        schemaVersion: CATEGORY_SCHEMA_VERSION,
        name: normalizedName,
        createdAt: cloneDate(now),
        updatedAt: cloneDate(now),
        lastUsedAt: cloneDate(now),
      };
      if (findCategory(categories, category.id)) {
        throw new DatabaseError('CONFLICT', 'Could not allocate a unique Category identifier.');
      }
      categories.push(category);
      store.put(categoryCatalogRecord(categories, now));
      await done;
      return cloneCategory(category);
    } catch (error) {
      if (error instanceof DatabaseError) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have aborted after a request failure.
        }
        await done.catch(() => undefined);
        throw error;
      }
      throw this.transactionError('无法创建分类。', error);
    }
  }

  async renameCategory(id: string, name: string): Promise<MomentCategory> {
    const normalizedName = normalizedCategoryName(name);
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readwrite');
    const done = transactionComplete(transaction);

    try {
      const store = transaction.objectStore(STORE_NAMES.meta);
      const categories = await categoriesFromMetaStore(store);
      const category = findCategory(categories, id);
      if (!category) throw new DatabaseError('NOT_FOUND', 'That Category no longer exists.');
      assertAvailableCategoryName(categories, normalizedName, id);
      const now = cloneDate(this.clock());
      category.name = normalizedName;
      category.updatedAt = cloneDate(now);
      store.put(categoryCatalogRecord(categories, now));
      await done;
      return cloneCategory(category);
    } catch (error) {
      if (error instanceof DatabaseError) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have finished.
        }
        await done.catch(() => undefined);
        throw error;
      }
      throw this.transactionError('无法重命名分类。', error);
    }
  }

  async mergeCategory(sourceId: string, targetId: string): Promise<number> {
    if (sourceId === targetId) {
      throw new DatabaseError('INVALID_DATA', 'Choose a different destination Category.');
    }
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.meta, STORE_NAMES.items, STORE_NAMES.notes],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const [categories, persistedItems, persistedNotes] = await Promise.all([
        categoriesFromMetaStore(metaStore),
        requestResult(itemStore.getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.notes).getAll()),
      ]);
      const source = findCategory(categories, sourceId);
      const target = findCategory(categories, targetId);
      if (!source || !target) {
        throw new DatabaseError(
          'NOT_FOUND',
          'A selected Category no longer exists. Reload the Library and try again.',
        );
      }
      const now = cloneDate(this.clock());
      let affected = 0;
      for (const value of persistedItems as PersistedLearningItem[]) {
        if (value.categoryId !== sourceId) continue;
        itemStore.put({ ...value, categoryId: targetId, updatedAt: now.toISOString() });
        affected += 1;
      }
      target.lastUsedAt = cloneDate(now);
      for (const value of persistedNotes as unknown[]) {
        const note = readNote(value);
        if (note.categoryId !== sourceId) continue;
        transaction
          .objectStore(STORE_NAMES.notes)
          .put({ ...note, categoryId: targetId, updatedAt: now.toISOString() });
        affected += 1;
      }
      target.updatedAt = cloneDate(now);
      metaStore.put(
        categoryCatalogRecord(
          categories.filter((category) => category.id !== sourceId),
          now,
        ),
      );
      await done;
      return affected;
    } catch (error) {
      if (error instanceof DatabaseError) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have finished.
        }
        await done.catch(() => undefined);
        throw error;
      }
      throw this.transactionError('无法合并分类。', error);
    }
  }

  async deleteCategory(id: string): Promise<number> {
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.meta, STORE_NAMES.items, STORE_NAMES.notes],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const [categories, persistedItems, persistedNotes] = await Promise.all([
        categoriesFromMetaStore(metaStore),
        requestResult(itemStore.getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.notes).getAll()),
      ]);
      if (!findCategory(categories, id)) {
        throw new DatabaseError('NOT_FOUND', 'That Category no longer exists.');
      }
      const now = cloneDate(this.clock());
      let affected = 0;
      for (const value of persistedItems as PersistedLearningItem[]) {
        if (value.categoryId !== id) continue;
        itemStore.put({ ...value, categoryId: null, updatedAt: now.toISOString() });
        affected += 1;
      }
      for (const value of persistedNotes as unknown[]) {
        const note = readNote(value);
        if (note.categoryId !== id) continue;
        transaction
          .objectStore(STORE_NAMES.notes)
          .put({ ...note, categoryId: null, updatedAt: now.toISOString() });
        affected += 1;
      }
      metaStore.put(
        categoryCatalogRecord(
          categories.filter((category) => category.id !== id),
          now,
        ),
      );
      await done;
      return affected;
    } catch (error) {
      if (error instanceof DatabaseError) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have finished.
        }
        await done.catch(() => undefined);
        throw error;
      }
      throw this.transactionError('无法删除分类。', error);
    }
  }

  /** Builds Category navigation counts without reading screenshots or review-history rows. */
  async listCategorySummaries(now: Date = this.clock()): Promise<CategorySummary[]> {
    const dueAt = validQueryDate(now, 'now');
    const database = await this.open();
    const transaction = database.transaction([STORE_NAMES.meta, STORE_NAMES.items], 'readonly');
    const done = transactionComplete(transaction);

    try {
      const [categories, persistedItems] = await Promise.all([
        categoriesFromMetaStore(transaction.objectStore(STORE_NAMES.meta)),
        requestResult(transaction.objectStore(STORE_NAMES.items).getAll()),
      ]);
      const categoryIds = new Set(categories.map((category) => category.id));
      const summaries = new Map<string | null, CategorySummary>();
      summaries.set(null, { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null });
      for (const category of categories) {
        summaries.set(category.id, {
          category: cloneCategory(category),
          totalCount: 0,
          dueCount: 0,
          nextReviewAt: null,
        });
      }
      for (const value of persistedItems as PersistedLearningItem[]) {
        try {
          const item = itemFromPersisted(value);
          const key =
            item.categoryId !== null && categoryIds.has(item.categoryId) ? item.categoryId : null;
          const summary = summaries.get(key);
          if (!summary) continue;
          summary.totalCount += 1;
          if (item.suspended) continue;
          const due = item.fsrsCard.due;
          if (due.getTime() <= dueAt.getTime()) summary.dueCount += 1;
          if (summary.nextReviewAt === null || due.getTime() < summary.nextReviewAt.getTime()) {
            summary.nextReviewAt = cloneDate(due);
          }
        } catch {
          // Invalid stored items stay out of navigation counts and remain diagnosable elsewhere.
        }
      }
      await done;
      const uncategorized = summaries.get(null);
      return [
        ...(uncategorized ? [uncategorized] : []),
        ...sortCategoriesByName(categories)
          .map((category) => summaries.get(category.id))
          .filter((summary): summary is CategorySummary => summary !== undefined),
      ];
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw this.transactionError('Could not load Category counts.', error);
    }
  }

  /** Returns a bounded recent-item projection without loading reviews or screenshots. */
  async listRecentItems(limit = 4): Promise<LearningItem[]> {
    const normalizedLimit = validUpcomingLimit(limit);
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.items, 'readonly');
    const done = transactionComplete(transaction);
    const index = transaction.objectStore(STORE_NAMES.items).index(INDEX_NAMES.itemUpdated);

    try {
      const items = await collectRecentItems(index, normalizedLimit);
      await done;
      return items;
    } catch (error) {
      throw this.transactionError('Could not list recent learning items.', error);
    }
  }

  /** Aggregate existing records in one readonly snapshot; never load screenshot blobs. */
  async getLearningStatistics(
    days: StatisticsDays,
    now: Date = this.clock(),
  ): Promise<LearningStatistics> {
    const accumulator = statisticsAccumulator(days, now);
    const database = await this.open();
    const transaction = database.transaction([STORE_NAMES.items, STORE_NAMES.reviews], 'readonly');
    const done = transactionComplete(transaction);
    try {
      await scanStatisticsRows(transaction.objectStore(STORE_NAMES.items), accumulator.item);
      await scanStatisticsRows(transaction.objectStore(STORE_NAMES.reviews), accumulator.review);
      await done;
      return accumulator.result();
    } catch (error) {
      await done.catch(() => undefined);
      throw this.transactionError('学习统计无法加载。', error);
    }
  }

  /** Counts review log rows in a half-open interval without reconstructing item histories. */
  async countReviewsBetween(after: Date, before: Date): Promise<number> {
    const start = validQueryDate(after, 'after');
    const end = validQueryDate(before, 'before');
    if (end.getTime() <= start.getTime()) return 0;

    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.reviews, 'readonly');
    const done = transactionComplete(transaction);
    const store = transaction.objectStore(STORE_NAMES.reviews);

    try {
      const count = await countReviewRowsBetween(store, start.getTime(), end.getTime());
      await done;
      return count;
    } catch (error) {
      throw this.transactionError('Could not count completed reviews.', error);
    }
  }

  async createTask(input: NewDailyTask, draft?: DraftToken): Promise<DailyTask> {
    return (await this.createTaskWithReward(input, draft)).task;
  }

  /**
   * The same atomic create, also returning the creation grant it committed, so the UI can
   * show that exact amount once. The money rule itself is unchanged and lives in
   * applyTaskCreationReward.
   */
  async createTaskWithReward(
    input: NewDailyTask,
    draft?: DraftToken,
  ): Promise<{ task: DailyTask; reward: TaskAllowanceResult }> {
    const now = cloneDate(this.clock());
    const task = createTaskRecord(input, this.idGenerator(), now);
    await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.dailyTasks,
        STORE_NAMES.items,
        STORE_NAMES.taskRevisions,
        STORE_NAMES.wallet,
        STORE_NAMES.drafts,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const used = await requestResult(
        transaction.objectStore(STORE_NAMES.taskRevisions).getKey(task.id),
      );
      if (used !== undefined) throw new DatabaseError('CONFLICT', '这项待办已创建过。');
      if (task.linkedLearningItemId !== null) {
        const linkedItem = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(task.linkedLearningItemId),
        );
        if (!linkedItem) {
          transaction.abort();
          await done.catch(() => undefined);
          throw new DatabaseError(
            'NOT_FOUND',
            `Learning item ${task.linkedLearningItemId} was not found.`,
          );
        }
      }
      transaction.objectStore(STORE_NAMES.dailyTasks).add(cloneDailyTask(task));
      const reward = applyTaskCreationReward(
        await walletInTransaction(transaction),
        localDateKey(now),
        now.toISOString(),
      );
      putWallet(transaction, reward.state);
      bumpTaskRevision(transaction, task.id);
      await consumeDraft(transaction, draft);
      await done;
      return { task: cloneDailyTask(task), reward: structuredClone(reward) };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (error instanceof DatabaseError) throw error;
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Task ${task.id} already exists.`, error);
      }
      throw this.transactionError('Could not save the task.', error);
    }
  }

  async updateTask(id: string, changes: DailyTaskUpdate, commit?: EditCommit): Promise<DailyTask> {
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.dailyTasks,
        STORE_NAMES.items,
        STORE_NAMES.taskRevisions,
        STORE_NAMES.wallet,
        STORE_NAMES.drafts,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);

    try {
      const raw: unknown = await requestResult(
        transaction.objectStore(STORE_NAMES.dailyTasks).get(id),
      );
      if (raw === undefined) throw new DatabaseError('NOT_FOUND', `Task ${id} was not found.`);
      const current = taskFromUnknown(raw, `task ${id}`);
      checkEditState(current, commit);
      const updated = normalizeTask({
        ...current,
        ...changes,
        id: current.id,
        schemaVersion: DAILY_TASK_SCHEMA_VERSION,
        createdAt: current.createdAt,
        updatedAt: this.clock().toISOString(),
        selectedWeekdays: changes.selectedWeekdays ?? current.selectedWeekdays,
      });
      if (updated.linkedLearningItemId !== null) {
        const linkedItem = await requestResult(
          transaction.objectStore(STORE_NAMES.items).get(updated.linkedLearningItemId),
        );
        if (!linkedItem) {
          transaction.abort();
          await done.catch(() => undefined);
          throw new DatabaseError(
            'NOT_FOUND',
            `Learning item ${updated.linkedLearningItemId} was not found.`,
          );
        }
      }
      transaction.objectStore(STORE_NAMES.dailyTasks).put(cloneDailyTask(updated));
      bumpTaskRevision(transaction, id);
      await consumeDraft(transaction, commit?.draft);
      await done;
      return cloneDailyTask(updated);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      if (error instanceof DatabaseError) throw error;
      throw this.transactionError('Could not update the task.', error);
    }
  }

  archiveTask(id: string, archived = true): Promise<DailyTask> {
    return this.updateTask(id, { archived });
  }

  async deleteTask(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.dailyTasks,
        STORE_NAMES.taskCompletions,
        STORE_NAMES.taskRevisions,
        STORE_NAMES.wallet,
        STORE_NAMES.taskSkips,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      transaction.objectStore(STORE_NAMES.dailyTasks).delete(id);
      bumpTaskRevision(transaction, id, true);
      await deleteIndexEntries(
        transaction.objectStore(STORE_NAMES.taskSkips).index(INDEX_NAMES.completionTask),
        id,
      );
      await deleteIndexEntries(
        transaction.objectStore(STORE_NAMES.taskCompletions).index(INDEX_NAMES.completionTask),
        id,
      );
      await done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw this.transactionError('Could not delete the task.', error);
    }
  }

  async getTask(id: string): Promise<DailyTask | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.dailyTasks, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const value = await requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).get(id));
      await done;
      return value === undefined ? undefined : taskFromUnknown(value, `task ${id}`);
    } catch (error) {
      throw this.transactionError('Could not load the task.', error);
    }
  }

  async listTasks(options: ListTasksOptions = {}): Promise<DailyTask[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.dailyTasks, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const values = await requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).getAll());
      await done;
      return (values as unknown[])
        .map((value, index) => taskFromUnknown(value, `stored tasks[${index}]`))
        .filter((task) => {
          const status = options.status ?? 'all';
          return status === 'all' || (status === 'archived' ? task.archived : !task.archived);
        })
        .filter((task) => options.kind === undefined || task.kind === options.kind)
        .filter((task) => options.priority === undefined || task.priority === options.priority)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title),
        )
        .map(cloneDailyTask);
    } catch (error) {
      throw this.transactionError('Could not list tasks.', error);
    }
  }

  async listTasksForDate(localDate: string): Promise<TaskOccurrence[]> {
    const { tasks, completions, skips } = await this.readTaskRecords();
    return buildTaskDaySummary(tasks, completions, localDate, skips).occurrences;
  }

  async getHomeTaskOverview(localDate: string): Promise<HomeTaskOverview> {
    if (!isLocalDateKey(localDate)) {
      throw new DatabaseError('INVALID_DATA', '请选择有效的任务日期。');
    }
    const { tasks, completions, skips } = await this.readTaskRecords();
    return {
      ...buildHomeTaskOverview(tasks, completions, skips, localDate),
      skipped: skippedTodayOccurrences(tasks, skips, localDate),
    };
  }

  private async readTaskRecords() {
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.dailyTasks, STORE_NAMES.taskCompletions, STORE_NAMES.taskSkips],
      'readonly',
    );
    const done = transactionComplete(transaction);
    try {
      const [taskValues, completionValues, skipValues] = await Promise.all([
        requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskCompletions).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskSkips).getAll()),
      ]);
      await done;
      const tasks = (taskValues as unknown[]).map((value, index) =>
        taskFromUnknown(value, `stored tasks[${index}]`),
      );
      const completions = (completionValues as unknown[]).map((value, index) =>
        taskCompletionFromUnknown(value, `stored taskCompletions[${index}]`),
      );
      return {
        tasks,
        completions,
        skips: (skipValues as unknown[]).map(readTaskSkip),
      };
    } catch (error) {
      throw this.transactionError('Could not list tasks for the selected date.', error);
    }
  }

  listTodayTasks(now: Date = this.clock()): Promise<TaskOccurrence[]> {
    return this.listTasksForDate(localDateKey(now));
  }

  async getTaskDaySummary(localDate: string = localDateKey(this.clock())): Promise<TaskDaySummary> {
    const occurrences = await this.listTasksForDate(localDate);
    const completed = occurrences.filter((occurrence) => occurrence.completion !== null).length;
    return {
      localDate,
      total: occurrences.length,
      completed,
      remaining: occurrences.length - completed,
      occurrences,
    };
  }

  async countRemainingTasksToday(now: Date = this.clock()): Promise<number> {
    return (await this.getTaskDaySummary(localDateKey(now))).remaining;
  }

  async completeTaskForDate(
    taskId: string,
    localDate: string = localDateKey(this.clock()),
  ): Promise<TaskCompletion> {
    return (await this.completeTaskForDateWithResult(taskId, localDate)).completion;
  }

  async completeTaskForDateWithResult(
    taskId: string,
    localDate: string = localDateKey(this.clock()),
  ): Promise<import('./types').TaskCompletionResult> {
    if (!isLocalDateKey(localDate)) {
      throw new DatabaseError('INVALID_DATA', 'Task completion date must use YYYY-MM-DD.');
    }
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.dailyTasks,
        STORE_NAMES.taskCompletions,
        STORE_NAMES.occurrenceRevisions,
        STORE_NAMES.wallet,
        STORE_NAMES.taskSkips,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      const completionStore = transaction.objectStore(STORE_NAMES.taskCompletions);
      const [taskValue, existingValue, skip] = await Promise.all([
        requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).get(taskId)),
        requestResult(
          completionStore.index(INDEX_NAMES.completionTaskAndDate).get([taskId, localDate]),
        ),
        requestResult(transaction.objectStore(STORE_NAMES.taskSkips).get([taskId, localDate])),
      ]);
      if (taskValue === undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError('NOT_FOUND', `Task ${taskId} was not found.`);
      }
      const task = taskFromUnknown(taskValue, `task ${taskId}`);
      // One-off identity survives schedule edits, including the non-wallet import API.
      if (task.recurrence === 'specific_date') {
        const previous = await requestResult<unknown[]>(
          completionStore.index(INDEX_NAMES.completionTask).getAll(taskId),
        );
        if (previous.length > 0) {
          await done;
          return {
            completion: taskCompletionFromUnknown(previous[0], `completion for ${taskId}`),
            created: false,
          };
        }
      }
      if (skip !== undefined) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError('CONFLICT', '该次待办已跳过，请先恢复。');
      }
      if (!isTaskScheduledOnDate(task, localDate)) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError('INVALID_DATA', `Task ${taskId} is not active on ${localDate}.`);
      }
      if (existingValue !== undefined) {
        await done;
        return {
          completion: taskCompletionFromUnknown(existingValue, `completion for ${taskId}`),
          created: false,
        };
      }
      const completion: TaskCompletion = {
        id: this.idGenerator(),
        taskId,
        localDate,
        completedAt: this.clock().toISOString(),
      };
      completionStore.add(cloneTaskCompletion(completion));
      bumpOccurrenceRevision(transaction, taskId, localDate, false);
      await done;
      return { completion: cloneTaskCompletion(completion), created: true };
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      if (isConstraintError(error)) {
        const existing = await this.getTaskCompletionForDate(taskId, localDate);
        if (existing) return { completion: existing, created: false };
        throw new DatabaseError(
          'CONFLICT',
          `Task ${taskId} is already complete for ${localDate}.`,
          error,
        );
      }
      throw this.transactionError('Could not complete the task.', error);
    }
  }

  async undoTaskCompletion(taskId: string, localDate: string): Promise<boolean> {
    if (!isLocalDateKey(localDate)) {
      throw new DatabaseError('INVALID_DATA', 'Task completion date must use YYYY-MM-DD.');
    }
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.taskCompletions, STORE_NAMES.occurrenceRevisions, STORE_NAMES.wallet],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      const store = transaction.objectStore(STORE_NAMES.taskCompletions);
      const key = await requestResult(
        store.index(INDEX_NAMES.completionTaskAndDate).getKey([taskId, localDate]),
      );
      if (key !== undefined) {
        store.delete(key);
        bumpOccurrenceRevision(transaction, taskId, localDate, false);
      }
      await done;
      return key !== undefined;
    } catch (error) {
      throw this.transactionError('Could not undo the task completion.', error);
    }
  }

  async listTaskCompletions(taskId?: string): Promise<TaskCompletion[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.taskCompletions, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const store = transaction.objectStore(STORE_NAMES.taskCompletions);
      const values = await requestResult(
        taskId === undefined
          ? store.getAll()
          : store.index(INDEX_NAMES.completionTask).getAll(IDBKeyRange.only(taskId)),
      );
      await done;
      return (values as unknown[])
        .map((value, index) => taskCompletionFromUnknown(value, `stored taskCompletions[${index}]`))
        .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
        .map(cloneTaskCompletion);
    } catch (error) {
      throw this.transactionError('Could not list task completions.', error);
    }
  }

  changeTaskCompletionAtomic(
    taskId: string,
    date: string,
    completed: boolean,
    now: Date = this.clock(),
  ): Promise<AtomicTaskChange> {
    return new SyncRepository(this).changeTaskCompletionAtomic(taskId, date, completed, now);
  }

  changeTaskSkipAtomic(
    kind: 'skip-task' | 'restore-task',
    taskId: string,
    date: string,
    now: Date = this.clock(),
  ): Promise<{ changed: boolean }> {
    return new SyncRepository(this).changeTaskSkipAtomic(kind, taskId, date, now);
  }

  async getTaskCompletionForDate(
    taskId: string,
    localDate: string,
  ): Promise<TaskCompletion | undefined> {
    if (!isLocalDateKey(localDate)) {
      throw new DatabaseError('INVALID_DATA', 'Task completion date must use YYYY-MM-DD.');
    }
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.taskCompletions, 'readonly');
    const done = transactionComplete(transaction);
    try {
      const value = await requestResult(
        transaction
          .objectStore(STORE_NAMES.taskCompletions)
          .index(INDEX_NAMES.completionTaskAndDate)
          .get([taskId, localDate]),
      );
      await done;
      return value === undefined
        ? undefined
        : taskCompletionFromUnknown(value, `completion for ${taskId}`);
    } catch (error) {
      throw this.transactionError('Could not load the task completion.', error);
    }
  }

  async saveReview(input: SaveReviewInput): Promise<ReviewRecord> {
    if (!input.card || !input.log) {
      throw new DatabaseError('INVALID_DATA', 'A card and review log are required.');
    }
    const expectedState = reviewSchedulingStateFromCard(
      cardFromReviewSchedulingState(input.expectedState),
    );

    const record: ReviewRecord = {
      id: input.id ?? this.idGenerator(),
      itemId: input.itemId,
      reviewedAt: cloneDate(input.log.review),
      log: input.log,
    };
    const database = await this.open();
    const transaction = database.transaction([STORE_NAMES.items, STORE_NAMES.reviews], 'readwrite');
    const done = transactionComplete(transaction);

    try {
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const persisted = (await requestResult(itemStore.get(input.itemId))) as
        PersistedLearningItem | undefined;
      if (!persisted) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError('NOT_FOUND', `Learning item ${input.itemId} was not found.`);
      }

      const current = migratePersistedItem(persisted);
      if (current.suspended) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError(
          'CONFLICT',
          'This learning item was suspended before the review could be saved.',
        );
      }
      const currentCard = cardFromPersisted(current.fsrsCard);
      if (!reviewSchedulingStatesMatch(currentCard, expectedState)) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new DatabaseError(
          'CONFLICT',
          'This learning item changed before the review could be saved. Refresh review session.',
        );
      }

      itemStore.put({
        ...current,
        fsrsCard: cardToPersisted(input.card),
        updatedAt: record.reviewedAt.toISOString(),
      } satisfies PersistedLearningItem);
      transaction.objectStore(STORE_NAMES.reviews).add(reviewRecordToPersisted(record));
      await done;
      return reviewRecordFromPersisted(reviewRecordToPersisted(record));
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      if (isConstraintError(error)) {
        throw new DatabaseError('CONFLICT', `Review ${record.id} already exists.`, error);
      }
      throw this.transactionError('Could not save the review.', error);
    }
  }

  async listReviews(itemId: string): Promise<ReviewRecord[]> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.reviews, 'readonly');
    const done = transactionComplete(transaction);
    const request = transaction
      .objectStore(STORE_NAMES.reviews)
      .index(INDEX_NAMES.reviewItemAndDate)
      .getAll(IDBKeyRange.bound([itemId, ''], [itemId, '\uffff']));

    try {
      const records = (await requestResult(request)) as PersistedReviewRecord[];
      await done;
      return records.map(reviewRecordFromPersisted);
    } catch (error) {
      throw this.transactionError('Could not load review history.', error);
    }
  }

  async saveScreenshot(blob: Blob, id: string = this.idGenerator()): Promise<string> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.screenshots, 'readwrite');
    const done = transactionComplete(transaction);
    const record: ScreenshotRecord = {
      id,
      blob,
      createdAt: this.clock().toISOString(),
    };
    transaction.objectStore(STORE_NAMES.screenshots).put(record);

    try {
      await done;
      return id;
    } catch (error) {
      throw this.transactionError('Could not save the screenshot.', error);
    }
  }

  async getScreenshot(id: string): Promise<Blob | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.screenshots, 'readonly');
    const done = transactionComplete(transaction);

    try {
      const record = (await requestResult(
        transaction.objectStore(STORE_NAMES.screenshots).get(id),
      )) as ScreenshotRecord | undefined;
      await done;
      return record?.blob;
    } catch (error) {
      throw this.transactionError('Could not load the screenshot.', error);
    }
  }

  getImageAsset(id: string): Promise<Blob | undefined> {
    return this.getScreenshot(id);
  }

  async exportTasks(): Promise<ValRecallTaskExport> {
    const database = await this.open();
    const transaction = database.transaction(
      [STORE_NAMES.dailyTasks, STORE_NAMES.taskCompletions, STORE_NAMES.taskSkips],
      'readonly',
    );
    const done = transactionComplete(transaction);
    try {
      const [taskValues, completionValues, skipValues] = await Promise.all([
        requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskCompletions).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskSkips).getAll()),
      ]);
      await done;
      return {
        application: 'ValRecall',
        schemaVersion: TASK_EXPORT_SCHEMA_VERSION,
        taskSkips: (skipValues as unknown[]).map(readTaskSkip),
        exportedAt: this.clock().toISOString(),
        tasks: (taskValues as unknown[]).map((value, index) =>
          taskFromUnknown(value, `stored tasks[${index}]`),
        ),
        taskCompletions: (completionValues as unknown[]).map((value, index) =>
          taskCompletionFromUnknown(value, `stored taskCompletions[${index}]`),
        ),
      };
    } catch (error) {
      throw this.transactionError('Could not export tasks.', error);
    }
  }

  async importTasks(value: unknown, mode: ImportMode = 'merge'): Promise<TaskImportResult> {
    if (mode !== 'merge' && mode !== 'replace') {
      throw new DatabaseError('INVALID_DATA', `Unsupported import mode: ${String(mode)}.`);
    }
    const imported = validateTaskExport(value);
    const database = await this.open();
    const transaction = database.transaction(
      [
        STORE_NAMES.dailyTasks,
        STORE_NAMES.taskCompletions,
        STORE_NAMES.items,
        STORE_NAMES.taskRevisions,
        STORE_NAMES.occurrenceRevisions,
        STORE_NAMES.wallet,
        STORE_NAMES.taskSkips,
      ],
      'readwrite',
    );
    const done = transactionComplete(transaction);
    try {
      const taskStore = transaction.objectStore(STORE_NAMES.dailyTasks);
      const completionStore = transaction.objectStore(STORE_NAMES.taskCompletions);
      const [existingCompletionValues, learningItemKeys, existingSkipValues] = await Promise.all([
        requestResult(completionStore.getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.items).getAllKeys()),
        requestResult(transaction.objectStore(STORE_NAMES.taskSkips).getAll()),
      ]);
      const existingCompletions = (existingCompletionValues as unknown[]).map((entry, index) =>
        taskCompletionFromUnknown(entry, `stored taskCompletions[${index}]`),
      );
      const tasksToPut = clearMissingTaskLinks(
        imported.tasks,
        stringKeys(learningItemKeys as IDBValidKey[]),
      );
      const completionsToPut =
        mode === 'merge'
          ? taskCompletionsForMerge(existingCompletions, imported.taskCompletions)
          : imported.taskCompletions;
      const skipsToPut =
        mode === 'merge'
          ? mergeTaskSkips(
              (existingSkipValues as unknown[]).map(readTaskSkip),
              imported.taskSkips,
              existingCompletions,
              imported.taskCompletions,
            )
          : imported.taskSkips;

      if (mode === 'replace') {
        await preserveTaskProvenance(transaction, existingCompletions);
        taskStore.clear();
        completionStore.clear();
        transaction.objectStore(STORE_NAMES.taskSkips).clear();
        rotateSyncEpoch(transaction);
      }
      for (const task of tasksToPut) {
        taskStore.put(cloneDailyTask(task));
        bumpTaskRevision(transaction, task.id);
      }
      for (const skip of skipsToPut) transaction.objectStore(STORE_NAMES.taskSkips).put(skip);
      for (const completion of completionsToPut) {
        completionStore.put(cloneTaskCompletion(completion));
        await reviseImportedCompletion(
          transaction,
          completion,
          existingCompletions.some(
            (row) => row.taskId === completion.taskId && row.localDate === completion.localDate,
          ),
        );
      }
      await done;
      return {
        tasks: imported.tasks.length,
        taskCompletions: imported.taskCompletions.length,
      };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw this.transactionError('Could not import tasks.', error);
    }
  }

  async listNotes(): Promise<NoteRecord[]> {
    const tx = (await this.open()).transaction(STORE_NAMES.notes, 'readonly');
    const done = transactionComplete(tx);
    const rows: unknown[] = await requestResult(tx.objectStore(STORE_NAMES.notes).getAll());
    await done;
    return rows.map(readNote).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getNote(id: string): Promise<NoteRecord | undefined> {
    const tx = (await this.open()).transaction(STORE_NAMES.notes, 'readonly');
    const done = transactionComplete(tx);
    const value: unknown = await requestResult(tx.objectStore(STORE_NAMES.notes).get(id));
    await done;
    return value === undefined ? undefined : readNote(value);
  }

  async listNoteQuestions(noteId: string): Promise<LearningItem[]> {
    const tx = (await this.open()).transaction(STORE_NAMES.items, 'readonly');
    const done = transactionComplete(tx);
    const values: unknown[] = await requestResult(tx.objectStore(STORE_NAMES.items).getAll());
    await done;
    return values
      .filter((value) => {
        if (!value || typeof value !== 'object') return false;
        const row = value as { noteSource?: unknown };
        return isNoteSource(row.noteSource) && row.noteSource.noteId === noteId;
      })
      .map((value) => itemFromPersisted(migratePersistedItem(value)));
  }

  async updateNote(note: NoteRecord): Promise<NoteRecord> {
    return updateNoteStore(
      await this.open(),
      {
        ...note,
        updatedAt: new Date(
          Math.max(this.clock().getTime(), Date.parse(note.updatedAt) + 1),
        ).toISOString(),
      },
      note.updatedAt,
    );
  }

  async deleteNote(id: string): Promise<void> {
    const tx = (await this.open()).transaction(STORE_NAMES.notes, 'readwrite');
    const done = transactionComplete(tx);
    tx.objectStore(STORE_NAMES.notes).delete(id);
    await done;
  }

  async previewIntake(input: IntakeSelection): Promise<IntakeResult> {
    return processIntake(await this.open(), input, false, this.clock(), this.idGenerator);
  }

  async receiveIntake(input: IntakeSelection, mode: ShortTermReviewMode): Promise<IntakeResult> {
    return processIntake(await this.open(), input, true, this.clock(), this.idGenerator, mode);
  }

  async receiveAtomicIntake(
    input: IntakeSelection,
    mode: ShortTermReviewMode,
    commit: IntakeCommit,
  ): Promise<IntakeResult> {
    await new WalletRepository(this).ensureWallet();
    return processIntake(
      await this.open(),
      input,
      true,
      this.clock(),
      this.idGenerator,
      mode,
      commit,
    );
  }

  async finishIntakeReward(ids: string[], reward: IntakeReceipt['reward']): Promise<void> {
    const tx = (await this.open()).transaction(STORE_NAMES.intakeReceipts, 'readwrite');
    const done = transactionComplete(tx);
    void done.catch(() => undefined);
    try {
      const store = tx.objectStore(STORE_NAMES.intakeReceipts);
      for (const id of ids) {
        const value: unknown = await requestResult(store.get(id));
        if (value !== undefined) store.put({ ...readReceipt(value), reward });
      }
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async exportData(): Promise<ValRecallExport> {
    await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORE_NAMES), 'readonly');
    const done = transactionComplete(transaction);

    try {
      const [
        items,
        reviews,
        screenshots,
        meta,
        tasks,
        taskCompletions,
        notes,
        intakeReceipts,
        wallet,
        syncReceipts,
        taskRevisions,
        occurrenceRevisions,
        taskSkips,
        drafts,
        learningReceipts,
        reviewSessions,
      ] = await Promise.all([
        requestResult(transaction.objectStore(STORE_NAMES.items).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.reviews).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.screenshots).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.meta).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.dailyTasks).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskCompletions).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.notes).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.intakeReceipts).getAll()),
        walletInTransaction(transaction),
        requestResult(transaction.objectStore(STORE_NAMES.syncReceipts).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskRevisions).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.occurrenceRevisions).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.taskSkips).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.drafts).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.learningReceipts).getAll()),
        requestResult(transaction.objectStore(STORE_NAMES.reviewSessions).getAll()),
      ]);
      await done;

      const exportedItems = (items as PersistedLearningItem[]).map(migratePersistedItem);
      const owners = assetOwners(
        exportedItems.map((item) => itemFromPersisted(item)),
        'Stored data',
      );
      const screenshotRecords = screenshots as ScreenshotRecord[];
      const storedAssetIds = new Set(screenshotRecords.map((record) => record.id));
      for (const assetId of owners.keys()) {
        if (!storedAssetIds.has(assetId)) {
          throw new DatabaseError(
            'INVALID_DATA',
            `Stored learning data references missing image asset ${assetId}.`,
          );
        }
      }
      const exportedScreenshots = await Promise.all(
        screenshotRecords
          .filter((record) => owners.has(record.id))
          .map(async (record): Promise<ExportedScreenshot> => ({
            id: record.id,
            mimeType: record.blob.type,
            createdAt: record.createdAt,
            dataBase64: await blobToBase64(record.blob),
          })),
      );
      const categoryRecord = (meta as PersistedMetaRecord[]).find(
        (record) => record.key === CATEGORY_CATALOG_META_KEY,
      );
      const categories = categoryCatalogFromUnknown(categoryRecord?.value);

      return {
        ...(await exportReliability(drafts, learningReceipts, reviewSessions)),
        application: 'ValRecall',
        schemaVersion: EXPORT_SCHEMA_VERSION,
        taskSkips: (taskSkips as unknown[]).map(readTaskSkip),
        exportedAt: this.clock().toISOString(),
        items: exportedItems,
        reviews: (reviews as PersistedReviewRecord[]).map((record) =>
          reviewRecordToPersisted(reviewRecordFromPersisted(record)),
        ),
        screenshots: exportedScreenshots,
        meta: (meta as PersistedMetaRecord[]).filter(
          (record) =>
            !record.key.startsWith('runtime.') && record.key !== CATEGORY_CATALOG_META_KEY,
        ),
        categories: categories.map(categoryToPersisted),
        tasks: (tasks as unknown[]).map((value, index) =>
          taskFromUnknown(value, `stored tasks[${index}]`),
        ),
        taskCompletions: (taskCompletions as unknown[]).map((value, index) =>
          taskCompletionFromUnknown(value, `stored taskCompletions[${index}]`),
        ),
        notes: (notes as unknown[]).map(readNote),
        intakeReceipts: (intakeReceipts as unknown[]).map(readReceipt),
        wallet,
        sync: readSyncBackup({ receipts: syncReceipts, taskRevisions, occurrenceRevisions }),
      };
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw this.transactionError('Could not export local data.', error);
    }
  }

  async importData(
    value: unknown,
    mode: ImportMode = 'merge',
    options: { restoreWallet?: boolean } = {},
  ): Promise<ImportResult> {
    const imported = validateExport(value);
    const reliability = importReliability(value, imported.schemaVersion);
    const importedWallet = imported.schemaVersion >= 9 ? readAllowanceState(imported.wallet) : null;
    const importedSync = imported.schemaVersion >= 9 ? readSyncBackup(imported.sync) : null;
    if (options.restoreWallet && (mode !== 'replace' || !importedWallet))
      throw new DatabaseError('INVALID_DATA', '只有明确选择版本 9 的替换恢复才能恢复零花钱。');
    const notes = imported.notes.map(readNote);
    const intakeReceipts = imported.intakeReceipts.map(readReceipt);
    assertUnique(
      notes.map((note) => note.id),
      'note',
    );
    assertUnique(
      intakeReceipts.map((receipt) => receipt.id),
      'intake receipt',
    );
    if (mode !== 'merge' && mode !== 'replace') {
      throw new DatabaseError('INVALID_DATA', `Unsupported import mode: ${String(mode)}.`);
    }
    const items = imported.items.map((item, index) =>
      migrateImportedItem(item, imported.schemaVersion, index),
    );
    const reviews = imported.reviews.map((record) =>
      reviewRecordToPersisted(reviewRecordFromPersisted(record)),
    );
    assertUnique(
      items.map((item) => item.id),
      'learning item',
    );
    const importedDomainItems = items.map((item) => itemFromPersisted(item));
    const importedOwners =
      imported.schemaVersion >= 6 ? assetOwners(importedDomainItems, 'The media import') : null;
    const encodedScreenshots = imported.screenshots.map((value, index) => {
      const record = importRecord(value, `screenshots[${index}]`);
      return {
        id: importString(record.id, `screenshots[${index}].id`),
        dataBase64: importString(record.dataBase64, `screenshots[${index}].dataBase64`, true),
        mimeType: importString(record.mimeType, `screenshots[${index}].mimeType`, true),
        createdAt: importDate(record.createdAt, `screenshots[${index}].createdAt`),
      };
    });
    assertUnique(
      encodedScreenshots.map((screenshot) => screenshot.id),
      'screenshot',
    );
    const imageAssetIds = new Set(
      importedDomainItems
        .filter((item): item is ImageLearningItem => item.sourceType === 'image')
        .map((item) => item.imageAssetId),
    );
    const screenshots: ScreenshotRecord[] = encodedScreenshots
      .filter((screenshot) => importedOwners === null || importedOwners.has(screenshot.id))
      .map((record) => ({
        id: record.id,
        blob: base64ToBlob(
          record.dataBase64,
          record.mimeType,
          `Imported image asset ${record.id}`,
          imageAssetIds.has(record.id)
            ? LIBRARY_IMAGE_STORED_MAX_BYTES
            : MAX_IMPORTED_SCREENSHOT_BYTES,
        ),
        createdAt: record.createdAt,
      }));
    const categories = categoriesFromUnknown(imported.categories, 'categories');
    const meta = imported.meta.map((value, index): PersistedMetaRecord => {
      const record = importRecord(value, `meta[${index}]`);
      return {
        key: importString(record.key, `meta[${index}].key`),
        value: record.value,
        updatedAt: importDate(record.updatedAt, `meta[${index}].updatedAt`),
      };
    });
    const { tasks, taskCompletions, taskSkips } = validateTaskGraph(
      imported.tasks,
      imported.taskCompletions,
      imported.taskSkips,
    );

    assertUnique(
      reviews.map((review) => review.id),
      'review',
    );
    assertUnique(
      meta.map((record) => record.key),
      'metadata',
    );

    const itemIds = new Set(items.map((item) => item.id));
    const screenshotIds = new Set(screenshots.map((screenshot) => screenshot.id));
    const screenshotById = new Map(screenshots.map((screenshot) => [screenshot.id, screenshot]));
    for (const item of importedDomainItems) {
      const validation =
        item.sourceType === 'text' || item.sourceType === 'image'
          ? validateTextMomentDraft(item)
          : validateLearningItemDraft({
              ...item,
              sourceUrl: item.sourceUrl,
              timestampSeconds: item.timestampSeconds ?? undefined,
            });
      if (!validation.valid || (item.sourceType === 'video' && !item.videoTitle.trim())) {
        throw new DatabaseError(
          'INVALID_DATA',
          `Imported learning item ${item.id} is invalid. ${validation.issues
            .map((issue) => issue.message)
            .join(' ')}`,
        );
      }
      if (item.sourceType === 'image') {
        const asset = screenshotById.get(item.imageAssetId);
        const assetIssue = asset
          ? await importedLibraryImageIssue({
              blob: asset.blob,
              width: item.imageWidth,
              height: item.imageHeight,
            })
          : 'The referenced image asset is missing.';
        if (assetIssue || asset?.blob.type !== item.imageMimeType) {
          throw new DatabaseError(
            'INVALID_DATA',
            `Imported Image Moment ${item.id} has an invalid image asset. ${assetIssue ?? ''}`.trim(),
          );
        }
      }
      if (
        imported.schemaVersion >= 6 &&
        item.sourceType === 'video' &&
        item.videoOrigin === 'library' &&
        item.screenshotId !== null
      ) {
        throw new DatabaseError(
          'INVALID_DATA',
          `Imported Library Video ${item.id} must not reference a captured screenshot.`,
        );
      }
      if (
        item.sourceType === 'video' &&
        item.videoOrigin !== 'library' &&
        (!item.screenshotId || !screenshotIds.has(item.screenshotId))
      ) {
        throw new DatabaseError(
          'INVALID_DATA',
          `Imported learning item ${item.id} is missing its referenced screenshot.`,
        );
      }
    }
    for (const review of reviews) {
      if (!itemIds.has(review.itemId)) {
        throw new DatabaseError(
          'INVALID_DATA',
          `Imported review ${review.id} references an unknown learning item.`,
        );
      }
    }
    if (
      meta.some(
        (record) => record.key.startsWith('runtime.') || record.key === CATEGORY_CATALOG_META_KEY,
      )
    ) {
      throw new DatabaseError(
        'INVALID_DATA',
        'Runtime-only or reserved Category metadata cannot be imported.',
      );
    }

    await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORE_NAMES), 'readwrite');
    const done = transactionComplete(transaction);

    try {
      const itemStore = transaction.objectStore(STORE_NAMES.items);
      const taskStore = transaction.objectStore(STORE_NAMES.dailyTasks);
      const taskCompletionStore = transaction.objectStore(STORE_NAMES.taskCompletions);
      const metaStore = transaction.objectStore(STORE_NAMES.meta);
      const [
        existingCompletionValues,
        existingLearningItemValues,
        existingCategories,
        existingAssetKeys,
        existingSkipValues,
      ] = await Promise.all([
        mode === 'merge' || !options.restoreWallet
          ? requestResult(taskCompletionStore.getAll())
          : Promise.resolve([]),
        mode === 'merge' ? requestResult(itemStore.getAll()) : Promise.resolve([]),
        mode === 'merge' ? categoriesFromMetaStore(metaStore) : Promise.resolve([]),
        mode === 'merge'
          ? requestResult(transaction.objectStore(STORE_NAMES.screenshots).getAllKeys())
          : Promise.resolve([]),
        mode === 'merge'
          ? requestResult(transaction.objectStore(STORE_NAMES.taskSkips).getAll())
          : Promise.resolve([]),
      ]);
      const importedCategoryIds = new Set(categories.map((category) => category.id));
      const finalCategories =
        mode === 'merge'
          ? [
              ...existingCategories.filter((category) => !importedCategoryIds.has(category.id)),
              ...categories,
            ]
          : categories;
      const finalCategoryNameKeys = finalCategories.map((category) =>
        categoryNameKey(category.name),
      );
      if (new Set(finalCategoryNameKeys).size !== finalCategoryNameKeys.length) {
        throw new DatabaseError(
          'CONFLICT',
          'Imported Categories conflict with an existing Category name.',
        );
      }
      const finalCategoryIds = new Set(finalCategories.map((category) => category.id));
      for (const item of [...items, ...notes]) {
        if (item.categoryId !== null && !finalCategoryIds.has(item.categoryId)) {
          throw new DatabaseError(
            'INVALID_DATA',
            `Imported learning item ${item.id} references an unknown Category.`,
          );
        }
      }
      const existingCompletions = (existingCompletionValues as unknown[]).map((entry, index) =>
        taskCompletionFromUnknown(entry, `stored taskCompletions[${index}]`),
      );
      const existingItems = (existingLearningItemValues as PersistedLearningItem[]).map((item) =>
        itemFromPersisted(item),
      );
      const importedItemIds = new Set(items.map((item) => item.id));
      const finalItems = [
        ...existingItems.filter((item) => !importedItemIds.has(item.id)),
        ...items.map((item) => itemFromPersisted(item)),
      ];
      const finalOwners =
        imported.schemaVersion >= 6 ? assetOwners(finalItems, 'The final merged data') : null;
      if (mode === 'merge' && importedOwners !== null) {
        const existingOwners = new Map<string, string[]>();
        for (const existingItem of existingItems) {
          const assetId = itemAssetId(existingItem);
          if (assetId === null) continue;
          existingOwners.set(assetId, [...(existingOwners.get(assetId) ?? []), existingItem.id]);
        }
        const occupiedAssetIds = stringKeys(existingAssetKeys as IDBValidKey[]);
        for (const screenshot of screenshots) {
          const ownerIds = existingOwners.get(screenshot.id) ?? [];
          if (
            occupiedAssetIds.has(screenshot.id) &&
            (ownerIds.length !== 1 || ownerIds[0] !== importedOwners.get(screenshot.id))
          ) {
            throw new DatabaseError(
              'CONFLICT',
              `Imported image asset ${screenshot.id} conflicts with an existing local asset.`,
            );
          }
        }
      }
      const finalLearningItemIds = new Set(finalItems.map((item) => item.id));
      const tasksToPut = clearMissingTaskLinks(tasks, finalLearningItemIds);
      const completionsToPut =
        mode === 'merge'
          ? taskCompletionsForMerge(existingCompletions, taskCompletions)
          : taskCompletions;
      const skipsToPut =
        mode === 'merge'
          ? mergeTaskSkips(
              (existingSkipValues as unknown[]).map(readTaskSkip),
              taskSkips,
              existingCompletions,
              taskCompletions,
            )
          : taskSkips;

      const receiptStore = transaction.objectStore(STORE_NAMES.intakeReceipts);
      const existingReceipts =
        mode === 'merge' || !options.restoreWallet
          ? ((await requestResult(receiptStore.getAll())) as unknown[]).map(readReceipt)
          : [];
      const existingReceiptById = new Map(existingReceipts.map((receipt) => [receipt.id, receipt]));
      for (const receipt of intakeReceipts) {
        const existing = existingReceiptById.get(receipt.id);
        if (
          existing &&
          (existing.fingerprint !== receipt.fingerprint ||
            existing.targetId !== receipt.targetId ||
            existing.kind !== receipt.kind)
        ) {
          throw new DatabaseError('CONFLICT', '备份中的整理接收记录与本地身份冲突，未导入。');
        }
      }

      if (mode === 'replace') {
        if (!options.restoreWallet) await preserveTaskProvenance(transaction, existingCompletions);
        for (const storeName of Object.values(STORE_NAMES)) {
          if (storeName === STORE_NAMES.wallet || storeName === STORE_NAMES.syncReceipts) continue;
          if (
            !options.restoreWallet &&
            (storeName === STORE_NAMES.taskRevisions ||
              storeName === STORE_NAMES.occurrenceRevisions ||
              storeName === STORE_NAMES.learningReceipts ||
              storeName === STORE_NAMES.reviewSessions ||
              storeName === STORE_NAMES.intakeReceipts)
          )
            continue;
          transaction.objectStore(storeName).clear();
        }
        rotateSyncEpoch(transaction);
        if (options.restoreWallet && importedWallet && importedSync) {
          putWallet(transaction, importedWallet);
          transaction.objectStore(STORE_NAMES.syncReceipts).clear();
          for (const receipt of importedSync.receipts)
            transaction.objectStore(STORE_NAMES.syncReceipts).put(receipt);
          for (const row of importedSync.taskRevisions)
            transaction.objectStore(STORE_NAMES.taskRevisions).put(row);
          for (const row of importedSync.occurrenceRevisions)
            transaction.objectStore(STORE_NAMES.occurrenceRevisions).put(row);
        }
      }

      await mergeReliability(transaction, reliability);
      const reviewStore = transaction.objectStore(STORE_NAMES.reviews);
      const screenshotStore = transaction.objectStore(STORE_NAMES.screenshots);
      if (mode === 'merge') {
        const finalAssetIds =
          finalOwners === null
            ? new Set(finalItems.map(itemAssetId).filter((id): id is string => id !== null))
            : new Set(finalOwners.keys());
        for (const existingItem of existingItems) {
          if (!importedItemIds.has(existingItem.id)) continue;
          const displacedAssetId = itemAssetId(existingItem);
          if (displacedAssetId && !finalAssetIds.has(displacedAssetId)) {
            screenshotStore.delete(displacedAssetId);
          }
        }
      }
      for (const item of items) itemStore.put(item);
      for (const note of notes) transaction.objectStore(STORE_NAMES.notes).put(note);
      // Keep the local reward-attempt state; backup import never pays rewards.
      for (const receipt of intakeReceipts) {
        receiptStore.put(existingReceiptById.get(receipt.id) ?? receipt);
      }
      for (const review of reviews) reviewStore.put(review);
      for (const skip of skipsToPut) transaction.objectStore(STORE_NAMES.taskSkips).put(skip);
      for (const screenshot of screenshots) screenshotStore.put(screenshot);
      for (const record of meta) metaStore.put(record);
      metaStore.put(categoryCatalogRecord(finalCategories, this.clock()));
      for (const task of tasksToPut) {
        taskStore.put(cloneDailyTask(task));
        if (!options.restoreWallet) bumpTaskRevision(transaction, task.id);
      }
      for (const completion of completionsToPut) {
        taskCompletionStore.put(cloneTaskCompletion(completion));
        if (!options.restoreWallet)
          await reviseImportedCompletion(
            transaction,
            completion,
            existingCompletions.some(
              (row) => row.taskId === completion.taskId && row.localDate === completion.localDate,
            ),
          );
      }
      metaStore.put({
        key: 'databaseSchemaVersion',
        value: DATABASE_VERSION,
        updatedAt: this.clock().toISOString(),
      } satisfies PersistedMetaRecord<number>);

      await done;
      return {
        items: items.length,
        reviews: reviews.length,
        screenshots: screenshots.length,
        tasks: tasks.length,
        taskCompletions: taskCompletions.length,
        categories: categories.length,
        notes: notes.length,
        intakeReceipts: intakeReceipts.length,
      };
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw this.transactionError('Could not import local data.', error);
    }
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readonly');
    const done = transactionComplete(transaction);

    try {
      const record = (await requestResult(transaction.objectStore(STORE_NAMES.meta).get(key))) as
        PersistedMetaRecord<T> | undefined;
      await done;
      return record?.value;
    } catch (error) {
      throw this.transactionError('Could not load local metadata.', error);
    }
  }

  async setMeta<T>(key: string, value: T): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(STORE_NAMES.meta, 'readwrite');
    const done = transactionComplete(transaction);
    transaction.objectStore(STORE_NAMES.meta).put({
      key,
      value,
      updatedAt: this.clock().toISOString(),
    } satisfies PersistedMetaRecord<T>);

    try {
      await done;
    } catch (error) {
      throw this.transactionError('Could not save local metadata.', error);
    }
  }

  async clearAll(): Promise<void> {
    await new WalletRepository(this).ensureWallet();
    const database = await this.open();
    const transaction = database.transaction(Object.values(STORE_NAMES), 'readwrite');
    const done = transactionComplete(transaction);
    try {
      const completionValues = (await requestResult(
        transaction.objectStore(STORE_NAMES.taskCompletions).getAll(),
      )) as unknown[];
      const completions = completionValues.map((value, index) =>
        taskCompletionFromUnknown(value, `stored taskCompletions[${index}]`),
      );
      await preserveTaskProvenance(transaction, completions);
      for (const storeName of Object.values(STORE_NAMES)) {
        if (
          [
            STORE_NAMES.learningReceipts,
            STORE_NAMES.reviewSessions,
            STORE_NAMES.intakeReceipts,
          ].includes(storeName as typeof STORE_NAMES.learningReceipts)
        )
          continue;
        if (
          storeName === STORE_NAMES.wallet ||
          storeName === STORE_NAMES.syncReceipts ||
          storeName === STORE_NAMES.taskRevisions ||
          storeName === STORE_NAMES.occurrenceRevisions
        )
          continue;
        transaction.objectStore(storeName).clear();
      }
      rotateSyncEpoch(transaction);
      await done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already closed. */
      }
      await done.catch(() => undefined);
      throw this.transactionError('Could not delete local data.', error);
    }
  }

  clearAllData(): Promise<void> {
    return this.clearAll();
  }

  private transactionError(message: string, cause: unknown): DatabaseError {
    return cause instanceof DatabaseError
      ? cause
      : new DatabaseError('TRANSACTION_FAILED', message, cause);
  }
}
