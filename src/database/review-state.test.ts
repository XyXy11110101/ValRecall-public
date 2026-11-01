import { State, createEmptyCard } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import {
  reviewDateEpochMilliseconds,
  reviewSchedulingStateFromCard,
  reviewSchedulingStatesMatch,
} from './review-state';

const due = new Date('2026-08-03T12:10:00.456Z');

describe('review scheduling state', () => {
  it('canonicalizes ISO strings, hydrated Dates and cloned Dates to epoch milliseconds', () => {
    const card = createEmptyCard(due);
    const base = reviewSchedulingStateFromCard(card);

    expect(reviewDateEpochMilliseconds(due.toISOString())).toBe(due.getTime());
    expect(reviewDateEpochMilliseconds(due)).toBe(due.getTime());
    expect(reviewDateEpochMilliseconds(new Date(due))).toBe(due.getTime());
    expect(reviewSchedulingStatesMatch(card, { ...base, due: due.toISOString() })).toBe(true);
    expect(reviewSchedulingStatesMatch(card, { ...base, due: new Date(due) })).toBe(true);
  });

  it('rejects a one-millisecond due change and a same-due card replacement', () => {
    const card = {
      ...createEmptyCard(due),
      state: State.Review,
      reps: 3,
      stability: 2.5,
      last_review: new Date('2026-08-01T12:00:00.123Z'),
    };
    const base = reviewSchedulingStateFromCard(card);

    expect(reviewSchedulingStatesMatch(card, { ...base, due: new Date(due.getTime() + 1) })).toBe(
      false,
    );
    expect(reviewSchedulingStatesMatch({ ...card, reps: card.reps + 1 }, base)).toBe(false);
  });
});
