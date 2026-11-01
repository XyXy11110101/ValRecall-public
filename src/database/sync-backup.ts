import { isSyncReceipt } from '../sync/contracts';
import { isLocalDateKey } from '../models/daily-task';
import { isRecord, isSyncId } from '../sync/protocol';
import {
  occurrenceRewardAmount,
  type TaskRevision,
  type OccurrenceRevision,
  type StoredSyncReceipt,
} from './sync-repository';

export interface SyncBackup {
  receipts: StoredSyncReceipt[];
  taskRevisions: TaskRevision[];
  occurrenceRevisions: OccurrenceRevision[];
}

export function readSyncBackup(value: unknown): SyncBackup {
  if (
    !isRecord(value) ||
    !Array.isArray(value.receipts) ||
    !Array.isArray(value.taskRevisions) ||
    !Array.isArray(value.occurrenceRevisions)
  )
    throw new Error('版本 9 备份缺少同步记录。');
  const receipts = value.receipts.map((row): StoredSyncReceipt => {
    if (
      !isRecord(row) ||
      !isSyncId(row.id) ||
      !isSyncId(row.epoch) ||
      !isSyncId(row.deviceId) ||
      typeof row.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      !isSyncReceipt(row.receipt) ||
      row.receipt.operationId !== row.id
    )
      throw new Error('备份中的同步回执无效。');
    return {
      id: row.id,
      epoch: row.epoch,
      deviceId: row.deviceId,
      fingerprint: row.fingerprint,
      receipt: { ...row.receipt },
    };
  });
  const taskRevisions = value.taskRevisions.map((row): TaskRevision => {
    if (
      !isRecord(row) ||
      typeof row.taskId !== 'string' ||
      !row.taskId ||
      !isSyncId(row.revision) ||
      typeof row.deleted !== 'boolean'
    )
      throw new Error('备份中的任务版本无效。');
    return { taskId: row.taskId, revision: row.revision, deleted: row.deleted };
  });
  const occurrenceRevisions = value.occurrenceRevisions.map((row): OccurrenceRevision => {
    if (
      !isRecord(row) ||
      typeof row.taskId !== 'string' ||
      !row.taskId ||
      !isSyncId(row.revision) ||
      !isLocalDateKey(row.date) ||
      (typeof row.rewarded !== 'boolean' && row.rewarded !== null)
    )
      throw new Error('备份中的完成版本无效。');
    if (
      row.rewardAmount !== undefined &&
      row.rewardAmount !== null &&
      typeof row.rewardAmount !== 'number'
    )
      throw new Error('备份中的任务奖励金额无效。');
    const occurrence: OccurrenceRevision = {
      taskId: row.taskId,
      date: row.date,
      revision: row.revision,
      rewarded: row.rewarded,
      ...(row.rewardAmount === undefined ? {} : { rewardAmount: row.rewardAmount }),
    };
    return { ...occurrence, rewardAmount: occurrenceRewardAmount(occurrence) };
  });
  if (
    new Set(receipts.map((row) => row.id)).size !== receipts.length ||
    new Set(taskRevisions.map((row) => row.taskId)).size !== taskRevisions.length ||
    new Set(occurrenceRevisions.map((row) => JSON.stringify([row.taskId, row.date]))).size !==
      occurrenceRevisions.length
  )
    throw new Error('同步备份包含重复身份。');
  return { receipts, taskRevisions, occurrenceRevisions };
}
