export type LegacyReferenceAnswerKind = 'none' | 'duplicate' | 'distinct';

export interface LegacyReferenceAnswer {
  kind: LegacyReferenceAnswerKind;
  value: string;
}

interface LegacyReferenceAnswerComparison {
  referenceAnswer: string;
  coreLesson: string;
}

/** Comparison-only normalization. The stored compatibility value is never rewritten here. */
export function normalizeLegacyReferenceAnswerWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function classifyLegacyReferenceAnswer(
  input: LegacyReferenceAnswerComparison,
): LegacyReferenceAnswer {
  const normalizedAnswer = normalizeLegacyReferenceAnswerWhitespace(input.referenceAnswer);
  if (!normalizedAnswer) return { kind: 'none', value: input.referenceAnswer };

  return normalizedAnswer === normalizeLegacyReferenceAnswerWhitespace(input.coreLesson)
    ? { kind: 'duplicate', value: input.referenceAnswer }
    : { kind: 'distinct', value: input.referenceAnswer };
}
