import type { Card } from 'ts-fsrs';

import type { NewVideoLearningItem } from '../database/types';
import { looksLikeSubtitleSettingsText } from '../generators/RuleBasedLearningItemGenerator';
import type {
  CaptureDraft,
  LearningItemDraftFields,
  LearningItemType,
} from '../models/learning-item';

export const AUTOMATIC_PREVIEW_DELAY_MS = 180;

export interface LearningGoalDetails {
  value: LearningItemType;
  description: string;
  localisedDescription: string;
}

export const LEARNING_GOALS: readonly LearningGoalDetails[] = [
  {
    value: 'Avoid',
    description: '需要避免的错误行为。',
    localisedDescription: '需要避免的错误行为。',
  },
  {
    value: 'Do',
    description: '需要主动执行的正确行为。',
    localisedDescription: '需要主动执行的正确行为。',
  },
  {
    value: 'Notice',
    description: '需要识别的信号、规律或情境。',
    localisedDescription: '需要识别的信号、规律或情境。',
  },
  {
    value: 'Understand',
    description: '需要理解和解释的原理。',
    localisedDescription: '需要理解和解释的原理。',
  },
] as const;

export interface SubtitleSourceSummary {
  reliable: boolean;
  label: string;
  tone: 'success' | 'warning';
}

export function summariseSubtitleSource(draft: CaptureDraft): SubtitleSourceSummary {
  if (draft.subtitleStatus === 'timed_context') {
    const source =
      draft.subtitleExtractionStrategy === 'text_track_timed_cues'
        ? 'HTML text track'
        : 'timestamped transcript';
    return {
      reliable: true,
      label: `Nearby timed captions · ${source} · ${draft.subtitleConfidence} confidence`,
      tone: 'success',
    };
  }
  if (draft.subtitleStatus === 'current_only') {
    return {
      reliable: true,
      label: `Current visible caption · video overlay · ${draft.subtitleConfidence} confidence`,
      tone: 'warning',
    };
  }
  if (hasSubtitleDiagnostic(draft, 'subtitles-available-unreadable')) {
    return {
      reliable: false,
      label: 'Captions available but unreadable',
      tone: 'warning',
    };
  }
  if (hasSubtitleDiagnostic(draft, 'no-subtitles-available')) {
    return {
      reliable: false,
      label: 'Possible burned-in captions · OCR unavailable',
      tone: 'warning',
    };
  }
  return {
    reliable: false,
    label: 'No nearby caption context',
    tone: 'warning',
  };
}

export function subtitleUnavailableMessage(draft: CaptureDraft): string {
  if (hasSubtitleDiagnostic(draft, 'subtitles-available-unreadable')) {
    return 'Player captions were available but could not be read at this moment.';
  }
  if (hasSubtitleDiagnostic(draft, 'no-subtitles-available')) {
    return 'The caption appears to be part of the video image and cannot be read without OCR.';
  }
  return 'No reliable nearby caption context was accessible at this moment.';
}

function hasSubtitleDiagnostic(draft: CaptureDraft, strategy: string): boolean {
  return draft.extractionDiagnostics.some(
    (entry) => entry.field === 'subtitles' && entry.strategy === strategy,
  );
}

export function scheduleAutomaticPreview(
  task: () => void | Promise<void>,
  delayMilliseconds = AUTOMATIC_PREVIEW_DELAY_MS,
): () => void {
  const timer = globalThis.setTimeout(() => void task(), delayMilliseconds);
  return () => globalThis.clearTimeout(timer);
}

export function keyTakeawayValidationMessage(coreLesson: string): string | null {
  const candidate = coreLesson.trim();
  if (candidate.length < 3 || !/[\p{L}\p{N}]/u.test(candidate)) {
    return '保存前请用自己的话写下关键收获。';
  }
  if (looksLikeSubtitleSettingsText(candidate)) {
    return '这是字幕设置文字，请用自己的话写收获。';
  }
  return null;
}

export function recallPromptValidationMessage(recallPrompt: string): string | null {
  return recallPrompt.trim().length > 0 ? null : '保存前请填写回忆提示。';
}

export function buildScheduledLearningItemInput(input: {
  draft: CaptureDraft;
  videoTitle: string;
  itemType: LearningItemType;
  coreLesson: string;
  categoryId: string | null;
  fields: LearningItemDraftFields;
  fsrsCard: Card;
}): NewVideoLearningItem {
  const { draft, videoTitle, itemType, coreLesson, categoryId, fields, fsrsCard } = input;
  return {
    id: draft.draftId,
    platform: draft.platform,
    sourceUrl: draft.sourceUrl,
    canonicalUrl: draft.canonicalUrl,
    videoId: draft.videoId,
    videoTitle: videoTitle.trim(),
    uploader: draft.uploader,
    description: draft.description,
    timestampSeconds: draft.timestampSeconds,
    timestampDisplay: draft.timestampDisplay,
    videoDurationSeconds: draft.videoDurationSeconds,
    chapterTitle: draft.chapterTitle,
    subtitleBefore: draft.subtitleBefore,
    subtitleCurrent: draft.subtitleCurrent,
    subtitleAfter: draft.subtitleAfter,
    subtitleCueData: draft.subtitleCueData,
    categoryId,
    itemType,
    ...fields,
    personalNote: '',
    coreLesson: coreLesson.trim(),
    // Existing readers still expect this compatibility field. New Capture has
    // one authored answer, so it always mirrors the canonical Key takeaway.
    referenceAnswer: coreLesson.trim(),
    tags: fields.tags.map((tag) => tag.trim()).filter(Boolean),
    extractionDiagnostics: draft.extractionDiagnostics,
    fsrsCard,
    suspended: false,
  };
}
