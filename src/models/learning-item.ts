import type {
  ExtractionDiagnostic,
  SubtitleConfidence,
  SubtitleCueData,
  SubtitleExtractionStrategy,
  SubtitleStatus,
  VideoBounds,
} from './extraction';
import type { ValidationIssue, ValidationResult } from '../shared/result';
import { validationResult } from '../shared/result';
import { isValidTimeSeconds } from '../shared/time';
import type { VideoPlatform } from './platform';

export const LEARNING_ITEM_SCHEMA_VERSION = 4 as const;
// Capture messages retain their existing shape independently of stored Moments.
export const CAPTURE_DRAFT_SCHEMA_VERSION = 2 as const;

export const LEARNING_ITEM_TYPES = ['Avoid', 'Do', 'Notice', 'Understand'] as const;
export type LearningItemType = (typeof LEARNING_ITEM_TYPES)[number];

export function learningGoalLabel(type: LearningItemType): string {
  switch (type) {
    case 'Avoid':
      return '避免';
    case 'Do':
      return '去做';
    case 'Notice':
      return '留意';
    case 'Understand':
      return '理解';
  }
}

export interface LearningItemDraftFields {
  situation: string;
  coreLesson: string;
  mistakeToAvoid: string;
  recommendedAction: string;
  reason: string;
  recallPrompt: string;
  referenceAnswer: string;
  tags: string[];
}

export interface CaptureDraft {
  draftId: string;
  schemaVersion: 1 | typeof CAPTURE_DRAFT_SCHEMA_VERSION;
  platform: VideoPlatform;
  sourceUrl: string;
  canonicalUrl: string | null;
  videoId: string | null;
  videoTitle: string | null;
  uploader: string | null;
  description: string | null;
  timestampSeconds: number;
  timestampDisplay: string;
  videoDurationSeconds: number | null;
  chapterTitle: string | null;
  videoBounds: VideoBounds | null;
  screenshotDataUrl: string | null;
  subtitleBefore: string[];
  subtitleCurrent: string[];
  subtitleAfter: string[];
  subtitleCueData: SubtitleCueData[];
  subtitleStatus: SubtitleStatus;
  subtitleExtractionStrategy: SubtitleExtractionStrategy;
  subtitleConfidence: SubtitleConfidence;
  capturedAt: string;
  extractionDiagnostics: ExtractionDiagnostic[];
}

export interface LearningItemValidationInput extends Partial<LearningItemDraftFields> {
  itemType?: unknown;
  sourceUrl?: unknown;
  timestampSeconds?: unknown;
  /** @deprecated Accepted only for compatibility with legacy validation callers. */
  personalNote?: unknown;
  subtitleBefore?: unknown;
  subtitleCurrent?: unknown;
  subtitleAfter?: unknown;
}

export interface TextMomentValidationInput extends LearningItemValidationInput {
  title?: unknown;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function validateLearningItemDraft(input: LearningItemValidationInput): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!LEARNING_ITEM_TYPES.includes(input.itemType as LearningItemType)) {
    issues.push({
      field: 'itemType',
      code: 'INVALID_ITEM_TYPE',
      message: '请选择一个学习目标。',
    });
  }

  if (!nonEmpty(input.coreLesson)) {
    issues.push({
      field: 'coreLesson',
      code: 'CORE_LESSON_REQUIRED',
      message: '请填写你想记住的关键收获。',
    });
  }

  if (!nonEmpty(input.recallPrompt)) {
    issues.push({
      field: 'recallPrompt',
      code: 'RECALL_PROMPT_REQUIRED',
      message: '请填写回忆提示。',
    });
  }

  if (input.referenceAnswer !== undefined && typeof input.referenceAnswer !== 'string') {
    issues.push({
      field: 'referenceAnswer',
      code: 'INVALID_REFERENCE_ANSWER',
      message: 'The compatibility answer must be text.',
    });
  }

  if (input.sourceUrl !== undefined) {
    if (!nonEmpty(input.sourceUrl) || !isHttpUrl(input.sourceUrl)) {
      issues.push({
        field: 'sourceUrl',
        code: 'INVALID_SOURCE_URL',
        message: 'The source URL is invalid.',
      });
    }
  }

  if (input.timestampSeconds !== undefined && !isValidTimeSeconds(input.timestampSeconds)) {
    issues.push({
      field: 'timestampSeconds',
      code: 'INVALID_TIMESTAMP',
      message: 'The timestamp must be a non-negative number.',
    });
  }

  if (
    input.tags !== undefined &&
    (!Array.isArray(input.tags) || input.tags.some((tag) => !nonEmpty(tag)))
  ) {
    issues.push({
      field: 'tags',
      code: 'INVALID_TAGS',
      message: 'Tags must be non-empty text values.',
    });
  }

  return validationResult(issues);
}

export function validateTextMomentDraft(input: TextMomentValidationInput): ValidationResult {
  const issues = [...validateLearningItemDraft(input).issues];
  if (!nonEmpty(input.title)) {
    issues.unshift({
      field: 'title',
      code: 'TITLE_REQUIRED',
      message: 'A title is required.',
    });
  }
  return validationResult(issues);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
