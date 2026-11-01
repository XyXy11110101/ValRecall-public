import { describe, expect, it } from 'vitest';

import { formatFsrsInterval, formatNextReview } from './format';

const now = new Date('2026-07-26T12:00:00.000Z');

describe('FSRS interval formatting', () => {
  it.each([
    [60_000, '1m'],
    [10 * 60_000, '10m'],
    [4 * 60 * 60_000, '4h'],
    [24 * 60 * 60_000, '1d'],
    [3 * 24 * 60 * 60_000, '3d'],
    [60 * 24 * 60 * 60_000, '2mo'],
  ])('formats %s milliseconds as %s', (offset, expected) => {
    expect(formatFsrsInterval(now, new Date(now.getTime() + offset))).toBe(expected);
  });

  it('formats concise reader-facing next-review confirmations', () => {
    expect(formatNextReview(now, new Date(now.getTime() + 10 * 60_000))).toBe('in 10 minutes');
    expect(formatNextReview(now, new Date('2026-07-27T12:00:00.000Z'))).toBe('tomorrow');
  });
});
