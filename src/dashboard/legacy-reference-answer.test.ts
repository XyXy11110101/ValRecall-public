import { describe, expect, it } from 'vitest';

import {
  classifyLegacyReferenceAnswer,
  normalizeLegacyReferenceAnswerWhitespace,
} from './legacy-reference-answer';

describe('legacy Reference answer compatibility', () => {
  it('ignores an empty compatibility value without rewriting it', () => {
    expect(
      classifyLegacyReferenceAnswer({
        referenceAnswer: ' \n\t ',
        coreLesson: 'Hold the angle.',
      }),
    ).toEqual({ kind: 'none', value: ' \n\t ' });
  });

  it('classifies a conservative whitespace-equivalent answer as a duplicate', () => {
    const referenceAnswer = '  Hold\u00a0 the\nangle.  ';
    expect(
      classifyLegacyReferenceAnswer({ referenceAnswer, coreLesson: 'Hold the angle.' }),
    ).toEqual({ kind: 'duplicate', value: referenceAnswer });
    expect(normalizeLegacyReferenceAnswerWhitespace(referenceAnswer)).toBe('Hold the angle.');
  });

  it('preserves a distinct legacy answer exactly', () => {
    const referenceAnswer = '  Use cover first.\nThen pre-aim the swing.  ';
    expect(
      classifyLegacyReferenceAnswer({ referenceAnswer, coreLesson: 'Hold the angle.' }),
    ).toEqual({ kind: 'distinct', value: referenceAnswer });
  });
});
