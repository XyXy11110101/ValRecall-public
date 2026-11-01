import { Rating, toFsrsRating, type FsrsRatingInput } from '../fsrs';

import {
  COMPLETE_POOL,
  ENTRY_POOL,
  PROMPT_POOL,
  REVEAL_POOL,
  nextLine,
} from './review-companion-copy';

export type ReviewCompanionScene =
  'ENTRY' | 'PROMPT' | 'REVEAL_TRANSITION' | 'REVEALED' | 'RATING' | 'REACTION' | 'COMPLETED';

export type ReviewCompanionMacro = 'idle' | 'due' | 'reviewing' | 'success';

export type ReviewCompanionReaction =
  'entry' | 'anticipate' | 'reveal' | 'again' | 'hard' | 'good' | 'easy' | 'settle' | 'complete';

export type ReviewRatingReaction = 'again' | 'hard' | 'good' | 'easy';

export type ReviewCompanionPriority = 'ambient' | 'acknowledgement' | 'direct' | 'major';
export type ReviewCompanionIntensity = 'subtle' | 'normal' | 'major';
export type ReviewCompanionSpatialState = 'hero' | 'compact' | 'yield' | 'rest' | 'reaction';
export type ReviewStageOwner =
  | 'companion'
  | 'recall-content'
  | 'key-takeaway'
  | 'controls'
  | 'reaction'
  | 'companion-and-summary';

export type ReviewDialogueIntent =
  | 'invitation'
  | 'prompt'
  | 'discovery'
  | 'effort-acknowledgement'
  | 'recall-acknowledgement'
  | 'completion';
export type ReviewDialogueLevel = 'optional' | 'major';
export type ReviewDialogueOrigin = 'entry' | 'prompt' | 'reveal' | 'rating' | 'completion';
export type ReviewDialogueLifetime = 'timed' | 'scene' | 'persistence';

export interface ReviewCompanionDialogue {
  intent: ReviewDialogueIntent;
  level: ReviewDialogueLevel;
  origin: ReviewDialogueOrigin;
  lifetime: ReviewDialogueLifetime;
  text: string;
  sequence: number;
}

export interface ReviewReactionPayload {
  rating: ReviewRatingReaction;
  text: string;
  sequence: number;
}

export interface ReviewCompanionCopyIndex {
  entry: number;
  prompt: number;
  reveal: number;
  again: number;
  hard: number;
  good: number;
  easy: number;
  complete: number;
}

export const INITIAL_REVIEW_COPY_INDEX: ReviewCompanionCopyIndex = {
  entry: -1,
  prompt: -1,
  reveal: -1,
  again: -1,
  hard: -1,
  good: -1,
  easy: -1,
  complete: -1,
};

export interface ReviewCompanionState {
  scene: ReviewCompanionScene;
  macro: ReviewCompanionMacro;
  reaction: ReviewCompanionReaction;
  priority: ReviewCompanionPriority;
  intensity: ReviewCompanionIntensity;
  spatial: ReviewCompanionSpatialState;
  owner: ReviewStageOwner;
  rating: ReviewRatingReaction | null;
  lastCommittedRating: ReviewRatingReaction | null;
  reactionPayload: ReviewReactionPayload | null;
  sequence: number;
  dialogue: ReviewCompanionDialogue | null;
  lastDialogueIntent: ReviewDialogueIntent | null;
  cardsSinceDialogue: number;
  lastDialogueSequence: number | null;
  copyIndex: ReviewCompanionCopyIndex;
}

type ExpectedSequence = { expectedSequence: number };

export type ReviewCompanionEvent =
  | { type: 'ENTRY'; hasDue: boolean }
  | { type: 'START_PROMPT' }
  | { type: 'REVEAL' }
  | ({ type: 'SETTLE_REVEAL' } & ExpectedSequence)
  | { type: 'RATE'; rating: FsrsRatingInput; rapidInteraction?: boolean }
  | ({ type: 'PERSISTED'; hasNextCard: boolean } & ExpectedSequence)
  | ({ type: 'RATING_FAILED' } & ExpectedSequence)
  | ({ type: 'SKIPPED'; hasNextCard: boolean } & ExpectedSequence)
  | { type: 'MASTERED'; hasNextCard: boolean }
  | ({ type: 'NEXT_AFTER_REACTION' } & ExpectedSequence)
  | { type: 'DISMISS_DIALOGUE'; expectedDialogueSequence: number };

