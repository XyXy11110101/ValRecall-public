import type { Card, ReviewLog, State, Rating } from 'ts-fsrs';

import { LEARNING_ITEM_TYPES, type LearningItemType } from '../models/learning-item';
import type { ExtractionDiagnostic, SubtitleCueData } from '../models/extraction';
import { isReadingSource } from '../models/reading';
import { isNoteSource, noteContent } from '../models/note';
import { isVideoPlatform, type VideoPlatform } from '../models/platform';
import { hasConsistentVideoIdentity, isSupportedVideoUrl } from '../shared/video-url';
import { DatabaseError } from './errors';
import {
  LEARNING_ITEM_SCHEMA_VERSION,
  type ImageLearningItem,
  type PersistedCard,
  type PersistedImageLearningItem,
  type PersistedLearningItem,
  type PersistedTextLearningItem,
  type PersistedVideoLearningItem,
  type PersistedReviewLog,
  type PersistedReviewRecord,
  type LearningItem,
  type ReviewRecord,
  type TextLearningItem,
  type VideoLearningItem,
} from './types';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseError('INVALID_DATA', `${label} must be a non-empty string.`);
  }

  return value;
}

function text(value: unknown, label: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string') {
    throw new DatabaseError('INVALID_DATA', `${label} must be text.`);
  }

  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label);
}

function textArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new DatabaseError('INVALID_DATA', `${label} must be an array of text values.`);
  }

  return [...value] as string[];
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new DatabaseError('INVALID_DATA', `${label} must be true or false.`);
  }

  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return finiteNumber(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DatabaseError('INVALID_DATA', `${label} must be a positive integer.`);
  }
  return parsed;
}

function imageMimeType(value: unknown): ImageLearningItem['imageMimeType'] {
  if (value !== 'image/jpeg' && value !== 'image/png' && value !== 'image/webp') {
    throw new DatabaseError('INVALID_DATA', 'item.imageMimeType is not supported.');
  }
  return value;
}

function assertManualVideoTimestampPair(
  timestampSeconds: number | null,
  timestampDisplay: string | null,
): void {
  if (
    (timestampSeconds === null) !== (timestampDisplay === null) ||
    (timestampDisplay !== null && timestampDisplay.trim().length === 0)
  ) {
    throw new DatabaseError(
      'INVALID_DATA',
      'A Library Video timestamp and its display value must either both be present or both be absent.',
    );
  }
}

function itemType(value: unknown): LearningItemType {
  if (!LEARNING_ITEM_TYPES.includes(value as LearningItemType)) {
    throw new DatabaseError('INVALID_DATA', 'item.itemType is not supported.');
  }

  return value as LearningItemType;
}

function subtitleCues(value: unknown): SubtitleCueData[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DatabaseError('INVALID_DATA', 'item.subtitleCueData must be an array.');
  }

  return value.map((entry, index) => {
    const cue = asRecord(entry, `item.subtitleCueData[${index}]`);
    const source = cue.source;
    if (source !== 'text-track' && source !== 'dom-transcript' && source !== 'visible-overlay') {
      throw new DatabaseError(
        'INVALID_DATA',
        `item.subtitleCueData[${index}].source is not supported.`,
      );
    }

    return {
      startTime: nullableNumber(cue.startTime, `item.subtitleCueData[${index}].startTime`),
      endTime: nullableNumber(cue.endTime, `item.subtitleCueData[${index}].endTime`),
      text: text(cue.text, `item.subtitleCueData[${index}].text`),
      source,
    };
  });
}

