export type LegacyReasonKind = 'none' | 'duplicate' | 'distinct';

export interface LegacyReason {
  kind: LegacyReasonKind;
  value: string;
}

interface LegacyReasonComparison {
  reason: string;
  coreLesson: string;
  referenceAnswer: string;
  situation?: string;
  mistakeToAvoid?: string;
  recommendedAction?: string;
  subtitleBefore?: readonly string[];
  subtitleCurrent?: readonly string[];
  subtitleAfter?: readonly string[];
}

/** Comparison-only normalization. The stored compatibility value is never rewritten here. */
export function normalizeLegacyReasonWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function classifyLegacyReason(input: LegacyReasonComparison): LegacyReason {
  const normalizedReason = normalizeLegacyReasonWhitespace(input.reason);
  if (!normalizedReason) return { kind: 'none', value: input.reason };

  const before = normalizedLines(input.subtitleBefore ?? []);
  const current = normalizedLines(input.subtitleCurrent ?? []);
  const after = normalizedLines(input.subtitleAfter ?? []);
  const candidates = [
    input.coreLesson,
    input.referenceAnswer,
    input.situation ?? '',
    input.mistakeToAvoid ?? '',
    input.recommendedAction ?? '',
    ...before,
    ...current,
    ...after,
    current.join(' '),
    [...before, ...after].join(' '),
    [...before, ...current, ...after].join(' '),
  ].map(normalizeLegacyReasonWhitespace);

  return candidates.some((candidate) => candidate && candidate === normalizedReason)
    ? { kind: 'duplicate', value: input.reason }
    : { kind: 'distinct', value: input.reason };
}

function normalizedLines(lines: readonly string[]): string[] {
  return lines.map(normalizeLegacyReasonWhitespace).filter(Boolean);
}
