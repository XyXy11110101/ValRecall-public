import { Rating, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';

import { FsrsService } from './FsrsService';
import {
  DEFAULT_SHORT_TERM_REVIEW_MODE,
  isShortTermReviewMode,
  parametersForShortTermMode,
} from './config';

const fixedNow = new Date('2026-07-26T12:00:00.000Z');

describe('FSRS scheduler configuration', () => {
  it('records the exact verified production defaults', () => {
    const configuration = new FsrsService().getConfiguration();

    expect(DEFAULT_SHORT_TERM_REVIEW_MODE).toBe('standard');
    expect(configuration).toMatchObject({
      packageVersion: 'v5.4.1',
      algorithmVersion: 'FSRS-6.0',
      shortTermReviewMode: 'standard',
      parameters: {
        request_retention: 0.9,
        maximum_interval: 36500,
        enable_fuzz: false,
        enable_short_term: true,
        learning_steps: ['1m', '10m'],
        relearning_steps: ['10m'],
      },
    });
    expect(configuration.parameters.w).toEqual([
      0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
      0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
    ]);
  });

  it.each([
    ['off', [], State.Review, '2026-07-28T12:00:00.000Z'],
    ['light', ['10m', '10m'], State.Learning, '2026-07-26T12:10:00.000Z'],
    ['standard', ['1m', '10m'], State.Learning, '2026-07-26T12:10:00.000Z'],
  ] as const)(
    'verifies the %s mode against the installed ts-fsrs API',
    (mode, learningSteps, state, due) => {
      const service = new FsrsService({
        clock: () => new Date(fixedNow),
        shortTermReviewMode: mode,
      });
      const result = service.schedule(service.createInitialCard(), Rating.Good);

      expect(parametersForShortTermMode(mode).learning_steps).toEqual(learningSteps);
      expect(result.card.state).toBe(state);
      expect(result.nextDue.toISOString()).toBe(due);
    },
  );

  it('preserves ten-minute relearning in every mode', () => {
    for (const mode of ['off', 'light', 'standard'] as const) {
      const service = new FsrsService({
        clock: () => new Date(fixedNow),
        shortTermReviewMode: mode,
      });
      const reviewCard = service.schedule(service.createInitialCard(), Rating.Easy, fixedNow);
      const forgotten = service.schedule(reviewCard.card, Rating.Again, reviewCard.nextDue);

      expect(parametersForShortTermMode(mode).relearning_steps).toEqual(['10m']);
      expect(forgotten.card.state).toBe(State.Relearning);
      expect(forgotten.nextDue.getTime() - reviewCard.nextDue.getTime()).toBe(10 * 60_000);
    }
  });

  it('Light has one distinct ten-minute Good return before Review', () => {
    const service = new FsrsService({
      clock: () => new Date(fixedNow),
      shortTermReviewMode: 'light',
    });
    const first = service.schedule(service.createInitialCard(), Rating.Good);
    const second = service.schedule(first.card, Rating.Good, first.nextDue);

    expect(first.card.state).toBe(State.Learning);
    expect(first.nextDue.getTime() - fixedNow.getTime()).toBe(10 * 60_000);
    expect(second.card.state).toBe(State.Review);
    expect(second.card.scheduled_days).toBe(2);
  });

  it('constructing another mode does not reschedule an existing card', () => {
    const standard = new FsrsService({
      clock: () => new Date(fixedNow),
      shortTermReviewMode: 'standard',
    });
    const existing = standard.schedule(standard.createInitialCard(), Rating.Good).card;
    const original = {
      due: existing.due.getTime(),
      state: existing.state,
      stability: existing.stability,
      difficulty: existing.difficulty,
      reps: existing.reps,
    };

    new FsrsService({ shortTermReviewMode: 'off' }).getConfiguration();

    expect(existing).toMatchObject({
      state: original.state,
      stability: original.stability,
      difficulty: original.difficulty,
      reps: original.reps,
    });
    expect(existing.due.getTime()).toBe(original.due);
  });

  it('guards persisted short-term mode values', () => {
    expect(isShortTermReviewMode('off')).toBe(true);
    expect(isShortTermReviewMode('light')).toBe(true);
    expect(isShortTermReviewMode('standard')).toBe(true);
    expect(isShortTermReviewMode('fast')).toBe(false);
  });
});
