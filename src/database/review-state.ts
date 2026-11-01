import type { Card } from 'ts-fsrs';

import { DatabaseError } from './errors';
import { cardFromPersisted, cardToPersisted } from './mappers';
import type { ReviewDateValue, ReviewSchedulingState } from './types';

export function reviewDateEpochMilliseconds(value: ReviewDateValue, label = 'review due'): number {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : new Date(Number.NaN);
  const epochMilliseconds = date.getTime();
  if (!Number.isFinite(epochMilliseconds)) {
    throw new DatabaseError('INVALID_DATA', `${label} is not a valid date.`);
  }
  return epochMilliseconds;
}

export function reviewSchedulingStateFromCard(card: Card): ReviewSchedulingState {
  const clone = cardFromPersisted(cardToPersisted(card));
  return {
    ...clone,
    due: new Date(clone.due.getTime()),
    ...(clone.last_review ? { last_review: new Date(clone.last_review.getTime()) } : {}),
  };
}

export function cardFromReviewSchedulingState(state: ReviewSchedulingState): Card {
  return cardFromPersisted({
    due: new Date(reviewDateEpochMilliseconds(state.due, 'expected review due')).toISOString(),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsed_days: state.elapsed_days,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    ...(state.last_review === undefined
      ? {}
      : {
          last_review: new Date(
            reviewDateEpochMilliseconds(state.last_review, 'expected last review'),
          ).toISOString(),
        }),
  });
}

export function reviewSchedulingStatesMatch(
  currentCard: Card,
  expectedState: ReviewSchedulingState,
): boolean {
  const expectedCard = cardFromReviewSchedulingState(expectedState);
  return (
    reviewDateEpochMilliseconds(currentCard.due) ===
      reviewDateEpochMilliseconds(expectedCard.due) &&
    currentCard.stability === expectedCard.stability &&
    currentCard.difficulty === expectedCard.difficulty &&
    currentCard.elapsed_days === expectedCard.elapsed_days &&
    currentCard.scheduled_days === expectedCard.scheduled_days &&
    currentCard.learning_steps === expectedCard.learning_steps &&
    currentCard.reps === expectedCard.reps &&
    currentCard.lapses === expectedCard.lapses &&
    currentCard.state === expectedCard.state &&
    nullableDateEpochMilliseconds(currentCard.last_review) ===
      nullableDateEpochMilliseconds(expectedCard.last_review)
  );
}

function nullableDateEpochMilliseconds(value: Date | undefined): number | null {
  return value === undefined ? null : reviewDateEpochMilliseconds(value, 'last review');
}
