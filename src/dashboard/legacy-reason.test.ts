import { describe, expect, it } from 'vitest';

import { classifyLegacyReason } from './legacy-reason';

describe('legacy Reason compatibility', () => {
  const base = {
    reason: '',
    coreLesson: 'Hold the angle.',
    referenceAnswer: 'Keep the crosshair ready.',
    situation: 'Defending the site.',
    mistakeToAvoid: 'Do not swing early.',
    recommendedAction: 'Wait for the cue.',
    subtitleBefore: ['Wait for utility.'],
    subtitleCurrent: ['The smoke has landed.'],
    subtitleAfter: ['Clear the next angle.'],
  };

  it('classifies empty and learning-content duplicates without changing stored text', () => {
    expect(classifyLegacyReason(base)).toEqual({ kind: 'none', value: '' });
    expect(classifyLegacyReason({ ...base, reason: '  Hold\n the angle.  ' })).toEqual({
      kind: 'duplicate',
      value: '  Hold\n the angle.  ',
    });
    expect(classifyLegacyReason({ ...base, reason: ' Keep the crosshair ready. ' })).toEqual({
      kind: 'duplicate',
      value: ' Keep the crosshair ready. ',
    });
    expect(classifyLegacyReason({ ...base, reason: 'Do not swing early.' }).kind).toBe('duplicate');
  });

  it('recognises exact individual and generated subtitle-context duplicates', () => {
    expect(classifyLegacyReason({ ...base, reason: 'The smoke has landed.' }).kind).toBe(
      'duplicate',
    );
    expect(
      classifyLegacyReason({ ...base, reason: 'Wait for utility. Clear the next angle.' }).kind,
    ).toBe('duplicate');
    expect(
      classifyLegacyReason({
        ...base,
        reason: 'Wait for utility. The smoke has landed. Clear the next angle.',
      }).kind,
    ).toBe('duplicate');
  });

  it('preserves a distinct legacy explanation exactly', () => {
    const reason = '  I wrote this explanation myself.\nKeep both clauses.  ';
    expect(classifyLegacyReason({ ...base, reason })).toEqual({ kind: 'distinct', value: reason });
  });
});
