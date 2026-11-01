import {
  Rating,
  createEmptyCard,
  fsrs,
  type Card,
  type FSRS,
  type FSRSParameters,
  type Grade,
  type RecordLogItem,
  type ReviewLog,
} from 'ts-fsrs';

import { cardFromPersisted, cardToPersisted } from '../database/mappers';
import {
  cardFromReviewSchedulingState,
  reviewSchedulingStateFromCard,
} from '../database/review-state';
import type {
  Clock,
  LearningItem,
  ReviewPersistence,
  ReviewRecord,
  ReviewSchedulingState,
} from '../database/types';
import {
  DEFAULT_SHORT_TERM_REVIEW_MODE,
  parametersForShortTermMode,
  schedulerConfiguration,
  type FsrsSchedulerConfiguration,
  type ShortTermReviewMode,
} from './config';

export const FSRS_RATING_OPTIONS = [
  { label: 'Again', value: Rating.Again },
  { label: 'Hard', value: Rating.Hard },
  { label: 'Good', value: Rating.Good },
  { label: 'Easy', value: Rating.Easy },
] as const;

export type FsrsRatingLabel = (typeof FSRS_RATING_OPTIONS)[number]['label'];
export type FsrsRatingInput = Grade | FsrsRatingLabel | Lowercase<FsrsRatingLabel>;

export interface FsrsServiceOptions {
  repository?: ReviewPersistence;
  clock?: Clock;
  parameters?: Partial<FSRSParameters>;
  shortTermReviewMode?: ShortTermReviewMode;
}

export interface FsrsScheduleResult {
  rating: Grade;
  card: Card;
  log: ReviewLog;
  nextDue: Date;
}

export interface PersistedFsrsReviewResult extends FsrsScheduleResult {
  itemId: string;
  reviewRecord: ReviewRecord;
}

export type FsrsPreview = Record<Grade, FsrsScheduleResult>;

export type FsrsErrorCode =
  | 'INVALID_RATING'
  | 'INVALID_CLOCK'
  | 'PERSISTENCE_REQUIRED'
  | 'ITEM_NOT_FOUND'
  | 'SCHEDULING_FAILED';

export class FsrsError extends Error {
  readonly code: FsrsErrorCode;
  readonly cause?: unknown;

  constructor(code: FsrsErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'FsrsError';
    this.code = code;
    this.cause = cause;
  }
}

const systemClock: Clock = () => new Date();
const grades: readonly Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

function isRepository(value: unknown): value is ReviewPersistence {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'saveReview' in value &&
    typeof value.saveReview === 'function'
  );
}

function cloneCard(card: Card): Card {
  return cardFromPersisted(cardToPersisted(card));
}

function cloneLog(log: ReviewLog): ReviewLog {
  return {
    ...log,
    due: new Date(log.due.getTime()),
    review: new Date(log.review.getTime()),
  };
}

export function toFsrsRating(value: FsrsRatingInput): Grade {
  if (typeof value === 'number') {
    if (grades.includes(value as Grade)) return value as Grade;
  } else {
    const normalized = value.toLocaleLowerCase();
    const match = FSRS_RATING_OPTIONS.find(
      (option) => option.label.toLocaleLowerCase() === normalized,
    );
    if (match) return match.value;
  }

  throw new FsrsError('INVALID_RATING', `Unsupported review rating: ${String(value)}.`);
}

export class FsrsService {
  private readonly repository: ReviewPersistence | undefined;
  private readonly clock: Clock;
  private readonly scheduler: FSRS;
  private readonly shortTermReviewMode: ShortTermReviewMode;

  constructor(options?: FsrsServiceOptions);
  constructor(repository?: ReviewPersistence, options?: Omit<FsrsServiceOptions, 'repository'>);
  constructor(
    repositoryOrOptions: ReviewPersistence | FsrsServiceOptions = {},
    options: Omit<FsrsServiceOptions, 'repository'> = {},
  ) {
    const resolvedOptions = isRepository(repositoryOrOptions)
      ? { ...options, repository: repositoryOrOptions }
      : repositoryOrOptions;

    this.repository = resolvedOptions.repository;
    this.clock = resolvedOptions.clock ?? systemClock;
    this.shortTermReviewMode =
      resolvedOptions.shortTermReviewMode ?? DEFAULT_SHORT_TERM_REVIEW_MODE;
    this.scheduler = fsrs(
      resolvedOptions.parameters ?? parametersForShortTermMode(this.shortTermReviewMode),
    );
  }

