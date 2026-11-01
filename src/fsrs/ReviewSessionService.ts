import type { LearningItem } from '../database';
import { reviewSchedulingStateFromCard } from '../database/review-state';
import {
  ReviewSessionRepository,
  persistedStepResult,
  type ReviewSessionSeed,
} from '../database/review-sessions';
import type { DatabaseOpener } from '../database/wallet';
import { FsrsService, type FsrsRatingInput, type PersistedFsrsReviewResult } from './FsrsService';

/** Coordinates durable session writes while all schedule calculation stays in FsrsService. */
export class ReviewSessionService {
  readonly sessions: ReviewSessionRepository;
  constructor(database: DatabaseOpener) {
    this.sessions = new ReviewSessionRepository(database);
  }
  async rate(
    seed: ReviewSessionSeed,
    item: LearningItem,
    rating: FsrsRatingInput,
    reviewedAt: Date,
    scheduler: FsrsService,
    committedAt: Date,
  ) {
    const expectedState = reviewSchedulingStateFromCard(item.fsrsCard);
    const calculated = scheduler.schedule(item.fsrsCard, rating, reviewedAt);
    const session = await this.sessions.commit(
      seed,
      {
        kind: 'rated',
        review: { itemId: item.id, expectedState, card: calculated.card, log: calculated.log },
      },
      committedAt,
    );
    const stored = persistedStepResult(session, item.id);
    const result: PersistedFsrsReviewResult = {
      itemId: item.id,
      card: stored.card,
      log: stored.review.log,
      nextDue: new Date(stored.card.due),
      rating: stored.review.log.rating as typeof calculated.rating,
      reviewRecord: stored.review,
    };
    return { result, session, rewardAmount: stored.rewardAmount };
  }
  async finishItem(
    seed: ReviewSessionSeed,
    item: LearningItem,
    kind: 'mastered' | 'unavailable',
    at: Date,
  ) {
    return this.sessions.commit(
      seed,
      { kind, itemId: item.id, expectedState: reviewSchedulingStateFromCard(item.fsrsCard) },
      at,
    );
  }
}