export function createReviewCompanionState(hasDue = false): ReviewCompanionState {
  const base: ReviewCompanionState = {
    scene: 'ENTRY',
    macro: hasDue ? 'due' : 'idle',
    reaction: 'entry',
    priority: 'major',
    intensity: 'major',
    spatial: 'hero',
    owner: 'companion',
    rating: null,
    lastCommittedRating: null,
    reactionPayload: null,
    sequence: 0,
    dialogue: null,
    lastDialogueIntent: null,
    cardsSinceDialogue: 0,
    lastDialogueSequence: null,
    copyIndex: { ...INITIAL_REVIEW_COPY_INDEX },
  };
  return hasDue ? speakInvitation(base, 0) : base;
}

export function reduceReviewCompanionState(
  current: ReviewCompanionState,
  event: ReviewCompanionEvent,
): ReviewCompanionState {
  if ('expectedSequence' in event && event.expectedSequence !== current.sequence) return current;

  const sequence = current.sequence + 1;
  switch (event.type) {
    case 'ENTRY':
      return createEntryState(event.hasDue, sequence, current.copyIndex);
    case 'START_PROMPT':
      return promptState(current, sequence, false);
    case 'REVEAL': {
      if (current.scene !== 'PROMPT') return current;
      return speakReveal(
        {
          ...current,
          scene: 'REVEAL_TRANSITION',
          macro: 'reviewing',
          reaction: 'reveal',
          priority: 'major',
          intensity: 'major',
          spatial: 'hero',
          owner: 'companion',
          rating: null,
          lastCommittedRating: null,
          reactionPayload: null,
          sequence,
          dialogue: null,
        },
        sequence,
      );
    }
    case 'SETTLE_REVEAL':
      if (current.scene !== 'REVEAL_TRANSITION') return current;
      return {
        ...current,
        scene: 'REVEALED',
        reaction: 'settle',
        priority: 'acknowledgement',
        intensity: 'subtle',
        spatial: 'yield',
        owner: 'key-takeaway',
        sequence,
      };
    case 'RATE': {
      if (current.scene !== 'REVEAL_TRANSITION' && current.scene !== 'REVEALED') return current;
      const rating = reviewRatingReaction(event.rating);
      return {
        ...current,
        scene: 'RATING',
        macro: 'reviewing',
        reaction: rating,
        priority: 'direct',
        intensity: 'subtle',
        spatial: 'yield',
        owner: 'controls',
        rating,
        sequence,
        dialogue: null,
      };
    }
    case 'PERSISTED': {
      if (current.scene !== 'RATING' || current.rating === null) return current;
      if (!event.hasNextCard) {
        return speakCompletion(completeState(current, sequence), sequence);
      }
      return promptState(current, sequence, true);
    }
    case 'RATING_FAILED':
      if (current.scene !== 'RATING') return current;
      return {
        ...current,
        scene: 'REVEALED',
        macro: 'reviewing',
        reaction: 'settle',
        priority: 'acknowledgement',
        intensity: 'subtle',
        spatial: 'yield',
        owner: 'key-takeaway',
        rating: null,
        lastCommittedRating: null,
        reactionPayload: null,
        sequence,
        dialogue: null,
      };
    case 'SKIPPED':
      if (current.scene !== 'RATING') return current;
      if (event.hasNextCard) return promptState(current, sequence, true);
      return speakCompletion(completeState(current, sequence), sequence);
    case 'MASTERED':
      if (
        current.scene !== 'PROMPT' &&
        current.scene !== 'REVEAL_TRANSITION' &&
        current.scene !== 'REVEALED' &&
        current.scene !== 'RATING'
      ) {
        return current;
      }
      if (event.hasNextCard) return promptState(current, sequence, true);
      return speakCompletion(completeState(current, sequence), sequence);
    case 'NEXT_AFTER_REACTION':
      if (current.scene !== 'REACTION') return current;
      return promptState(current, sequence, true);
    case 'DISMISS_DIALOGUE':
      if (
        current.dialogue === null ||
        current.dialogue.lifetime !== 'timed' ||
        current.dialogue.sequence !== event.expectedDialogueSequence
      ) {
        return current;
      }
      return { ...current, dialogue: null };
  }
}

export function reviewCompanionMessage(state: ReviewCompanionState): string | null {
  return state.dialogue?.text ?? null;
}

