import {
  DatabaseError,
  ValRecallRepository,
  type LearningItem,
  type NewTextLearningItem,
} from '../database';
import { FsrsService } from '../fsrs';
import type { ShortTermReviewMode } from '../fsrs';
import { recordSuccessfulCapture, type CaptureAllowanceResult } from '../shared/allowance';
import { rewardsVisible } from '../edition/rewards';
import { hasExtensionRuntime } from '../shared/extension';
import { readingDraftIssue, readingTitle, type ReadingDraft } from './reading-draft';

export interface ReadingReceipt {
  item: LearningItem;
  allowance: CaptureAllowanceResult | null;
  warning: string | null;
}

export interface ReadingSaveDependencies {
  create: (input: NewTextLearningItem) => Promise<LearningItem>;
  get: (id: string) => Promise<LearningItem | undefined>;
  reward: () => Promise<CaptureAllowanceResult | null>;
  clock?: () => Date;
}

const repository = new ValRecallRepository();
const defaultDependencies: ReadingSaveDependencies = {
  create: (input) => repository.createTextItem(input),
  get: (id) => repository.getItem(id),
  reward: () => (hasExtensionRuntime() ? recordSuccessfulCapture() : Promise.resolve(null)),
};

export async function saveReading(
  draft: ReadingDraft,
  mode: ShortTermReviewMode,
  dependencies: ReadingSaveDependencies = defaultDependencies,
): Promise<ReadingReceipt> {
  const issue = readingDraftIssue(draft);
  if (issue) throw new Error(issue);
  let item: LearningItem;
  try {
    item = await dependencies.create({
      id: draft.id,
      title: readingTitle(draft.recallPrompt),
      itemType: draft.itemType,
      coreLesson: draft.coreLesson.trim(),
      recallPrompt: draft.recallPrompt.trim(),
      referenceAnswer: draft.coreLesson.trim(),
      categoryId: draft.categoryId,
      readingSource: {
        schemaVersion: 1,
        excerpt: draft.excerpt,
        bookTitle: draft.bookTitle.trim(),
        location: draft.location.trim(),
      },
      fsrsCard: new FsrsService({
        shortTermReviewMode: mode,
        ...(dependencies.clock ? { clock: dependencies.clock } : {}),
      }).createInitialCard(),
    });
  } catch (caught) {
    if (!(caught instanceof DatabaseError) || caught.code !== 'CONFLICT') throw caught;
    const existing = await dependencies.get(draft.id);
    if (existing?.sourceType !== 'text' || !existing.readingSource) throw caught;
    // An earlier write may have succeeded despite an interrupted response. Never
    // grant again, overwrite that write, or create a new item during recovery.
    return {
      item: existing,
      allowance: null,
      warning: '这条摘录已保存过。',
    };
  }
  try {
    return { item, allowance: await dependencies.reward(), warning: null };
  } catch {
    return {
      item,
      allowance: null,
      warning:
        __VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()
          ? null
          : '已保存，但奖励未能确认，请查看账本。',
    };
  }
}
