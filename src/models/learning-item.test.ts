import { describe, expect, it } from 'vitest';

import { validateLearningItemDraft } from './learning-item';

describe('validateLearningItemDraft', () => {
  const validDraft = {
    itemType: 'Do' as const,
    coreLesson: 'Wait for utility before moving.',
    recallPrompt: 'What action should you take in this situation?',
    referenceAnswer: 'Wait for utility before moving.',
    sourceUrl: 'https://www.bilibili.com/video/BV1abc123',
    timestampSeconds: 42,
    tags: ['bilibili', 'do'],
  };

  it('accepts a complete conservative draft', () => {
    expect(validateLearningItemDraft(validDraft)).toEqual({ valid: true, issues: [] });
  });

  it('requires the canonical Key takeaway but permits an empty compatibility answer', () => {
    const result = validateLearningItemDraft({
      ...validDraft,
      coreLesson: '',
      referenceAnswer: '',
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['CORE_LESSON_REQUIRED']);
  });

  it('requires only Key takeaway and Recall prompt for the recall contract', () => {
    expect(
      validateLearningItemDraft({
        ...validDraft,
        referenceAnswer: '',
      }),
    ).toEqual({ valid: true, issues: [] });
  });

  it('rejects invalid URLs, timestamps, types and tags', () => {
    const result = validateLearningItemDraft({
      ...validDraft,
      itemType: 'Guess',
      sourceUrl: 'not a url',
      timestampSeconds: -2,
      tags: [''],
      referenceAnswer: 42 as unknown as string,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'INVALID_ITEM_TYPE',
        'INVALID_SOURCE_URL',
        'INVALID_TIMESTAMP',
        'INVALID_TAGS',
        'INVALID_REFERENCE_ANSWER',
      ]),
    );
  });
});
