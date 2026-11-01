import { describe, expect, it } from 'vitest';

import { formatTimestamp, parseTimestamp } from './time';

describe('formatTimestamp', () => {
  it.each([
    [0, '00:00'],
    [9.99, '00:09'],
    [65, '01:05'],
    [3_661.9, '01:01:01'],
    [36_000, '10:00:00'],
  ])('formats %s seconds', (seconds, expected) => {
    expect(formatTimestamp(seconds)).toBe(expected);
  });

  it('rejects values that are not real media timestamps', () => {
    expect(() => formatTimestamp(-1)).toThrow(RangeError);
    expect(() => formatTimestamp(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseTimestamp', () => {
  it('parses minute and hour timestamps', () => {
    expect(parseTimestamp('01:15')).toBe(75);
    expect(parseTimestamp('1:02:03')).toBe(3_723);
  });

  it('rejects malformed clock values', () => {
    expect(parseTimestamp('1:99')).toBeNull();
    expect(parseTimestamp('45')).toBeNull();
  });
});
