import { ValRecallRepository } from '../database';
import { FsrsService, type FsrsSchedulerConfiguration, type ShortTermReviewMode } from '../fsrs';
import type { Card, Rating, ReviewLog } from 'ts-fsrs';

export const repository = new ValRecallRepository();
const fsrsServices = new Map<ShortTermReviewMode, FsrsService>();

export function fsrsServiceForMode(mode: ShortTermReviewMode): FsrsService {
  const existing = fsrsServices.get(mode);
  if (existing) return existing;
  const service = new FsrsService(repository, { shortTermReviewMode: mode });
  fsrsServices.set(mode, service);
  return service;
}

export interface SchedulingDiagnostic {
  itemId: string;
  card: Card;
  latestRating: Rating;
  latestLog: ReviewLog;
  configuration: FsrsSchedulerConfiguration;
}

export async function loadMostRecentSchedulingDiagnostic(
  mode: ShortTermReviewMode,
): Promise<SchedulingDiagnostic | null> {
  const items = await repository.listItems();
  const candidates = items
    .flatMap((item) =>
      item.reviewHistory.map((review) => ({
        item,
        review,
      })),
    )
    .sort((left, right) => right.review.reviewedAt.getTime() - left.review.reviewedAt.getTime());
  const mostRecent = candidates[0];
  if (!mostRecent) return null;
  return {
    itemId: mostRecent.item.id,
    card: mostRecent.item.fsrsCard,
    latestRating: mostRecent.review.log.rating,
    latestLog: mostRecent.review.log,
    configuration: fsrsServiceForMode(mode).getConfiguration(),
  };
}
