import { FsrsService, type ShortTermReviewMode } from '../fsrs';
import { finishIntakeCommit, replayIntakeCommit, type IntakeCommit } from './intake-commits';
import { LEARNING_COMMIT_STORES } from './learning-commits';
import { CATEGORY_CATALOG_META_KEY } from '../models/category';
import { isNoteRecord, noteContent, type NoteRecord } from '../models/note';
import {
  contentFingerprint,
  questionIssue,
  readIntakeCategoryMap,
  resolveIntakeCategory,
  validateIntakePackage,
  type IntakeSelection,
} from '../intake/package';
import { DatabaseError } from './errors';
import { isIntakeReceipt, type IntakeReceipt, type IntakeResult } from './intake-types';
import { itemToPersisted } from './mappers';
import { STORE_NAMES } from './migrations';
import { LEARNING_ITEM_SCHEMA_VERSION, type TextLearningItem } from './types';
import { requestResult as idbRequest, transactionComplete as idbDone } from './idb';

export function readNote(value: unknown): NoteRecord {
  if (!isNoteRecord(value)) throw new DatabaseError('INVALID_DATA', '笔记格式或日期无效。');
  return {
    ...noteContent(value),
    schemaVersion: 1,
    id: value.id,
    categoryId: value.categoryId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
export function readReceipt(value: unknown): IntakeReceipt {
  if (!isIntakeReceipt(value)) throw new DatabaseError('INVALID_DATA', '整理接收记录无效。');
  return {
    schemaVersion: 1,
    id: value.id,
    kind: value.kind,
    fingerprint: value.fingerprint,
    targetId: value.targetId,
    processedAt: value.processedAt,
    reward: value.reward,
  };
}

export async function categoryExists(
  transaction: IDBTransaction,
  categoryId: string | null,
): Promise<void> {
  if (categoryId === null) return;
  const row = (await idbRequest(
    transaction.objectStore(STORE_NAMES.meta).get(CATEGORY_CATALOG_META_KEY),
  )) as { value?: { categories?: { id: string }[] } } | undefined;
  if (!row?.value?.categories?.some((category) => category.id === categoryId)) {
    throw new DatabaseError('CONFLICT', '所选分类已不存在，请重新选择分类。');
  }
}

/** Hash and initialise schedules BEFORE opening an IDB transaction. */
export async function processIntake(
  database: IDBDatabase,
  input: IntakeSelection,
  write: boolean,
  now: Date,
  nextId: () => string,
  mode?: ShortTermReviewMode,
  commit?: IntakeCommit,
): Promise<IntakeResult> {
  const packet = validateIntakePackage(input.package);
  // Both maps cross the call boundary: every value must be an id or null. Keys that
  // match no selected record/question are ignored, exactly like the legacy record map.
  const categories = readIntakeCategoryMap(input.categories);
  const questionCategories =
    input.questionCategories === undefined ? {} : readIntakeCategoryMap(input.questionCategories);
  if (!categories || !questionCategories) throw new DatabaseError('INVALID_DATA', '分类无效。');
  const categoryChoice = { categories, questionCategories };
  const prepared = await Promise.all(
    packet.records
      .filter((record) => record.questions.length > 0)
      .map(async (record) => {
        const content = noteContent(record);
        const noteFingerprint = await contentFingerprint(['note', content]);
        const questions = await Promise.all(
          record.questions.map(async (question) => {
            const issue = questionIssue(question);
            if (issue || question.needsConfirmation)
              throw new DatabaseError(
                'INVALID_DATA',
                `“${record.title}”：${issue ?? '请先确认候选题，再选择保存。'}`,
              );
            return {
              question,
              categoryId: resolveIntakeCategory(categoryChoice, record.id, question.id),
              fingerprint: await contentFingerprint([
                'question',
                content,
                question.prompt.trim(),
                question.answer.trim(),
              ]),
            };
          }),
        );
        return { record, content, noteFingerprint, questions };
      }),
  );
  const categoryIds = new Set(
    prepared.flatMap((record) => record.questions.map((question) => question.categoryId)),
  );
  const result: IntakeResult = { entries: [], notes: 0, questions: 0, rewardReceiptIds: [] };
  // Legacy packages may contain material without questions. It remains in the
  // preview, but accepting it must not write a note, a receipt or a reward.
  if (prepared.length === 0) return result;
  const scheduler = new FsrsService({
    clock: () => now,
    ...(mode ? { shortTermReviewMode: mode } : {}),
  });
  const initialCard = scheduler.createInitialCard();
  const transaction = database.transaction(
    [
      STORE_NAMES.intakeReceipts,
      STORE_NAMES.items,
      STORE_NAMES.meta,
      ...(commit ? LEARNING_COMMIT_STORES : []),
    ],
    write ? 'readwrite' : 'readonly',
  );
  const done = idbDone(transaction);
  // Attach immediately so a native abort cannot create an unhandled rejection.
  void done.catch(() => undefined);
  try {
    if (commit) {
      const replay = await replayIntakeCommit(transaction, commit);
      if (replay) {
        await done;
        return { ...replay.result, rewardAmount: replay.rewardAmount };
      }
    }
    const receipts = transaction.objectStore(STORE_NAMES.intakeReceipts);
    const items = transaction.objectStore(STORE_NAMES.items);
    const pendingReceipts: IntakeReceipt[] = [];
    const pendingItems: TextLearningItem[] = [];
    const find = async (identity: string, fingerprint: string, kind: IntakeReceipt['kind']) => {
      const identityValue: unknown = await idbRequest(receipts.get(identity));
      if (identityValue !== undefined) {
        const receipt = readReceipt(identityValue);
        return { receipt, conflict: receipt.fingerprint !== fingerprint || receipt.kind !== kind };
      }
      const duplicateValue: unknown = await idbRequest(
        receipts.index('by-fingerprint').get(fingerprint),
      );
      const receipt =
        duplicateValue === undefined
          ? pendingReceipts.find((candidate) => candidate.fingerprint === fingerprint)
          : readReceipt(duplicateValue);
      return { receipt, conflict: false };
    };
    // Every distinct chosen category must still exist in this same transaction.
    for (const categoryId of categoryIds) await categoryExists(transaction, categoryId);
    for (const { record, content, noteFingerprint, questions } of prepared) {
      const legacySource: unknown = await idbRequest(
        receipts.index('by-fingerprint').get(noteFingerprint),
      );
      const legacyReceipt = legacySource === undefined ? undefined : readReceipt(legacySource);
      // noteId is retained for backup compatibility. New sources are complete
      // snapshots, not foreign keys; an archived/deleted note never blocks a new
      // question. Match old source content without changing its historical receipt.
      const sourceId =
        legacyReceipt?.kind === 'note' ? legacyReceipt.targetId : `source:${noteFingerprint}`;
      for (const { question, categoryId, fingerprint } of questions) {
        const identity = JSON.stringify(['question', packet.packageId, record.id, question.id]);
        const candidate = await find(identity, fingerprint, 'question');
        const conflict = candidate.conflict;
        const targetId = candidate.receipt?.targetId ?? nextId();
        const status = conflict ? 'conflict' : candidate.receipt ? 'duplicate' : 'new';
        const deleted = Boolean(
          candidate.receipt &&
          !(await idbRequest(items.getKey(targetId))) &&
          !pendingItems.some((item) => item.id === targetId),
        );
        result.entries.push({
          recordId: record.id,
          questionId: question.id,
          kind: 'question',
          status,
          targetId,
          deleted,
        });
        if (status === 'new') {
          result.questions++;
          pendingItems.push({
            schemaVersion: LEARNING_ITEM_SCHEMA_VERSION,
            id: targetId,
            sourceType: 'text',
            title: Array.from(question.prompt.trim()).slice(0, 80).join(''),
            categoryId,
            itemType: 'Understand',
            personalNote: '',
            situation: '',
            coreLesson: question.answer.trim(),
            mistakeToAvoid: '',
            recommendedAction: '',
            reason: '',
            recallPrompt: question.prompt.trim(),
            referenceAnswer: question.answer.trim(),
            tags: [],
            createdAt: now,
            updatedAt: now,
            fsrsCard: initialCard,
            reviewHistory: [],
            suspended: false,
            extractionDiagnostics: [],
            noteSource: { ...content, schemaVersion: 1, noteId: sourceId },
          });
          result.rewardReceiptIds.push(identity);
        }
        if (!conflict)
          pendingReceipts.push(
            candidate.receipt
              ? { ...candidate.receipt, id: identity }
              : {
                  schemaVersion: 1,
                  id: identity,
                  kind: 'question',
                  fingerprint,
                  targetId,
                  processedAt: now.toISOString(),
                  reward: 'attempted',
                },
          );
      }
    }
    if (write) {
      if (result.entries.some((entry) => entry.status === 'conflict'))
        throw new DatabaseError('CONFLICT', '有冲突题，请排除后再保存。');
      for (const item of pendingItems) items.add(itemToPersisted(item));
      for (const receipt of pendingReceipts)
        receipts.put(
          commit && pendingItems.some((item) => item.id === receipt.targetId)
            ? { ...receipt, reward: 'awarded' }
            : receipt,
        );
      if (commit) result.rewardAmount = await finishIntakeCommit(transaction, commit, result, now);
    }
    await done;
    return result;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* Already aborted or completed. */
    }
    await done.catch(() => undefined);
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError('TRANSACTION_FAILED', '保存失败，请重试。', error);
  }
}

export async function updateNoteStore(
  database: IDBDatabase,
  value: NoteRecord,
  expectedUpdatedAt: string,
): Promise<NoteRecord> {
  const note = readNote(value);
  const tx = database.transaction([STORE_NAMES.notes, STORE_NAMES.meta], 'readwrite');
  const done = idbDone(tx);
  void done.catch(() => undefined);
  try {
    const store = tx.objectStore(STORE_NAMES.notes);
    const existing: unknown = await idbRequest(store.get(note.id));
    if (existing === undefined) throw new DatabaseError('NOT_FOUND', '笔记已删除。');
    const original = readNote(existing);
    if (original.updatedAt !== expectedUpdatedAt)
      throw new DatabaseError('CONFLICT', '笔记已在另一窗口修改，请重新打开。');
    await categoryExists(tx, note.categoryId);
    const updated = { ...note, createdAt: original.createdAt };
    store.put(updated);
    await done;
    return updated;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already closed. */
    }
    await done.catch(() => undefined);
    throw error;
  }
}
