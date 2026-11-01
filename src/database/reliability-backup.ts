import { base64ToBlob, blobToBase64, importRecord } from './backup';
import { readDraft, type DraftValue, type LocalDraft } from './drafts';
import { DatabaseError } from './errors';
import { readIntakeCommit, type IntakeCommitReceipt } from './intake-commits';
import { readLearningReceipt, type LearningReceipt } from './learning-commits';
import { readReviewSession, type DurableReviewSession } from './review-sessions';
import { STORE_NAMES } from './migrations';
import { requestResult } from './idb';

type EncodedValue =
  | { type: 'value'; value: null | string | number | boolean }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'array'; entries: EncodedValue[] }
  | { type: 'object'; entries: [string, EncodedValue][] };
export interface ExportedDraft extends Omit<LocalDraft, 'payload'> {
  payload: EncodedValue;
}
export interface ReliabilityBackup {
  drafts: ExportedDraft[];
  learningReceipts: (LearningReceipt | IntakeCommitReceipt)[];
  reviewSessions: DurableReviewSession[];
}
export interface ImportedReliability extends Omit<ReliabilityBackup, 'drafts'> {
  drafts: LocalDraft[];
}

async function encode(value: DraftValue): Promise<EncodedValue> {
  if (value instanceof Blob)
    return { type: 'image', mimeType: value.type, data: await blobToBase64(value) };
  if (Array.isArray(value)) return { type: 'array', entries: await Promise.all(value.map(encode)) };
  if (value !== null && typeof value === 'object')
    return {
      type: 'object',
      entries: await Promise.all(
        Object.entries(value).map(async ([key, entry]): Promise<[string, EncodedValue]> => [
          key,
          await encode(entry),
        ]),
      ),
    };
  return { type: 'value', value };
}
function decode(value: unknown, depth = 0): DraftValue {
  if (depth > 32) throw new DatabaseError('INVALID_DATA', '草稿层级过多。');
  const row = importRecord(value, '草稿内容');
  if (
    row.type === 'value' &&
    (row.value === null ||
      typeof row.value === 'string' ||
      typeof row.value === 'boolean' ||
      (typeof row.value === 'number' && Number.isFinite(row.value)))
  )
    return row.value;
  if (
    row.type === 'image' &&
    typeof row.data === 'string' &&
    typeof row.mimeType === 'string' &&
    /^image\/(png|jpeg|webp)$/.test(row.mimeType)
  )
    return base64ToBlob(row.data, row.mimeType, '草稿图片', 32 * 1024 * 1024);
  if (row.type === 'array' && Array.isArray(row.entries) && row.entries.length <= 20000)
    return row.entries.map((entry: unknown) => decode(entry, depth + 1));
  if (row.type === 'object' && Array.isArray(row.entries) && row.entries.length <= 20000) {
    const result: Record<string, DraftValue> = {};
    for (const entry of row.entries as unknown[]) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(entry[0]) ||
        Object.hasOwn(result, entry[0])
      )
        throw new DatabaseError('INVALID_DATA', '草稿字段无效。');
      result[entry[0]] = decode(entry[1], depth + 1);
    }
    return result;
  }
  throw new DatabaseError('INVALID_DATA', '草稿编码无效。');
}
export function readOperationReceipt(value: unknown): LearningReceipt | IntakeCommitReceipt {
  const row = importRecord(value, '学习保存凭据');
  return row.kind === 'intake' ? readIntakeCommit(row) : readLearningReceipt(row);
}
export async function exportReliability(
  draftValues: unknown[],
  receipts: unknown[],
  sessions: unknown[],
): Promise<ReliabilityBackup> {
  return {
    drafts: await Promise.all(
      draftValues.map(async (value) => {
        const row = readDraft(value);
        return { ...row, payload: await encode(row.payload) };
      }),
    ),
    learningReceipts: receipts.map(readOperationReceipt),
    reviewSessions: sessions.map(readReviewSession),
  };
}
export function importReliability(value: unknown, version: number): ImportedReliability {
  const root = importRecord(value, '备份');
  const collections = ['drafts', 'learningReceipts', 'reviewSessions'] as const;
  for (const key of collections) {
    if (
      version >= 11
        ? !Array.isArray(root[key])
        : root[key] !== undefined && (!Array.isArray(root[key]) || root[key].length > 0)
    )
      throw new DatabaseError('INVALID_DATA', '草稿与学习凭据需要完整的版本 11 备份。');
  }
  if (version < 11) return { drafts: [], learningReceipts: [], reviewSessions: [] };
  const drafts = (root.drafts as unknown[]).map((value) => {
    const row = importRecord(value, '草稿');
    return readDraft({ ...row, payload: decode(row.payload) });
  });
  const learningReceipts = (root.learningReceipts as unknown[]).map(readOperationReceipt);
  const reviewSessions = (root.reviewSessions as unknown[]).map((value) => {
    const row = readReviewSession(value);
    return { ...row, status: row.status === 'active' ? ('interrupted' as const) : row.status };
  });
  for (const values of [drafts, learningReceipts, reviewSessions])
    if (new Set(values.map((row) => row.id)).size !== values.length)
      throw new DatabaseError('INVALID_DATA', '草稿或凭据 ID 重复。');
  return { drafts, learningReceipts, reviewSessions };
}

/** Keep local anti-duplicate evidence whenever the wallet is retained. Restore never executes it. */
export async function mergeReliability(
  tx: IDBTransaction,
  input: ImportedReliability,
): Promise<void> {
  for (const [storeName, rows] of [
    [STORE_NAMES.learningReceipts, input.learningReceipts],
    [STORE_NAMES.reviewSessions, input.reviewSessions],
  ] as const) {
    const store = tx.objectStore(storeName);
    for (const row of rows) {
      const old: unknown = await requestResult(store.get(row.id));
      if (old !== undefined) {
        const record = importRecord(old, '本地凭据');
        if (
          'fingerprint' in row
            ? record.fingerprint !== row.fingerprint || record.kind !== row.kind
            : JSON.stringify(record.queue) !== JSON.stringify(row.queue) ||
              record.createdAt !== row.createdAt
        )
          throw new DatabaseError('CONFLICT', '备份凭据与本地身份冲突，未导入。');
        continue;
      }
      store.put(row);
    }
  }
  const store = tx.objectStore(STORE_NAMES.drafts);
  for (const draft of input.drafts) {
    const operationId =
      draft.scope === 'capture' && draft.id.startsWith('capture-source:')
        ? draft.id.slice('capture-source:'.length)
        : draft.id;
    if (
      (await requestResult(tx.objectStore(STORE_NAMES.learningReceipts).getKey(operationId))) !==
      undefined
    )
      continue;
    if ((await requestResult(store.getKey(draft.id))) === undefined) store.put(draft);
  }
}
