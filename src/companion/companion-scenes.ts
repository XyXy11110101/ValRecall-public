import type { ReviewCompanionMacro, ReviewCompanionScene } from '../dashboard/review-companion';
import { epochDayFromDateKey, type CompanionFigurePose, type CompanionHeadPose } from './wardrobe';

/**
 * Which pose the companion takes for a moment. The outfit comes from the date (wardrobe.ts);
 * the state only picks the pose. Every choice is a fixed function of its inputs — the hour,
 * the date, the card or the completion count — never a random draw, so the same moment always
 * looks the same and tests can pin it.
 */

export type CompanionMood = 'idle' | 'due' | 'reviewing' | 'success';

function pick<T>(items: readonly [T, ...T[]], index: number): T {
  const size = items.length;
  return items[((index % size) + size) % size] ?? items[0];
}

function dayIndex(dateKey: string): number {
  return epochDayFromDateKey(dateKey) ?? 0;
}

/** Nothing is waiting: the idle pose follows the hour. */
export function idlePoseForHour(hour: number): CompanionFigurePose {
  if (hour >= 5 && hour <= 10) return 'wave';
  if (hour >= 11 && hour <= 16) return 'read';
  if (hour >= 17 && hour <= 21) return 'tea';
  return 'calm';
}

/** Reviews are due: pointing one day, holding up a flashcard the next. */
export function invitePose(dateKey: string): CompanionFigurePose {
  return pick(['point', 'card'] as const, dayIndex(dateKey));
}

export function allDonePose(dateKey: string): CompanionFigurePose {
  return pick(['peace', 'jump'] as const, dayIndex(dateKey));
}

/** A completed todo: the ordinal is today's completion count before this one, fixed at commit. */
export function reactionPose(ordinal: number): CompanionFigurePose {
  return pick(['cheer', 'clap', 'thumbs'] as const, ordinal);
}

export function revealPose(cardIndex: number): CompanionFigurePose {
  return pick(['aha', 'note'] as const, cardIndex);
}

export function reviewCompletePose(dateKey: string): CompanionFigurePose {
  return pick(['peace', 'jump', 'clap'] as const, dayIndex(dateKey));
}

export interface HomePoseInput {
  mood: CompanionMood;
  hour: number;
  dateKey: string;
  reviewsDue: boolean;
  allDone: boolean;
  reactionOrdinal: number | null;
}

export function homePose(input: HomePoseInput): CompanionFigurePose {
  if (input.reactionOrdinal !== null) return reactionPose(input.reactionOrdinal);
  if (input.allDone || input.mood === 'success') return allDonePose(input.dateKey);
  if (input.mood === 'due') return input.reviewsDue ? invitePose(input.dateKey) : 'fist';
  if (input.mood === 'reviewing') return 'think';
  return idlePoseForHour(input.hour);
}

/** A 工作中 card is open: the full figure gives way to this still head in Home's review strip. */
export const WORKING_HEAD_POSE: CompanionHeadPose = 'head-smile';

/** Heads for the Tasks page, the side panel and the widget. */
export function headPoseForMood(mood: CompanionMood): CompanionHeadPose {
  switch (mood) {
    case 'idle':
      return 'head-smile';
    case 'due':
    case 'reviewing':
      return 'head-talk';
    case 'success':
      return 'head-joy';
  }
}

/**
 * Review keys its art on the scene, not on `macro`: ENTRY with reviews due and PROMPT share
 * the 'due' macro but need different poses.
 */
export type ReviewArtSlot = 'rest' | 'invite' | 'recall' | 'reveal' | 'complete';

export const REVIEW_ART_SLOTS: readonly ReviewArtSlot[] = [
  'rest',
  'invite',
  'recall',
  'reveal',
  'complete',
];

export function reviewArtSlot(
  scene: ReviewCompanionScene,
  macro: ReviewCompanionMacro,
): ReviewArtSlot {
  switch (scene) {
    case 'ENTRY':
      return macro === 'due' ? 'invite' : 'rest';
    case 'PROMPT':
      return 'recall';
    case 'REVEAL_TRANSITION':
    case 'REVEALED':
    case 'RATING':
    case 'REACTION':
      return 'reveal';
    case 'COMPLETED':
      return 'complete';
  }
}

export interface ReviewSlotPoseInput {
  hour: number;
  dateKey: string;
  cardIndex: number;
}

export function reviewSlotPose(
  slot: ReviewArtSlot,
  input: ReviewSlotPoseInput,
): CompanionFigurePose {
  switch (slot) {
    case 'rest':
      return idlePoseForHour(input.hour);
    case 'invite':
      return invitePose(input.dateKey);
    case 'recall':
      return 'think';
    case 'reveal':
      return revealPose(input.cardIndex);
    case 'complete':
      return reviewCompletePose(input.dateKey);
  }
}

/** Nothing moves while the user is recalling an answer. */
export function reviewSlotIsStill(slot: ReviewArtSlot): boolean {
  return slot === 'recall';
}

export interface PhoneHeadInput {
  loadError: boolean;
  reacting: boolean;
  openTasks: number | null;
  completedToday: number;
}

/** The phone 待办 header: worried on a load error, joyful when done, sleepy when nothing is planned. */
export function phoneHeadPose(input: PhoneHeadInput): CompanionHeadPose {
  if (input.loadError) return 'head-worried';
  if (input.reacting) return 'head-joy';
  if (input.openTasks === null || input.openTasks > 0) return 'head-smile';
  return input.completedToday > 0 ? 'head-joy' : 'head-sleepy';
}
