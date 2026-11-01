import { consumeDraft, type DraftToken } from './drafts';
import { DatabaseError } from './errors';
import { requestResult } from './idb';
import { STORE_NAMES } from './migrations';
import type { IntakeResult } from './intake-types';
import { putWallet, walletInTransaction } from './wallet';
import { applyIntakeReward } from '../shared/allowance';

export interface IntakeCommit {
  id: string;
  fingerprint: string;
  draft?: DraftToken;
}
export interface IntakeCommitReceipt {
  schemaVersion: 1;
  kind: 'intake';
  id: string;
  fingerprint: string;
  committedAt: string;
  result: IntakeResult;
  rewardAmount: number;
}
export function readIntakeCommit(value: unknown): IntakeCommitReceipt {
  if (!value || typeof value !== 'object')
    throw new DatabaseError('INVALID_DATA', '整理保存凭据无效。');
  const row = value as Record<string, unknown>;
  const result = row.result as Partial<IntakeResult> | undefined;
  if (
    row.schemaVersion !== 1 ||
    row.kind !== 'intake' ||
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.fingerprint !== 'string' ||
    !row.fingerprint ||
    typeof row.committedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.committedAt)) ||
    typeof row.rewardAmount !== 'number' ||
    !Number.isSafeInteger(row.rewardAmount) ||
    row.rewardAmount < 0 ||
    !result ||
    !Array.isArray(result.entries) ||
    !Array.isArray(result.rewardReceiptIds) ||
    !result.rewardReceiptIds.every((id) => typeof id === 'string') ||
    !Number.isSafeInteger(result.questions) ||
    Number(result.questions) < 0 ||
    result.notes !== 0 ||
    !result.entries.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const e = entry as Record<string, unknown>;
      return (
        typeof e.recordId === 'string' &&
        typeof e.questionId === 'string' &&
        e.kind === 'question' &&
        ['new', 'duplicate', 'conflict'].includes(String(e.status)) &&
        typeof e.targetId === 'string' &&
        typeof e.deleted === 'boolean'
      );
    })
  )
    throw new DatabaseError('INVALID_DATA', '整理保存凭据字段无效。');
  return row as unknown as IntakeCommitReceipt;
}
export async function replayIntakeCommit(
  tx: IDBTransaction,
  commit: IntakeCommit,
): Promise<IntakeCommitReceipt | undefined> {
  const value: unknown = await requestResult(
    tx.objectStore(STORE_NAMES.learningReceipts).get(commit.id),
  );
  if (value === undefined) return undefined;
  const receipt = readIntakeCommit(value);
  if (receipt.fingerprint !== commit.fingerprint)
    throw new DatabaseError('CONFLICT', '这份整理已按旧内容保存过，请先到资料库查看。');
  return receipt;
}
export async function finishIntakeCommit(
  tx: IDBTransaction,
  commit: IntakeCommit,
  result: IntakeResult,
  at: Date,
): Promise<number> {
  const wallet = await walletInTransaction(tx);
  const reward = applyIntakeReward(wallet, 0, result.questions, at);
  if (result.questions > 0) putWallet(tx, reward.state);
  await consumeDraft(tx, commit.draft);
  tx.objectStore(STORE_NAMES.learningReceipts).add({
    schemaVersion: 1,
    kind: 'intake',
    id: commit.id,
    fingerprint: commit.fingerprint,
    committedAt: at.toISOString(),
    result,
    rewardAmount: reward.result.amount,
  } satisfies IntakeCommitReceipt);
  return reward.result.amount;
}