function createEntryState(
  hasDue: boolean,
  sequence: number,
  copyIndex: ReviewCompanionCopyIndex,
): ReviewCompanionState {
  const state: ReviewCompanionState = {
    scene: 'ENTRY',
    macro: hasDue ? 'due' : 'idle',
    reaction: 'entry',
    priority: 'major',
    intensity: 'major',
    spatial: 'hero',
    owner: 'companion',
    rating: null,
    lastCommittedRating: null,
    reactionPayload: null,
    sequence,
    dialogue: null,
    lastDialogueIntent: null,
    cardsSinceDialogue: 0,
    lastDialogueSequence: null,
    copyIndex,
  };
  return hasDue ? speakInvitation(state, sequence) : state;
}

function promptState(
  current: ReviewCompanionState,
  sequence: number,
  completedCard: boolean,
): ReviewCompanionState {
  return speakPrompt(
    {
      ...current,
      scene: 'PROMPT',
      macro: 'due',
      reaction: 'anticipate',
      priority: 'ambient',
      intensity: 'subtle',
      spatial: 'compact',
      owner: 'recall-content',
      rating: null,
      lastCommittedRating: null,
      reactionPayload: null,
      sequence,
      dialogue: null,
      cardsSinceDialogue: current.cardsSinceDialogue + (completedCard ? 1 : 0),
    },
    sequence,
  );
}

function completeState(current: ReviewCompanionState, sequence: number): ReviewCompanionState {
  return {
    ...current,
    scene: 'COMPLETED',
    macro: 'success',
    reaction: 'complete',
    priority: 'major',
    intensity: 'major',
    spatial: 'hero',
    owner: 'companion-and-summary',
    rating: null,
    lastCommittedRating: null,
    reactionPayload: null,
    sequence,
    dialogue: null,
  };
}

function speak(
  state: ReviewCompanionState,
  dialogue: ReviewCompanionDialogue,
  resetCardCooldown = true,
): ReviewCompanionState {
  return {
    ...state,
    dialogue,
    lastDialogueIntent: dialogue.intent,
    cardsSinceDialogue: resetCardCooldown ? 0 : state.cardsSinceDialogue,
    lastDialogueSequence: dialogue.sequence,
  };
}

function speakInvitation(state: ReviewCompanionState, sequence: number): ReviewCompanionState {
  const { line, nextIndex } = nextLine(ENTRY_POOL, state.copyIndex.entry);
  return speak(
    { ...state, copyIndex: { ...state.copyIndex, entry: nextIndex } },
    {
      intent: 'invitation',
      level: 'major',
      origin: 'entry',
      lifetime: 'scene',
      text: line,
      sequence,
    },
  );
}

function speakPrompt(state: ReviewCompanionState, sequence: number): ReviewCompanionState {
  const { line, nextIndex } = nextLine(PROMPT_POOL, state.copyIndex.prompt);
  return speak(
    { ...state, copyIndex: { ...state.copyIndex, prompt: nextIndex } },
    {
      intent: 'prompt',
      level: 'optional',
      origin: 'prompt',
      lifetime: 'scene',
      text: line,
      sequence,
    },
  );
}

function speakReveal(state: ReviewCompanionState, sequence: number): ReviewCompanionState {
  const { line, nextIndex } = nextLine(REVEAL_POOL, state.copyIndex.reveal);
  return speak(
    { ...state, copyIndex: { ...state.copyIndex, reveal: nextIndex } },
    {
      intent: 'discovery',
      level: 'optional',
      origin: 'reveal',
      lifetime: 'scene',
      text: line,
      sequence,
    },
  );
}

function speakCompletion(state: ReviewCompanionState, sequence: number): ReviewCompanionState {
  const { line, nextIndex } = nextLine(COMPLETE_POOL, state.copyIndex.complete);
  return speak(
    { ...state, copyIndex: { ...state.copyIndex, complete: nextIndex } },
    {
      intent: 'completion',
      level: 'major',
      origin: 'completion',
      lifetime: 'scene',
      text: line,
      sequence,
    },
  );
}

export function reviewRatingReaction(rating: FsrsRatingInput): ReviewRatingReaction {
  switch (toFsrsRating(rating)) {
    case Rating.Again:
      return 'again';
    case Rating.Hard:
      return 'hard';
    case Rating.Good:
      return 'good';
    case Rating.Easy:
      return 'easy';
  }
}
