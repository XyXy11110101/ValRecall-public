import { contentFingerprint } from './package';
import type { DraftToken } from '../database/drafts';
import { ValRecallRepository } from '../database';
import type { IntakeResult } from '../database/intake-types';
import type { ShortTermReviewMode } from '../fsrs';
import { recordSuccessfulIntake } from '../shared/allowance';
import { rewardsVisible } from '../edition/rewards';
import type { IntakeSelection } from './package';

export interface IntakeSaveReceipt extends Omit<IntakeResult, 'rewardAmount'> {
  rewardAmount: number | null;
  warning: string | null;
}
export interface IntakeSaveDependencies {
  receive: (selection: IntakeSelection, mode: ShortTermReviewMode) => Promise<IntakeResult>;
  finish: (ids: string[], state: 'awarded') => Promise<void>;
  reward: (notes: number, questions: number) => Promise<{ amount: number }>;
}
const repository = new ValRecallRepository();
const defaults: IntakeSaveDependencies = {
  receive: (selection, mode) => repository.receiveIntake(selection, mode),
  finish: (ids, state) => repository.finishIntakeReward(ids, state),
  reward: recordSuccessfulIntake,
};

export async function saveIntake(
  selection: IntakeSelection,
  mode: ShortTermReviewMode,
  dependencies = defaults,
  draft?: DraftToken,
): Promise<IntakeSaveReceipt> {
  if (dependencies === defaults) {
    const fingerprint = await contentFingerprint([selection, mode]);
    const result = await repository.receiveAtomicIntake(selection, mode, {
      id: draft?.id ?? 'intake:' + fingerprint,
      fingerprint,
      ...(draft ? { draft } : {}),
    });
    return {
      ...result,
      rewardAmount: result.rewardAmount ?? 0,
      warning: result.questions === 0 ? '这些题目都已接收过。' : null,
    };
  }
  // Explicit injected ports are used by synthetic previews and legacy adapter tests.
  // The transaction marks new receipts attempted BEFORE crossing the storage boundary.
  const result = await dependencies.receive(selection, mode);
  if (result.rewardReceiptIds.length === 0)
    return {
      ...result,
      rewardAmount: 0,
      warning: result.entries.length === 0 ? '没有可保存的题目。' : '这些题目都已接收过。',
    };
  try {
    const reward = await dependencies.reward(result.notes, result.questions);
    await dependencies.finish(result.rewardReceiptIds, 'awarded');
    return { ...result, rewardAmount: reward.amount, warning: null };
  } catch {
    return {
      ...result,
      rewardAmount: null,
      warning:
        __VALRECALL_PUBLIC_RELEASE__ && !rewardsVisible()
          ? null
          : '已保存，但奖励未能确认，请查看账本。',
    };
  }
}
