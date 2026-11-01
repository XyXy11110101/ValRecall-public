import type { ReliabilityBackup } from './reliability-backup';
import type { Card, Rating, ReviewLog, State } from 'ts-fsrs';

import {
  LEARNING_ITEM_SCHEMA_VERSION as CURRENT_LEARNING_ITEM_SCHEMA_VERSION,
  type LearningItemType,
} from '../models/learning-item';
import type { ExtractionDiagnostic, SubtitleCueData } from '../models/extraction';
import type { ReadingSource } from '../models/reading';
import type { NoteRecord, NoteSource } from '../models/note';
import type { IntakeReceipt } from './intake-types';
import type { VideoPlatform } from '../models/platform';
import type { DailyTask, TaskCompletion, TaskSkip } from '../models/daily-task';
import type { CategorySummary, MomentCategory, PersistedMomentCategory } from '../models/category';
import type { AllowanceState } from '../shared/allowance';
import type { SyncBackup } from './sync-backup';

export type {
  DailyTask,
  DailyTaskKind,
  DailyTaskUpdate,
  ListTasksOptions,
  NewDailyTask,
  PracticeTask,
  TaskCompletion,
  TaskDaySummary,
  TaskImportResult,
  TaskOccurrence,
  TaskPriority,
  TaskRecurrence,
  ValRecallTaskExport,
} from '../models/daily-task';
export type { LearningItemType, SubtitleCueData, VideoPlatform };
export type { CategorySummary, MomentCategory, PersistedMomentCategory };

export interface TaskCompletionResult {
  completion: TaskCompletion;
  created: boolean;
}

export const LEARNING_ITEM_SCHEMA_VERSION = CURRENT_LEARNING_ITEM_SCHEMA_VERSION;
export const EXPORT_SCHEMA_VERSION = 11 as const;

export type MomentSourceType = 'text' | 'image' | 'video';
export type VideoMomentOrigin = 'capture' | 'library';

interface LearningItemBase {
  id: string;
  schemaVersion: 2 | 3 | typeof LEARNING_ITEM_SCHEMA_VERSION;
  categoryId: string | null;
  itemType: LearningItemType;
  /** @deprecated Read/write only for legacy import/export and explicit Library resolution. */
  personalNote: string;
  situation: string;
  coreLesson: string;
  mistakeToAvoid: string;
  recommendedAction: string;
  reason: string;
  recallPrompt: string;
  referenceAnswer: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  fsrsCard: Card;
  reviewHistory: ReviewRecord[];
  suspended: boolean;
  extractionDiagnostics: ExtractionDiagnostic[];
}

export interface VideoLearningItem extends LearningItemBase {
  /** Missing only on legacy in-memory fixtures; persisted records are normalised to `video`. */
  sourceType?: 'video';
  /** Missing only on legacy in-memory fixtures and records, where `capture` is inferred. */
  videoOrigin?: VideoMomentOrigin;
  platform: VideoPlatform;
  sourceUrl: string;
  canonicalUrl: string | null;
  videoId: string | null;
  videoTitle: string;
  uploader: string | null;
  description: string | null;
  timestampSeconds: number | null;
  timestampDisplay: string | null;
  videoDurationSeconds: number | null;
  chapterTitle: string | null;
  screenshotId: string | null;
  subtitleBefore: string[];
  subtitleCurrent: string[];
  subtitleAfter: string[];
  subtitleCueData: SubtitleCueData[];
}

export interface TextLearningItem extends LearningItemBase {
  schemaVersion: 2 | 3 | typeof LEARNING_ITEM_SCHEMA_VERSION;
  sourceType: 'text';
  title: string;
  readingSource?: ReadingSource;
  noteSource?: NoteSource;
}

export interface ImageLearningItem extends LearningItemBase {
  schemaVersion: 2 | 3 | typeof LEARNING_ITEM_SCHEMA_VERSION;
  sourceType: 'image';
  title: string;
  imageAssetId: string;
  imageMimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  imageWidth: number;
  imageHeight: number;
}

export type LearningItem = VideoLearningItem | TextLearningItem | ImageLearningItem;
export type LearningItemSource = VideoPlatform | 'text' | 'image';

export function isTextLearningItem(item: LearningItem): item is TextLearningItem {
  return item.sourceType === 'text';
}

export function isImageLearningItem(item: LearningItem): item is ImageLearningItem {
  return item.sourceType === 'image';
}

export function isVideoLearningItem(item: LearningItem): item is VideoLearningItem {
  return item.sourceType !== 'text' && item.sourceType !== 'image';
}

export function learningItemTitle(item: LearningItem): string {
  return isVideoLearningItem(item) ? item.videoTitle : item.title;
}

export function learningItemSource(item: LearningItem): LearningItemSource {
  if (isTextLearningItem(item)) return 'text';
  if (isImageLearningItem(item)) return 'image';
  return item.platform;
}

export type NewVideoLearningItem = Pick<
  VideoLearningItem,
  | 'platform'
  | 'sourceUrl'
  | 'videoTitle'
  | 'timestampSeconds'
  | 'timestampDisplay'
  | 'itemType'
  | 'coreLesson'
  | 'recallPrompt'
  | 'referenceAnswer'
  | 'fsrsCard'
> &
  Partial<
    Omit<
      VideoLearningItem,
      | 'platform'
      | 'sourceUrl'
      | 'videoTitle'
      | 'timestampSeconds'
      | 'timestampDisplay'
      | 'itemType'
      | 'coreLesson'
      | 'recallPrompt'
      | 'referenceAnswer'
      | 'fsrsCard'
      | 'reviewHistory'
    >
  >;

export type NewTextLearningItem = Pick<
  TextLearningItem,
  'title' | 'itemType' | 'coreLesson' | 'recallPrompt' | 'referenceAnswer' | 'fsrsCard'
