import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import {
  createReviewCompanionState,
  reduceReviewCompanionState,
  reviewCompanionMessage,
  type ReviewCompanionState,
  type ReviewRatingReaction,
} from './review-companion';
import { COMPLETE_POOL, ENTRY_POOL, PROMPT_POOL, REVEAL_POOL } from './review-companion-copy';

describe('Review Companion Stage controller', () => {
  it('derives spatial states and owners through PROMPT, ANSWER, next PROMPT, and COMPLETED', () => {
    const entry = createReviewCompanionState(true);
    const prompt = reduceReviewCompanionState(entry, { type: 'START_PROMPT' });
    const revealTransition = reduceReviewCompanionState(prompt, { type: 'REVEAL' });
    const revealed = reduceReviewCompanionState(revealTransition, {
      type: 'SETTLE_REVEAL',
      expectedSequence: revealTransition.sequence,
    });
    const rating = reduceReviewCompanionState(revealed, {
      type: 'RATE',
      rating: Rating.Good,
    });
    const nextPrompt = persistRated(rating, true);

    expect(entry).toMatchObject({
      scene: 'ENTRY',
      macro: 'due',
      spatial: 'hero',
      owner: 'companion',
    });
    expect(prompt).toMatchObject({
      scene: 'PROMPT',
      macro: 'due',
      spatial: 'compact',
      owner: 'recall-content',
      dialogue: { intent: 'prompt', origin: 'prompt', text: PROMPT_POOL[0] },
    });
    expect(revealTransition).toMatchObject({
      scene: 'REVEAL_TRANSITION',
      macro: 'reviewing',
      reaction: 'reveal',
      spatial: 'hero',
      owner: 'companion',
      dialogue: { intent: 'discovery', origin: 'reveal', text: REVEAL_POOL[0] },
    });
    expect(revealed).toMatchObject({
      scene: 'REVEALED',
      macro: 'reviewing',
      spatial: 'yield',
      owner: 'key-takeaway',
      dialogue: { intent: 'discovery', origin: 'reveal', text: REVEAL_POOL[0] },
    });
    expect(rating).toMatchObject({
      scene: 'RATING',
      macro: 'reviewing',
      spatial: 'yield',
      owner: 'controls',
      dialogue: null,
    });
    expect(nextPrompt).toMatchObject({
      scene: 'PROMPT',
      macro: 'due',
      spatial: 'compact',
      owner: 'recall-content',
      dialogue: { intent: 'prompt', origin: 'prompt', text: PROMPT_POOL[1] },
      lastCommittedRating: null,
      reactionPayload: null,
    });

    const finalReveal = reduceReviewCompanionState(nextPrompt, { type: 'REVEAL' });
    const finalRating = reduceReviewCompanionState(finalReveal, {
      type: 'RATE',
      rating: Rating.Hard,
    });
    const complete = persistRated(finalRating, false);

    expect(complete).toMatchObject({
      scene: 'COMPLETED',
      macro: 'success',
      reaction: 'complete',
      spatial: 'hero',
      owner: 'companion-and-summary',
      lastCommittedRating: null,
      reactionPayload: null,
      dialogue: { intent: 'completion', level: 'major' },
    });
    expect(reviewCompanionMessage(complete)).toBe(COMPLETE_POOL[0]);
    expect(reviewCompanionMessage(complete)).toBeTruthy();
  });

  it.each([
    [Rating.Again, 'again'],
    [Rating.Hard, 'hard'],
    [Rating.Good, 'good'],
    [Rating.Easy, 'easy'],
  ] as const)('returns to the next PROMPT after a non-final %s write', (rating, reaction) => {
    const revealed = revealedState();
    const rated = reduceReviewCompanionState(revealed, { type: 'RATE', rating });
    const nextPrompt = persistRated(rated, true);

    expect(rated.macro).toBe('reviewing');
    expect(rated.reaction).toBe<ReviewRatingReaction>(reaction);
    expect(rated.dialogue).toBeNull();
    expect(nextPrompt).toMatchObject({
      scene: 'PROMPT',
      macro: 'due',
      reactionPayload: null,
      lastCommittedRating: null,
      dialogue: { origin: 'prompt', text: PROMPT_POOL[1] },
    });
  });

  it('replaces the ENTRY invitation with a fresh first-card PROMPT line', () => {
    const entry = createReviewCompanionState(true);
    const prompt = reduceReviewCompanionState(entry, { type: 'START_PROMPT' });
    const timedOut = reduceReviewCompanionState(entry, {
      type: 'DISMISS_DIALOGUE',
      expectedDialogueSequence: entry.dialogue?.sequence ?? -1,
    });
    const reveal = reduceReviewCompanionState(prompt, { type: 'REVEAL' });

    expect(entry.dialogue).toMatchObject({
      intent: 'invitation',
      level: 'major',
      origin: 'entry',
      lifetime: 'scene',
      text: ENTRY_POOL[0],
    });
    expect(entry.dialogue?.text).toBeTruthy();
    expect(prompt).toMatchObject({
      scene: 'PROMPT',
      spatial: 'compact',
      dialogue: {
        intent: 'prompt',
        origin: 'prompt',
        lifetime: 'scene',
        text: PROMPT_POOL[0],
      },
    });
    expect(timedOut).toBe(entry);
    expect(timedOut.dialogue?.text).toBeTruthy();
    expect(reveal.dialogue).toMatchObject({
      intent: 'discovery',
      origin: 'reveal',
      lifetime: 'scene',
      text: REVEAL_POOL[0],
    });
    expect(reveal.dialogue?.text).not.toBe(prompt.dialogue?.text);
  });

  it('speaks Discovery on Reveal and retains it through ANSWER settle', () => {
    const prompt = reduceReviewCompanionState(createReviewCompanionState(true), {
      type: 'START_PROMPT',
    });
    const reveal = reduceReviewCompanionState(prompt, { type: 'REVEAL' });
    const yielded = settleReveal(reveal);
    expect(reveal.dialogue).toMatchObject({
      intent: 'discovery',
      origin: 'reveal',
      text: REVEAL_POOL[0],
    });
    expect(yielded.dialogue).toEqual(reveal.dialogue);
  });

  it('does not keep rating speech after a non-final persist', () => {
    const nextPrompt = persistRated(
      reduceReviewCompanionState(revealedState(), { type: 'RATE', rating: Rating.Good }),
      true,
    );
    expect(nextPrompt).toMatchObject({
      scene: 'PROMPT',
      reactionPayload: null,
      dialogue: { origin: 'prompt', text: PROMPT_POOL[1] },
    });
  });

  it('does not enter REACTION when persistence fails', () => {
    const rated = reduceReviewCompanionState(revealedState(), {
      type: 'RATE',
      rating: Rating.Again,
    });
    const failed = reduceReviewCompanionState(rated, {
      type: 'RATING_FAILED',
      expectedSequence: rated.sequence,
    });
    expect(failed).toMatchObject({
      scene: 'REVEALED',
      reactionPayload: null,
      lastCommittedRating: null,
      dialogue: null,
    });
    expect(
      reduceReviewCompanionState(failed, {
        type: 'NEXT_AFTER_REACTION',
        expectedSequence: failed.sequence,
      }),
    ).toBe(failed);
  });

  it('skips REACTION on an unavailable card and does not keep rating speech', () => {
    const rated = reduceReviewCompanionState(revealedState(), {
      type: 'RATE',
      rating: Rating.Good,
    });
    const skippedNext = reduceReviewCompanionState(rated, {
      type: 'SKIPPED',
      hasNextCard: true,
      expectedSequence: rated.sequence,
    });
    const skippedLast = reduceReviewCompanionState(rated, {
      type: 'SKIPPED',
      hasNextCard: false,
      expectedSequence: rated.sequence,
    });
    expect(skippedNext).toMatchObject({
      scene: 'PROMPT',
      dialogue: { origin: 'prompt', text: PROMPT_POOL[1] },
      reactionPayload: null,
    });
    expect(skippedLast).toMatchObject({
      scene: 'COMPLETED',
      dialogue: { intent: 'completion' },
    });
  });

  it('marks a Moment as mastered from prompt without entering a rating scene', () => {
    const prompt = reduceReviewCompanionState(createReviewCompanionState(true), {
      type: 'START_PROMPT',
    });
    const next = reduceReviewCompanionState(prompt, { type: 'MASTERED', hasNextCard: true });
    const last = reduceReviewCompanionState(prompt, { type: 'MASTERED', hasNextCard: false });
    expect(next).toMatchObject({
      scene: 'PROMPT',
      dialogue: { origin: 'prompt', text: PROMPT_POOL[1] },
    });
    expect(last).toMatchObject({
      scene: 'COMPLETED',
      dialogue: { intent: 'completion' },
    });
  });

  it('rejects stale settle, next-after-reaction, and completion callbacks', () => {
    const prompt = reduceReviewCompanionState(createReviewCompanionState(true), {
      type: 'START_PROMPT',
    });
    const reveal = reduceReviewCompanionState(prompt, { type: 'REVEAL' });
    const rated = reduceReviewCompanionState(reveal, { type: 'RATE', rating: Rating.Easy });

    expect(
      reduceReviewCompanionState(rated, {
        type: 'SETTLE_REVEAL',
        expectedSequence: reveal.sequence,
      }),
    ).toBe(rated);

    const nextPrompt = persistRated(rated, true);
    expect(
      reduceReviewCompanionState(nextPrompt, {
        type: 'NEXT_AFTER_REACTION',
        expectedSequence: rated.sequence,
      }),
    ).toBe(nextPrompt);

    const nextReveal = reduceReviewCompanionState(nextPrompt, { type: 'REVEAL' });
    expect(
      reduceReviewCompanionState(nextReveal, {
        type: 'PERSISTED',
        hasNextCard: false,
        expectedSequence: rated.sequence,
      }),
    ).toBe(nextReveal);
  });
});

function revealedState(): ReviewCompanionState {
  const prompt = reduceReviewCompanionState(createReviewCompanionState(true), {
    type: 'START_PROMPT',
  });
  return settleReveal(reduceReviewCompanionState(prompt, { type: 'REVEAL' }));
}

function settleReveal(reveal: ReviewCompanionState): ReviewCompanionState {
  return reduceReviewCompanionState(reveal, {
    type: 'SETTLE_REVEAL',
    expectedSequence: reveal.sequence,
  });
}

function persistRated(rated: ReviewCompanionState, hasNextCard: boolean): ReviewCompanionState {
  return reduceReviewCompanionState(rated, {
    type: 'PERSISTED',
    hasNextCard,
    expectedSequence: rated.sequence,
  });
}