  getConfiguration(): FsrsSchedulerConfiguration {
    return schedulerConfiguration(this.shortTermReviewMode, this.scheduler.parameters);
  }

  createInitialCard(at: Date = this.now()): Card {
    return cloneCard(createEmptyCard(this.validDate(at, 'initial card date')));
  }

  isDue(cardOrItem: Card | LearningItem, at: Date = this.now()): boolean {
    if ('suspended' in cardOrItem && cardOrItem.suspended) return false;
    const card = 'fsrsCard' in cardOrItem ? cardOrItem.fsrsCard : cardOrItem;
    return card.due.getTime() <= this.validDate(at, 'due date').getTime();
  }

  preview(card: Card, reviewedAt: Date = this.now()): FsrsPreview {
    const now = this.validDate(reviewedAt, 'review date');

    try {
      const preview = this.scheduler.repeat(cloneCard(card), now);
      const entries = grades.map((grade) => [grade, this.toScheduleResult(grade, preview[grade])]);
      return Object.fromEntries(entries) as FsrsPreview;
    } catch (error) {
      if (error instanceof FsrsError) throw error;
      throw new FsrsError(
        'SCHEDULING_FAILED',
        'FSRS could not preview the next review dates.',
        error,
      );
    }
  }

  schedule(card: Card, rating: FsrsRatingInput, reviewedAt: Date = this.now()): FsrsScheduleResult {
    const grade = toFsrsRating(rating);
    const now = this.validDate(reviewedAt, 'review date');

    try {
      return this.toScheduleResult(grade, this.scheduler.next(cloneCard(card), now, grade));
    } catch (error) {
      if (error instanceof FsrsError) throw error;
      throw new FsrsError('SCHEDULING_FAILED', 'FSRS could not schedule this review.', error);
    }
  }

  async reviewItem(
    itemId: string,
    rating: FsrsRatingInput,
    reviewedAt?: Date,
    expectedState?: ReviewSchedulingState,
  ): Promise<PersistedFsrsReviewResult> {
    if (!this.repository) {
      throw new FsrsError('PERSISTENCE_REQUIRED', 'reviewItem requires a ValRecall repository.');
    }

    const item = await this.repository.getItem(itemId);
    if (!item) {
      throw new FsrsError('ITEM_NOT_FOUND', `Learning item ${itemId} was not found.`);
    }

    const capturedState = expectedState ?? reviewSchedulingStateFromCard(item.fsrsCard);
    const result = this.schedule(
      cardFromReviewSchedulingState(capturedState),
      rating,
      reviewedAt ?? this.now(),
    );
    const reviewRecord = await this.repository.saveReview({
      itemId,
      expectedState: capturedState,
      card: result.card,
      log: result.log,
    });

    return {
      ...result,
      itemId,
      reviewRecord,
    };
  }

  rateItem(
    itemId: string,
    rating: FsrsRatingInput,
    reviewedAt?: Date,
    expectedState?: ReviewSchedulingState,
  ): Promise<PersistedFsrsReviewResult> {
    return this.reviewItem(itemId, rating, reviewedAt, expectedState);
  }

  private now(): Date {
    return this.validDate(this.clock(), 'clock value');
  }

  private validDate(value: Date, label: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new FsrsError('INVALID_CLOCK', `${label} must be a valid Date.`);
    }

    return new Date(value.getTime());
  }

  private toScheduleResult(grade: Grade, result: RecordLogItem): FsrsScheduleResult {
    const card = cloneCard(result.card);
    return {
      rating: grade,
      card,
      log: cloneLog(result.log),
      nextDue: new Date(card.due.getTime()),
    };
  }
}