function diagnostics(value: unknown): ExtractionDiagnostic[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DatabaseError('INVALID_DATA', 'item.extractionDiagnostics must be an array.');
  }

  return value.map((entry, index) => {
    const diagnostic = asRecord(entry, `item.extractionDiagnostics[${index}]`);
    const status = diagnostic.status;
    const severity = diagnostic.severity;
    if (status !== 'success' && status !== 'failed' && status !== 'skipped') {
      throw new DatabaseError(
        'INVALID_DATA',
        `item.extractionDiagnostics[${index}].status is not supported.`,
      );
    }
    if (severity !== 'info' && severity !== 'warning' && severity !== 'error') {
      throw new DatabaseError(
        'INVALID_DATA',
        `item.extractionDiagnostics[${index}].severity is not supported.`,
      );
    }

    return {
      field: text(diagnostic.field, `item.extractionDiagnostics[${index}].field`),
      strategy: text(diagnostic.strategy, `item.extractionDiagnostics[${index}].strategy`),
      status,
      severity,
      message: text(diagnostic.message, `item.extractionDiagnostics[${index}].message`),
    };
  });
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be a finite number.`);
  }

  return value;
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isInteger(result)) {
    throw new DatabaseError('INVALID_DATA', `${label} must be an integer.`);
  }

  return result;
}

function toDate(value: unknown, label: string): Date {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : new Date(Number.NaN);

  if (Number.isNaN(date.getTime())) {
    throw new DatabaseError('INVALID_DATA', `${label} is not a valid date.`);
  }

  return date;
}

function toIso(value: unknown, label: string): string {
  return toDate(value, label).toISOString();
}

function state(value: unknown, label: string): State {
  const result = integer(value, label);
  if (result < 0 || result > 3) {
    throw new DatabaseError('INVALID_DATA', `${label} is not a valid FSRS state.`);
  }

  return result as State;
}

function rating(value: unknown, label: string): Rating {
  const result = integer(value, label);
  if (result < 1 || result > 4) {
    throw new DatabaseError('INVALID_DATA', `${label} is not a valid FSRS rating.`);
  }

  return result as Rating;
}

export function cardToPersisted(card: Card): PersistedCard {
  return {
    due: toIso(card.due, 'card.due'),
    stability: finiteNumber(card.stability, 'card.stability'),
    difficulty: finiteNumber(card.difficulty, 'card.difficulty'),
    elapsed_days: finiteNumber(card.elapsed_days, 'card.elapsed_days'),
    scheduled_days: finiteNumber(card.scheduled_days, 'card.scheduled_days'),
    learning_steps: finiteNumber(card.learning_steps, 'card.learning_steps'),
    reps: integer(card.reps, 'card.reps'),
    lapses: integer(card.lapses, 'card.lapses'),
    state: state(card.state, 'card.state'),
    ...(card.last_review ? { last_review: toIso(card.last_review, 'card.last_review') } : {}),
  };
}

export function cardFromPersisted(value: unknown): Card {
  const card = asRecord(value, 'FSRS card');
  return {
    due: toDate(card.due, 'card.due'),
    stability: finiteNumber(card.stability, 'card.stability'),
    difficulty: finiteNumber(card.difficulty, 'card.difficulty'),
    elapsed_days: finiteNumber(card.elapsed_days, 'card.elapsed_days'),
    scheduled_days: finiteNumber(card.scheduled_days, 'card.scheduled_days'),
    learning_steps: finiteNumber(card.learning_steps, 'card.learning_steps'),
    reps: integer(card.reps, 'card.reps'),
    lapses: integer(card.lapses, 'card.lapses'),
    state: state(card.state, 'card.state'),
    ...(card.last_review === undefined || card.last_review === null
      ? {}
      : { last_review: toDate(card.last_review, 'card.last_review') }),
  };
}

export function reviewLogToPersisted(log: ReviewLog): PersistedReviewLog {
  return {
    rating: rating(log.rating, 'review.rating'),
    state: state(log.state, 'review.state'),
    due: toIso(log.due, 'review.due'),
    stability: finiteNumber(log.stability, 'review.stability'),
    difficulty: finiteNumber(log.difficulty, 'review.difficulty'),
    elapsed_days: finiteNumber(log.elapsed_days, 'review.elapsed_days'),
    last_elapsed_days: finiteNumber(log.last_elapsed_days, 'review.last_elapsed_days'),
    scheduled_days: finiteNumber(log.scheduled_days, 'review.scheduled_days'),
    learning_steps: finiteNumber(log.learning_steps, 'review.learning_steps'),
    review: toIso(log.review, 'review.review'),
  };
}

export function reviewLogFromPersisted(value: unknown): ReviewLog {
  const log = asRecord(value, 'FSRS review log');
  return {
    rating: rating(log.rating, 'review.rating'),
    state: state(log.state, 'review.state'),
    due: toDate(log.due, 'review.due'),
    stability: finiteNumber(log.stability, 'review.stability'),
    difficulty: finiteNumber(log.difficulty, 'review.difficulty'),
    elapsed_days: finiteNumber(log.elapsed_days, 'review.elapsed_days'),
    last_elapsed_days: finiteNumber(log.last_elapsed_days, 'review.last_elapsed_days'),
    scheduled_days: finiteNumber(log.scheduled_days, 'review.scheduled_days'),
    learning_steps: finiteNumber(log.learning_steps, 'review.learning_steps'),
    review: toDate(log.review, 'review.review'),
  };
}

export function reviewRecordToPersisted(record: ReviewRecord): PersistedReviewRecord {
  return {
    id: requiredString(record.id, 'review record id'),
    itemId: requiredString(record.itemId, 'review item id'),
    reviewedAt: toIso(record.reviewedAt, 'reviewedAt'),
    log: reviewLogToPersisted(record.log),
  };
}

export function reviewRecordFromPersisted(value: unknown): ReviewRecord {
  const record = asRecord(value, 'review record');
  return {
    id: requiredString(record.id, 'review record id'),
    itemId: requiredString(record.itemId, 'review item id'),
    reviewedAt: toDate(record.reviewedAt, 'reviewedAt'),
    log: reviewLogFromPersisted(record.log),
  };
}

export function itemToPersisted(item: VideoLearningItem): PersistedVideoLearningItem;
export function itemToPersisted(item: TextLearningItem): PersistedTextLearningItem;
export function itemToPersisted(item: ImageLearningItem): PersistedImageLearningItem;
export function itemToPersisted(item: LearningItem): PersistedLearningItem;
export function itemToPersisted(item: LearningItem): PersistedLearningItem {
  if (item.sourceType !== 'text' && item.sourceType !== 'image' && item.videoOrigin === 'library') {
    assertManualVideoTimestampPair(item.timestampSeconds, item.timestampDisplay);
  }
  const { createdAt, updatedAt, fsrsCard, reviewHistory: _reviewHistory, ...rest } = item;
  void _reviewHistory;
  return {
    ...rest,
    sourceType:
      item.sourceType === 'text' ? 'text' : item.sourceType === 'image' ? 'image' : 'video',
    ...(item.sourceType !== 'text' && item.sourceType !== 'image'
      ? { videoOrigin: item.videoOrigin ?? 'capture' }
      : {}),
    schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
    createdAt: toIso(createdAt, 'item.createdAt'),
    updatedAt: toIso(updatedAt, 'item.updatedAt'),
    fsrsCard: cardToPersisted(fsrsCard),
  } as PersistedLearningItem;
}

export function migratePersistedItem(value: unknown): PersistedLearningItem {
  const item = asRecord(value, 'learning item');
  const schemaVersion = item.schemaVersion ?? 0;

  if (
    schemaVersion !== 0 &&
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3 &&
    schemaVersion !== LEARNING_ITEM_SCHEMA_VERSION
  ) {
    throw new DatabaseError(
      'INVALID_DATA',
      `Unsupported learning item schema version: ${String(schemaVersion)}.`,
    );
  }

  const fsrsCard = cardToPersisted(cardFromPersisted(item.fsrsCard));
  const createdAt = toIso(item.createdAt, 'item.createdAt');
  const updatedAt = toIso(item.updatedAt ?? item.createdAt, 'item.updatedAt');

  const common = {
    id: requiredString(item.id, 'item.id'),
    schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
    categoryId: nullableId(item.categoryId, 'item.categoryId'),
    itemType: itemType(item.itemType),
    personalNote: text(item.personalNote, 'item.personalNote', ''),
    situation: text(item.situation, 'item.situation', ''),
    coreLesson: text(item.coreLesson, 'item.coreLesson', ''),
    mistakeToAvoid: text(item.mistakeToAvoid, 'item.mistakeToAvoid', ''),
    recommendedAction: text(item.recommendedAction, 'item.recommendedAction', ''),
    reason: text(item.reason, 'item.reason', ''),
    recallPrompt: text(item.recallPrompt, 'item.recallPrompt', ''),
    referenceAnswer: text(item.referenceAnswer, 'item.referenceAnswer', ''),
    tags: textArray(item.tags, 'item.tags'),
    createdAt,
    updatedAt,
    fsrsCard,
    suspended: booleanValue(item.suspended, 'item.suspended', false),
    extractionDiagnostics: diagnostics(item.extractionDiagnostics),
  };

  if (
    item.readingSource !== undefined &&
    (item.sourceType !== 'text' || !isReadingSource(item.readingSource))
  ) {
    throw new DatabaseError('INVALID_DATA', '阅读来源格式无效，原文不能为空。');
  }

  if (
    item.noteSource !== undefined &&
    (schemaVersion < 4 || item.sourceType !== 'text' || !isNoteSource(item.noteSource))
  ) {
    throw new DatabaseError('INVALID_DATA', '笔记来源快照格式无效。');
  }
  if (schemaVersion >= 2 && item.sourceType === 'text') {
    return {
      ...common,
      sourceType: 'text',
      title: text(item.title, 'item.title'),
      ...(isReadingSource(item.readingSource) ? { readingSource: { ...item.readingSource } } : {}),
      ...(isNoteSource(item.noteSource)
        ? {
            noteSource: {
              ...noteContent(item.noteSource),
              schemaVersion: 1 as const,
              noteId: item.noteSource.noteId,
            },
          }
        : {}),
    };
  }
  if (schemaVersion >= 2 && item.sourceType === 'image') {
    return {
      ...common,
      sourceType: 'image',
      title: text(item.title, 'item.title'),
      imageAssetId: requiredString(item.imageAssetId, 'item.imageAssetId'),
      imageMimeType: imageMimeType(item.imageMimeType),
      imageWidth: positiveInteger(item.imageWidth, 'item.imageWidth'),
      imageHeight: positiveInteger(item.imageHeight, 'item.imageHeight'),
    };
  }
  if (schemaVersion >= 2 && item.sourceType !== undefined && item.sourceType !== 'video') {
    throw new DatabaseError('INVALID_DATA', 'item.sourceType must be video, text, or image.');
  }

  const platform = migratePlatform(item.platform, schemaVersion);
  const sourceUrl = requiredString(item.sourceUrl, 'item.sourceUrl');
  const canonicalUrl = nullableText(item.canonicalUrl, 'item.canonicalUrl');
  const videoId = nullableText(item.videoId, 'item.videoId');
  if (schemaVersion >= 2) {
    if (!isSupportedVideoUrl(sourceUrl, platform)) {
      throw new DatabaseError(
        'INVALID_DATA',
        `item.sourceUrl is not a supported ${platform} video URL.`,
      );
    }
    if (canonicalUrl !== null && !isSupportedVideoUrl(canonicalUrl, platform)) {
      throw new DatabaseError(
        'INVALID_DATA',
        `item.canonicalUrl is not a supported ${platform} video URL.`,
      );
    }
    if (!hasConsistentVideoIdentity(platform, sourceUrl, canonicalUrl, videoId)) {
      throw new DatabaseError(
        'INVALID_DATA',
        'item sourceUrl, canonicalUrl, and videoId must identify the same video.',
      );
    }
  }
  if (
    schemaVersion >= 2 &&
    item.videoOrigin !== undefined &&
    item.videoOrigin !== 'capture' &&
    item.videoOrigin !== 'library'
  ) {
    throw new DatabaseError('INVALID_DATA', 'item.videoOrigin must be capture or library.');
  }
  const videoOrigin = schemaVersion >= 2 && item.videoOrigin === 'library' ? 'library' : 'capture';
  const timestampSeconds =
    videoOrigin === 'library'
      ? nullableNumber(item.timestampSeconds, 'item.timestampSeconds')
      : finiteNumber(item.timestampSeconds, 'item.timestampSeconds');
  if (timestampSeconds !== null && timestampSeconds < 0) {
    throw new DatabaseError('INVALID_DATA', 'item.timestampSeconds cannot be negative.');
  }
  const timestampDisplay =
    videoOrigin === 'library'
      ? nullableText(item.timestampDisplay, 'item.timestampDisplay')
      : text(item.timestampDisplay, 'item.timestampDisplay');
  if (videoOrigin === 'library') {
    assertManualVideoTimestampPair(timestampSeconds, timestampDisplay);
  }

  return {
    ...common,
    sourceType: 'video',
    videoOrigin,
    platform,
    sourceUrl,
    canonicalUrl,
    videoId,
    videoTitle: text(item.videoTitle, 'item.videoTitle'),
    uploader: nullableText(item.uploader, 'item.uploader'),
    description: nullableText(item.description, 'item.description'),
    timestampSeconds,
    timestampDisplay,
    videoDurationSeconds: nullableNumber(item.videoDurationSeconds, 'item.videoDurationSeconds'),
    chapterTitle: nullableText(item.chapterTitle, 'item.chapterTitle'),
    screenshotId: nullableText(item.screenshotId, 'item.screenshotId'),
    subtitleBefore: textArray(item.subtitleBefore, 'item.subtitleBefore'),
    subtitleCurrent: textArray(item.subtitleCurrent, 'item.subtitleCurrent'),
    subtitleAfter: textArray(item.subtitleAfter, 'item.subtitleAfter'),
    subtitleCueData: subtitleCues(item.subtitleCueData),
  };
}

function migratePlatform(value: unknown, schemaVersion: unknown): VideoPlatform {
  if (schemaVersion === 0 || schemaVersion === 1) {
    if (value !== undefined && value !== 'bilibili') {
      throw new DatabaseError(
        'INVALID_DATA',
        `Learning item schema ${String(schemaVersion)} only supports Bilibili.`,
      );
    }
    return 'bilibili';
  }

  if (!isVideoPlatform(value)) {
    throw new DatabaseError('INVALID_DATA', 'item.platform is not supported.');
  }
  return value;
}

export function itemFromPersisted(
  value: unknown,
  reviewHistory: ReviewRecord[] = [],
): LearningItem {
  const item = migratePersistedItem(value);
  return {
    ...item,
    createdAt: toDate(item.createdAt, 'item.createdAt'),
    updatedAt: toDate(item.updatedAt, 'item.updatedAt'),
    fsrsCard: cardFromPersisted(item.fsrsCard),
    reviewHistory: [...reviewHistory].sort(
      (left, right) => left.reviewedAt.getTime() - right.reviewedAt.getTime(),
    ),
  };
}
