import { isNoteContent, noteContent, type NoteContent } from '../models/note';

export const INTAKE_MAX_BYTES = 1024 * 1024;
export const INTAKE_MAX_RECORDS = 50;
export const INTAKE_MAX_QUESTIONS = 200;

export interface IntakeQuestion {
  id: string;
  prompt: string;
  answer: string;
  needsConfirmation: boolean;
}
export interface IntakeRecord extends NoteContent {
  id: string;
  questions: IntakeQuestion[];
}
export interface IntakePackageV1 {
  format: 'valrecall-intake';
  version: 1;
  packageId: string;
  records: IntakeRecord[];
}
export interface IntakeSelection {
  package: IntakePackageV1;
  /** Legacy record-level categories (record id → category id, null = 未分类). */
  categories: Record<string, string | null>;
  /**
   * Per-question categories keyed by intakeQuestionKey(recordId, questionId).
   * An entry wins over `categories`; an explicit null means 未分类.
   */
  questionCategories?: Record<string, string | null>;
}

/** One stable key per candidate question, shared by the intake view, drafts and the store. */
export function intakeQuestionKey(recordId: string, questionId: string): string {
  return JSON.stringify([recordId, questionId]);
}

/**
 * Validates a category map that crossed a storage or call boundary. Values must be a
 * non-empty category id or null; keys that match no selected question are ignored by
 * callers. `emptyAsNull` lets a stored draft keep an empty id as 未分类 instead of
 * failing, because no control can show or save an empty id.
 */
export function readIntakeCategoryMap(
  value: unknown,
  { emptyAsNull = false }: { emptyAsNull?: boolean } = {},
): Record<string, string | null> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([key, id]): [string, unknown] => [key, emptyAsNull && id === '' ? null : id],
  );
  if (!entries.every((entry): entry is [string, string | null] => isCategoryId(entry[1])))
    return null;
  // fromEntries defines own data properties, so no key can reach a prototype setter.
  return Object.fromEntries(entries);
}
export function isCategoryId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value !== '');
}

/** A question's category: its own entry first (null included), then the legacy record entry. */
export function resolveIntakeCategory(
  selection: Pick<IntakeSelection, 'categories' | 'questionCategories'>,
  recordId: string,
  questionId: string,
): string | null {
  const key = intakeQuestionKey(recordId, questionId);
  if (selection.questionCategories && Object.hasOwn(selection.questionCategories, key))
    return selection.questionCategories[key] ?? null;
  return Object.hasOwn(selection.categories, recordId)
    ? (selection.categories[recordId] ?? null)
    : null;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} 应为对象。`);
  return value as Record<string, unknown>;
}
function id(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_.:-]{1,160}$/u.test(value)) {
    throw new Error(`${path} 需要 1–160 个字母、数字或 _ . : -。`);
  }
  return value;
}
function keys(row: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(row).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} 不是整理包字段，请移除后重试。`);
}

/** Strict transport validation; blank Q&A may be fixed or excluded in the preview. */
export function validateIntakePackage(value: unknown): IntakePackageV1 {
  const root = object(value, '整理包');
  keys(root, ['format', 'version', 'packageId', 'records'], '整理包');
  if (root.format !== 'valrecall-intake' || root.version !== 1)
    throw new Error('需要 valrecall-intake 第 1 版整理包；完整备份请到设置 → 备份与恢复导入。');
  if (
    !Array.isArray(root.records) ||
    root.records.length < 1 ||
    root.records.length > INTAKE_MAX_RECORDS
  )
    throw new Error('每包需要 1–50 组来源材料。');
  let total = 0;
  const recordIds = new Set<string>();
  const records = root.records.map((value, index): IntakeRecord => {
    const path = `第 ${index + 1} 组来源材料`;
    const row = object(value, path);
    keys(
      row,
      [
        'id',
        'title',
        'excerpt',
        'thought',
        'summary',
        'aiAdditions',
        'bookTitle',
        'location',
        'questions',
      ],
      path,
    );
    const recordId = id(row.id, `${path}.id`);
    if (recordIds.has(recordId)) throw new Error(`${path} 的 id 重复。`);
    recordIds.add(recordId);
    if (!isNoteContent(row)) throw new Error(`${path} 需要标题、原文或感想，其余字段须为文本。`);
    const questionValues = row.questions;
    if (!Array.isArray(questionValues))
      throw new Error(`${path}.questions 应为数组，没有候选题时用 []。`);
    total += questionValues.length;
    if (total > INTAKE_MAX_QUESTIONS) throw new Error('每包最多 200 道候选题。');
    const questionIds = new Set<string>();
    const questions = questionValues.map((value, questionIndex): IntakeQuestion => {
      const questionPath = `${path} · 第 ${questionIndex + 1} 题`;
      const q = object(value, questionPath);
      keys(q, ['id', 'prompt', 'answer', 'needsConfirmation'], questionPath);
      const questionId = id(q.id, `${questionPath}.id`);
      if (questionIds.has(questionId)) throw new Error(`${questionPath} 的 id 重复。`);
      questionIds.add(questionId);
      if (
        typeof q.prompt !== 'string' ||
        typeof q.answer !== 'string' ||
        typeof q.needsConfirmation !== 'boolean'
      )
        throw new Error(`${questionPath} 需要文本 prompt / answer 和布尔值 needsConfirmation。`);
      return {
        id: questionId,
        prompt: q.prompt,
        answer: q.answer,
        needsConfirmation: q.needsConfirmation,
      };
    });
    return { id: recordId, ...noteContent(row), questions };
  });
  const result: IntakePackageV1 = {
    format: 'valrecall-intake',
    version: 1,
    packageId: id(root.packageId, 'packageId'),
    records,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > INTAKE_MAX_BYTES)
    throw new Error('整理包超过 1 MiB，请拆成更小的文件。');
  return result;
}

export function parseIntakePackage(text: string): IntakePackageV1 {
  if (new TextEncoder().encode(text).byteLength > INTAKE_MAX_BYTES)
    throw new Error('整理包超过 1 MiB。');
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1]! : trimmed) as unknown;
  } catch {
    throw new Error('无法读取 JSON，请只粘贴整理包本身。');
  }
  return validateIntakePackage(value);
}

export function questionIssue(question: IntakeQuestion): string | null {
  if (!question.prompt.trim()) return '回忆问题不能为空。';
  if (!question.answer.trim()) return '参考答案不能为空。';
  if (question.prompt.trim() === question.answer.trim())
    return '问题与答案相同，请改为能主动回忆的问题。';
  return null;
}

export async function contentFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
