import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REVIEW_ART_SLOTS,
  WORKING_HEAD_POSE,
  allDonePose,
  headPoseForMood,
  homePose,
  idlePoseForHour,
  invitePose,
  phoneHeadPose,
  reactionPose,
  revealPose,
  reviewArtSlot,
  reviewCompletePose,
  reviewSlotIsStill,
  reviewSlotPose,
} from './companion-scenes';
import { COMPANION_FIGURE_POSES, COMPANION_HEAD_POSES } from './wardrobe';

// 2026-10-28 is epoch day 20754 (even, divisible by 3); 2026-10-29 is 20755.
const EVEN_DAY = '2026-10-28';
const ODD_DAY = '2026-10-29';

describe('companion scenes', () => {
  it('changes the idle pose with the hour', () => {
    const byHour = Array.from({ length: 24 }, (_, hour) => idlePoseForHour(hour));
    expect(byHour.slice(0, 5)).toEqual(['calm', 'calm', 'calm', 'calm', 'calm']);
    expect(byHour.slice(5, 11)).toEqual(Array(6).fill('wave'));
    expect(byHour.slice(11, 17)).toEqual(Array(6).fill('read'));
    expect(byHour.slice(17, 22)).toEqual(Array(5).fill('tea'));
    expect(byHour.slice(22)).toEqual(['calm', 'calm']);
  });

  it('alternates day poses by the date, not the clock', () => {
    expect(invitePose(EVEN_DAY)).toBe('point');
    expect(invitePose(ODD_DAY)).toBe('card');
    expect(allDonePose(EVEN_DAY)).toBe('peace');
    expect(allDonePose(ODD_DAY)).toBe('jump');
    expect(reviewCompletePose(EVEN_DAY)).toBe('peace');
    expect(reviewCompletePose(ODD_DAY)).toBe('jump');
    expect(reviewCompletePose('2026-10-30')).toBe('clap');
    expect(invitePose('not a date')).toBe('point');
  });

  it('cycles completion reactions and reveal poses', () => {
    expect([0, 1, 2, 3, 4].map(reactionPose)).toEqual(['cheer', 'clap', 'thumbs', 'cheer', 'clap']);
    expect(reactionPose(-1)).toBe('thumbs');
    expect([0, 1, 2].map(revealPose)).toEqual(['aha', 'note', 'aha']);
  });

  it('picks the Home pose from the moment', () => {
    const base = {
      mood: 'idle',
      hour: 14,
      dateKey: EVEN_DAY,
      reviewsDue: false,
      allDone: false,
      reactionOrdinal: null,
    } as const;
    expect(homePose(base)).toBe('read');
    expect(homePose({ ...base, mood: 'due', reviewsDue: true })).toBe('point');
    expect(homePose({ ...base, mood: 'due', reviewsDue: true, dateKey: ODD_DAY })).toBe('card');
    expect(homePose({ ...base, mood: 'due' })).toBe('fist');
    expect(homePose({ ...base, mood: 'success', allDone: true })).toBe('peace');
    expect(homePose({ ...base, mood: 'success', reactionOrdinal: 1 })).toBe('clap');
  });

  it('gives each mood a head', () => {
    expect(headPoseForMood('idle')).toBe('head-smile');
    expect(headPoseForMood('due')).toBe('head-talk');
    expect(headPoseForMood('reviewing')).toBe('head-talk');
    expect(headPoseForMood('success')).toBe('head-joy');
    // While a 工作中 card is open, the review strip shows this one, still.
    expect(WORKING_HEAD_POSE).toBe('head-smile');
  });

  it('keys Review art on the scene and keeps the question still', () => {
    expect(reviewArtSlot('ENTRY', 'due')).toBe('invite');
    expect(reviewArtSlot('ENTRY', 'idle')).toBe('rest');
    expect(reviewArtSlot('PROMPT', 'due')).toBe('recall');
    for (const scene of ['REVEAL_TRANSITION', 'REVEALED', 'RATING', 'REACTION'] as const) {
      expect(reviewArtSlot(scene, 'reviewing')).toBe('reveal');
    }
    expect(reviewArtSlot('COMPLETED', 'success')).toBe('complete');
    const input = { hour: 19, dateKey: EVEN_DAY, cardIndex: 1 };
    expect(REVIEW_ART_SLOTS.map((slot) => reviewSlotPose(slot, input))).toEqual([
      'tea',
      'point',
      'think',
      'note',
      'peace',
    ]);
    expect(REVIEW_ART_SLOTS.filter(reviewSlotIsStill)).toEqual(['recall']);
  });

  it('chooses the phone head from the task list', () => {
    const base = { loadError: false, reacting: false, openTasks: 3, completedToday: 0 };
    expect(phoneHeadPose(base)).toBe('head-smile');
    expect(phoneHeadPose({ ...base, openTasks: null })).toBe('head-smile');
    expect(phoneHeadPose({ ...base, reacting: true })).toBe('head-joy');
    expect(phoneHeadPose({ ...base, openTasks: 0, completedToday: 2 })).toBe('head-joy');
    expect(phoneHeadPose({ ...base, openTasks: 0 })).toBe('head-sleepy');
    expect(phoneHeadPose({ ...base, loadError: true, reacting: true })).toBe('head-worried');
  });

  it('only returns poses that exist and never draws at random', () => {
    const figures = new Set<string>(COMPANION_FIGURE_POSES);
    const heads = new Set<string>(COMPANION_HEAD_POSES);
    for (let hour = 0; hour < 24; hour += 1) expect(figures.has(idlePoseForHour(hour))).toBe(true);
    for (let index = 0; index < 6; index += 1) {
      expect(figures.has(reactionPose(index))).toBe(true);
      expect(figures.has(revealPose(index))).toBe(true);
    }
    for (const mood of ['idle', 'due', 'reviewing', 'success'] as const) {
      expect(heads.has(headPoseForMood(mood))).toBe(true);
    }
    expect(heads.has(WORKING_HEAD_POSE)).toBe(true);
    const source = readFileSync(resolve('src/companion/companion-scenes.ts'), 'utf8');
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('Date.now');
  });
});
