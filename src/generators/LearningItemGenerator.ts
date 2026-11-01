import type { LearningItemDraftFields, LearningItemType } from '../models/learning-item';
import type { VideoPlatform } from '../models/platform';
import type { ValidationResult } from '../shared/result';

export type GenerationSource = 'key-takeaway' | 'none';

export interface LearningItemGenerationInput {
  platform: VideoPlatform;
  itemType: LearningItemType;
  coreLesson: string;
  /** Source context retained at the generator boundary for capture compatibility only. */
  subtitleReliable?: boolean;
  subtitleBefore: string[];
  subtitleCurrent: string[];
  subtitleAfter: string[];
  videoTitle: string | null;
  chapterTitle: string | null;
}

export interface LearningItemGenerationResult {
  fields: LearningItemDraftFields;
  validation: ValidationResult;
  sourceUsed: GenerationSource;
  warnings: string[];
}

/** Async by design so a future, secure remote implementation can use the same boundary. */
export interface LearningItemGenerator {
  generate(input: LearningItemGenerationInput): Promise<LearningItemGenerationResult>;
}
