import type { LearningItem, MomentCategory } from '../database';
import { ManualQuestionForm } from '../authoring/ManualQuestionForm';
import type { ManualQuestionReceipt } from '../authoring/save-manual';
import type { ManualQuestionDraft } from '../authoring/manual-draft';
import type { ShortTermReviewMode } from '../fsrs';
import type { ValRecallPreferences } from '../shared/preferences';
import type { saveReading } from './save-reading';

export interface ReadingCaptureProps {
  active?: boolean;
  preferences?: ValRecallPreferences;
  onSaved?: (item: LearningItem) => void;
  onViewItem?: (id: string) => void;
  onReceive?: () => void;
  save?: typeof saveReading;
  loadCategories?: () => Promise<MomentCategory[]>;
}

/** The side panel shares the authoring form while keeping its reading-only entry. */
export function ReadingCapture({ save, ...props }: ReadingCaptureProps) {
  const saveAdapter = save
    ? async (
        draft: ManualQuestionDraft,
        mode: ShortTermReviewMode,
      ): Promise<ManualQuestionReceipt> => ({
        ...(await save(draft, mode)),
        manualReward: null,
      })
    : undefined;
  return (
    <ManualQuestionForm {...props} readingOnly {...(saveAdapter ? { save: saveAdapter } : {})} />
  );
}