> &
  Partial<
    Omit<
      TextLearningItem,
      | 'sourceType'
      | 'title'
      | 'itemType'
      | 'coreLesson'
      | 'recallPrompt'
      | 'referenceAnswer'
      | 'fsrsCard'
      | 'reviewHistory'
    >
  >;

export type NewImageLearningItem = Pick<
  ImageLearningItem,
  'title' | 'itemType' | 'coreLesson' | 'recallPrompt' | 'referenceAnswer' | 'fsrsCard'
> &
  Partial<
    Omit<
      ImageLearningItem,
      | 'sourceType'
      | 'title'
      | 'imageAssetId'
      | 'imageMimeType'
      | 'imageWidth'
      | 'imageHeight'
      | 'itemType'
      | 'coreLesson'
      | 'recallPrompt'
      | 'referenceAnswer'
      | 'fsrsCard'
      | 'reviewHistory'
    >
  >;

export interface NewImageAsset {
  blob: Blob;
  width: number;
  height: number;
}

export type LearningItemUpdate = Partial<
  Omit<LearningItemBase, 'id' | 'schemaVersion' | 'createdAt' | 'reviewHistory'> & {
    title: string;
    videoTitle: string;
    readingSource: ReadingSource;
  }
>;

export interface PersistedCard {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: string;
}

export interface PersistedReviewLog {
  rating: Rating;
  state: State;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  review: string;
}

export interface PersistedVideoLearningItem extends Omit<
  VideoLearningItem,
  | 'sourceType'
  | 'videoOrigin'
  | 'schemaVersion'
  | 'createdAt'
  | 'updatedAt'
  | 'fsrsCard'
  | 'reviewHistory'
> {
  schemaVersion: typeof LEARNING_ITEM_SCHEMA_VERSION;
  sourceType: 'video';
  videoOrigin: VideoMomentOrigin;
  createdAt: string;
  updatedAt: string;
  fsrsCard: PersistedCard;
}

export interface PersistedTextLearningItem extends Omit<
  TextLearningItem,
  'schemaVersion' | 'createdAt' | 'updatedAt' | 'fsrsCard' | 'reviewHistory'
> {
  schemaVersion: typeof LEARNING_ITEM_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  fsrsCard: PersistedCard;
}

export interface PersistedImageLearningItem extends Omit<
  ImageLearningItem,
  'schemaVersion' | 'createdAt' | 'updatedAt' | 'fsrsCard' | 'reviewHistory'
> {
  schemaVersion: typeof LEARNING_ITEM_SCHEMA_VERSION;
  createdAt: string;
  updatedAt: string;
  fsrsCard: PersistedCard;
}

export type PersistedLearningItem =
  PersistedVideoLearningItem | PersistedTextLearningItem | PersistedImageLearningItem;

export interface ReviewRecord {
  id: string;
  itemId: string;
  reviewedAt: Date;
  log: ReviewLog;
}

export interface PersistedReviewRecord {
  id: string;
  itemId: string;
  reviewedAt: string;
  log: PersistedReviewLog;
}

export interface ScreenshotRecord {
  id: string;
  blob: Blob;
  createdAt: string;
}

export interface PersistedMetaRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: string;
}

export interface ExportedScreenshot {
  id: string;
  mimeType: string;
  createdAt: string;
  dataBase64: string;
}

export interface ValRecallExport extends Partial<ReliabilityBackup> {
  application: 'ValRecall';
  schemaVersion: number;
  exportedAt: string;
  items: PersistedLearningItem[];
  reviews: PersistedReviewRecord[];
  screenshots: ExportedScreenshot[];
  meta: PersistedMetaRecord[];
  categories: PersistedMomentCategory[];
  tasks: DailyTask[];
  taskCompletions: TaskCompletion[];
  taskSkips?: TaskSkip[];
  notes: NoteRecord[];
  intakeReceipts: IntakeReceipt[];
  wallet?: AllowanceState;
  sync?: SyncBackup;
}

export interface ImportResult {
  items: number;
  reviews: number;
  screenshots: number;
  tasks: number;
  taskCompletions: number;
  categories: number;
  notes: number;
  intakeReceipts: number;
}

export type ImportMode = 'merge' | 'replace';

export interface ListItemsOptions {
  /** Defaults to true; operational lists can omit unused review-history reads. */
  includeReviewHistory?: boolean;
  query?: string;
  itemType?: LearningItemType;
  platform?: VideoPlatform;
  source?: LearningItemSource;
  status?: 'all' | 'due' | 'future' | 'suspended';
  categoryId?: string | null;
  now?: Date;
}

export interface UpcomingReviewCursor {
  due: string;
  itemId: string;
}

export interface ListUpcomingReviewItemsOptions {
  after: Date;
  before?: Date;
  limit: number;
  cursor?: UpcomingReviewCursor;
}

export interface UpcomingReviewItemsPage {
  items: LearningItem[];
  nextCursor: UpcomingReviewCursor | null;
  hasMore: boolean;
  invalidCount: number;
}

export interface SaveReviewInput {
  id?: string;
  itemId: string;
  expectedState: ReviewSchedulingState;
  card: Card;
  log: ReviewLog;
}

export type ReviewDateValue = Date | string | number;

/** Scheduling-only compare-and-swap token captured from the fixed Review session. */
export interface ReviewSchedulingState {
  due: ReviewDateValue;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: ReviewDateValue;
}

export interface ReviewPersistence {
  getItem(id: string): Promise<LearningItem | undefined>;
  saveReview(input: SaveReviewInput): Promise<ReviewRecord>;
}

export type Clock = () => Date;

export type IdGenerator = () => string;
