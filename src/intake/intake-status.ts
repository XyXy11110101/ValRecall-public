import type { IntakeEntryResult, IntakeResult } from '../database/intake-types';
import { intakeQuestionKey, questionIssue, type IntakeQuestion } from './package';

/** Full explanation for the detail pane; directory rows only show the short label. */
export const INTAKE_CONFLICT_DETAIL = '资料库里已有同 ID 的不同内容，请排除此题。';

export type IntakeEntryIndex = ReadonlyMap<string, IntakeEntryResult>;

/** Index a check result once, by intakeQuestionKey, instead of searching it per row. */
export function indexIntakeEntries(report: IntakeResult | null): IntakeEntryIndex {
  const index = new Map<string, IntakeEntryResult>();
  for (const entry of report?.entries ?? []) {
    if (entry.kind !== 'question' || entry.questionId === undefined) continue;
    index.set(intakeQuestionKey(entry.recordId, entry.questionId), entry);
  }
  return index;
}

/**
 * Everything checked so far for one package: a newer result replaces the entries it
 * covers, and questions it did not cover (because they were unticked) keep their last
 * known outcome. Re-ticking a known duplicate or conflict therefore never reads as new.
 */
export function mergeIntakeEntries(
  previous: IntakeEntryIndex | undefined,
  report: IntakeResult,
): IntakeEntryIndex {
  const merged = new Map(previous);
  for (const [key, entry] of indexIntakeEntries(report)) merged.set(key, entry);
  return merged;
}

/**
 * An edited question that no check will cover soon (it is not selected) loses its
 * known outcome: the old content's duplicate or conflict no longer describes it.
 */
export function forgetIntakeEntry(index: IntakeEntryIndex, key: string): IntakeEntryIndex {
  if (!index.has(key)) return index;
  const next = new Map(index);
  next.delete(key);
  return next;
}

export interface IntakeQuestionStatus {
  /** One short line for the directory row. */
  label: string;
  /** The complete sentence for the detail pane. */
  detail: string;
  tone: 'muted' | 'error';
}

/**
 * A row shows its last known outcome only while it is included; an unticked row reads
 * as not selected. Untouched rows keep their wording while a new check runs, and a
 * toggled row switches at once to its local or previously known wording.
 */
export function intakeQuestionStatus(
  question: IntakeQuestion,
  included: boolean,
  entry: IntakeEntryResult | undefined,
): IntakeQuestionStatus {
  if (!included)
    return question.needsConfirmation
      ? { label: '待核实 · 未选', detail: '核实依据后再勾选。', tone: 'muted' }
      : { label: '未选', detail: '未选。', tone: 'muted' };
  const issue = questionIssue(question);
  if (issue) return { label: '需要修改', detail: `${issue}修改此题或取消选择。`, tone: 'error' };
  if (!entry) return { label: '已选', detail: '已选，正在检查。', tone: 'muted' };
  if (entry.status === 'conflict')
    return { label: '冲突', detail: INTAKE_CONFLICT_DETAIL, tone: 'error' };
  if (entry.status === 'duplicate')
    return entry.deleted
      ? { label: '已删除 · 跳过', detail: '以前接收过，已删除，将跳过。', tone: 'muted' }
      : { label: '已存在 · 跳过', detail: '已在资料库，将跳过。', tone: 'muted' };
  return { label: '将新增', detail: '保存后进入复习。', tone: 'muted' };
}

export interface IntakeSelectionEstimate {
  /** Selected valid questions that are new or not checked yet. */
  newQuestions: number;
  /** Selected questions last known to conflict. */
  conflicts: number;
}

/**
 * The outcome shown while a new check is pending: known questions keep their last
 * result, and selected valid questions that were never checked count as new. A fresh
 * check replaces it exactly.
 */
export function estimateIntakeSelection(
  candidates: readonly { key: string; question: IntakeQuestion }[],
  selected: ReadonlySet<string>,
  index: IntakeEntryIndex,
): IntakeSelectionEstimate {
  const estimate = { newQuestions: 0, conflicts: 0 };
  for (const { key, question } of candidates) {
    if (!selected.has(key) || questionIssue(question)) continue;
    const status = index.get(key)?.status;
    if (status === 'conflict') estimate.conflicts++;
    else if (status === undefined || status === 'new') estimate.newQuestions++;
  }
  return estimate;
}
