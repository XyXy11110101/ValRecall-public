import { describe, expect, it } from 'vitest';
import { dateInTimeZone, isSyncId, isTimeZone, probeResponse } from './protocol';

describe('local sync calendar and probe boundary', () => {
  it('follows the supplied PC timezone, not the phone timezone', () => {
    const now = new Date('2026-10-13T20:00:00Z');
    expect(dateInTimeZone(now, 'Europe/London')).toBe('2026-10-13');
    expect(dateInTimeZone(now, 'Asia/Shanghai')).toBe('2026-10-14');
  });
  it('handles DST, midnight and year boundaries without adding 24 hours', () => {
    expect(dateInTimeZone(new Date('2026-03-29T23:30:00Z'), 'Europe/London')).toBe('2026-03-30');
    expect(dateInTimeZone(new Date('2026-10-25T01:30:00Z'), 'Europe/London')).toBe('2026-10-25');
    expect(dateInTimeZone(new Date('2026-12-31T23:30:00Z'), 'Asia/Shanghai')).toBe('2027-01-01');
  });
  it('rejects unknown zones and invalid dates', () => {
    expect(isTimeZone('not/a-zone')).toBe(false);
    expect(() => dateInTimeZone(new Date(NaN), 'UTC')).toThrow();
    expect(isSyncId('../secret')).toBe(false);
    expect(isSyncId('a'.repeat(101))).toBe(false);
  });
  it('never turns a transport probe into a business mutation', () => {
    expect(probeResponse({ version: 1, type: 'probe' }).type).toBe('probe');
    for (const request of [
      null,
      {},
      { version: 2, type: 'probe' },
      { version: 1, type: 'spend' },
    ]) {
      expect(() => probeResponse(request)).toThrow();
    }
  });
});
