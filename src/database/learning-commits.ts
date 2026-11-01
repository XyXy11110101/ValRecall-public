import { consumeCaptureSource } from './pending-capture';
import { localDateKey } from '../models/daily-task';
import {
  applyCaptureReward,
  applyManualMomentReward,
  type CaptureAllowanceResult,
} from '../shared/allowance';
import { contentFingerprint } from '../intake/package';
import { consumeDraft, type DraftToken } from './drafts';
import { DatabaseError } from './errors';
import { requestResult, transactionComplete } from './idb';
import { STORE_NAMES } from './migrations';
import type { LearningItem } from './types';
import { putWallet, walletInTransaction, type DatabaseOpener } from './wallet';

export type CaptureRewardSummary = Omit<CaptureAllowanceResult, 'state'>;
export interface LearningCommit {
  id: string;
  fingerprint: string;
  kind: 'manual' | 'capture';
  draft?: DraftToken;
  captureId?: string;
}
export interface LearningReceipt {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  kind: LearningCommit['kind'];
  committedAt: string;
  itemId: string;
  capture: CaptureRewardSummary | null;
  manualReward: number | null;
}
export const LEARNING_COMMIT_STORES = [
  STORE_NAMES.wallet,
  STORE_NAMES.learningReceipts,
  STORE_NAMES.drafts,
];

export async function learningFingerprint(value: unknown, image?: Blob): Promise<string> {
  let media: string | null = null;
  if (image) {
    const buffer =
      typeof image.arrayBuffer === 'function'
        ? await image.arrayBuffer()
        : await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              reader.result instanceof ArrayBuffer
                ? resolve(reader.result)
                : reject(new Error('图片读取失败。'));
            reader.onerror = () => reject(new Error('图片读取失败。'));
            reader.readAsArrayBuffer(image);
          });
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    media = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return contentFingerprint([value, media]);
}

export function readLearningReceipt(value: unknown): LearningReceipt {
  if (typeof value !== 'object' || value === null)
    throw new DatabaseError('INVALID_DATA', '保存凭据无效。');
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.id !== 'string' ||
    !row.id ||
    typeof row.fingerprint !== 'string' ||
    !row.fingerprint ||
    !['manual', 'capture'].includes(String(row.kind)) ||
    typeof row.committedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.committedAt))
  )
    throw new DatabaseError('INVALID_DATA', '保存凭据格式无效。');
  if (typeof row.itemId !== 'string' || !row.itemId)
    throw new DatabaseError('INVALID_DATA', '保存凭据条目身份无效。');
  let capture: CaptureRewardSummary | null = null;
  if (row.kind === 'capture') {
    if (typeof row.capture !== 'object' || row.capture === null)
      throw new DatabaseError('INVALID_DATA', '捕获奖励凭据无效。');
    const reward = row.capture as Record<string, unknown>;
    if (
      reward.captureReward !== 2 ||
      typeof reward.checkIn !== 'boolean' ||
      typeof reward.checkInReward !== 'number' ||
      !Number.isSafeInteger(reward.checkInReward) ||
      reward.checkInReward < 0 ||
      typeof reward.praise !== 'string' ||
      !(reward.checkInPraise === null || typeof reward.checkInPraise === 'string') ||
      row.manualReward !== null
    )
      throw new DatabaseError('INVALID_DATA', '捕获奖励凭据无效。');
    capture = {
      captureReward: 2,
      checkIn: reward.checkIn,
      checkInReward: reward.checkInReward,
      praise: reward.praise,
      checkInPraise: reward.checkInPraise,
    };
  } else if (row.manualReward !== 3 || row.capture !== null)
    throw new DatabaseError('INVALID_DATA', '手动奖励凭据无效。');
  return {
    schemaVersion: 1,
    id: row.id,
    fingerprint: row.fingerprint,
    kind: row.kind as LearningCommit['kind'],
    committedAt: row.committedAt,
    itemId: row.itemId,
    capture,
    manualReward: row.manualReward as number | null,
  };
}

export async function replayLearningCommit(
  transaction: IDBTransaction,
  commit?: LearningCommit,
): Promise<LearningReceipt | undefined> {
  if (!commit) return undefined;
  const value: unknown = await requestResult(
    transaction.objectStore(STORE_NAMES.learningReceipts).get(commit.id),
  );
  if (value === undefined) return undefined;
  const receipt = readLearningReceipt(value);
  if (receipt.fingerprint !== commit.fingerprint || receipt.kind !== commit.kind)
    throw new DatabaseError('CONFLICT', '这条内容已按旧版本保存过，请到资料库查看。');
  return receipt;
}

export async function finishLearningCommit(
  transaction: IDBTransaction,
  item: LearningItem,
  at: Date,
  commit?: LearningCommit,
): Promise<void> {
  if (!commit) return;
  const wallet = await walletInTransaction(transaction);
  const capture =
    commit.kind === 'capture'
      ? applyCaptureReward(wallet, localDateKey(at), at.toISOString())
      : null;
  const manual =
    commit.kind === 'manual'
      ? applyManualMomentReward(wallet, localDateKey(at), at.toISOString())
      : null;
  const next = capture?.state ?? manual!.state;
  putWallet(transaction, next);
  await consumeDraft(transaction, commit.draft);
  if (commit.captureId) await consumeCaptureSource(transaction, commit.captureId);
  const summary = capture
    ? {
        captureReward: capture.captureReward,
        checkIn: capture.checkIn,
        checkInReward: capture.checkInReward,
        praise: capture.praise,
        checkInPraise: capture.checkInPraise,
      }
    : null;
  transaction.objectStore(STORE_NAMES.learningReceipts).add({
    schemaVersion: 1,
    id: commit.id,
    fingerprint: commit.fingerprint,
    kind: commit.kind,
    committedAt: at.toISOString(),
    itemId: item.id,
    capture: summary,
    manualReward: manual?.reward ?? null,
  } satisfies LearningReceipt);
}

export async function getLearningReceipt(
  database: DatabaseOpener,
  id: string,
): Promise<LearningReceipt | undefined> {
  const tx = (await database.open()).transaction(STORE_NAMES.learningReceipts, 'readonly');
  const done = transactionComplete(tx);
  const value: unknown = await requestResult(tx.objectStore(STORE_NAMES.learningReceipts).get(id));
  await done;
  return value === undefined ? undefined : readLearningReceipt(value);
}
