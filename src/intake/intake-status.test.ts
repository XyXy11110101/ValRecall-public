// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { IntakeEntryResult, IntakeResult } from '../database/intake-types';
import {
  estimateIntakeSelection,
  indexIntakeEntries,
  forgetIntakeEntry,
  INTAKE_CONFLICT_DETAIL,
  intakeQuestionStatus,
  mergeIntakeEntries,
} from './intake-status';
import { intakeQuestionKey, type IntakeQuestion } from './package';

const question = (id: string, overrides: Partial<IntakeQuestion> = {}): IntakeQuestion => ({
  id,
  prompt: `问题 ${id}？`,
  answer: `答案 ${id}`,
  needsConfirmation: false,
  ...overrides,
});
const entry = (
  questionId: string,
  status: IntakeEntryResult['status'],
  deleted = false,
): IntakeEntryResult => ({
  kind: 'question',
  recordId: 'r',
  questionId,
  status,
  targetId: `t-${questionId}`,
  deleted,
});

describe('intake question status', () => {
  it('indexes question entries once by question key and ignores legacy note entries', () => {
    const report: IntakeResult = {
      notes: 0,
      questions: 1,
      rewardReceiptIds: [],
      entries: [
        entry('a', 'new'),
        { kind: 'note', recordId: 'r', status: 'duplicate', targetId: 'note', deleted: false },
      ],
    };
    const index = indexIntakeEntries(report);
    expect([...index.keys()]).toEqual([intakeQuestionKey('r', 'a')]);
    expect(indexIntakeEntries(null).size).toBe(0);
  });

  it('uses the checked wording only while the question is still included', () => {
    const q = question('a');
    expect(intakeQuestionStatus(q, true, entry('a', 'new')).label).toBe('将新增');
    expect(intakeQuestionStatus(q, false, entry('a', 'new'))).toMatchObject({ label: '未选' });
    expect(intakeQuestionStatus(q, true, undefined)).toMatchObject({ label: '已选' });
    expect(
      intakeQuestionStatus(question('b', { needsConfirmation: true }), false, undefined).label,
    ).toBe('待核实 · 未选');
  });

  it('keeps row labels short and puts the full explanation in the detail sentence', () => {
    const conflict = intakeQuestionStatus(question('a'), true, entry('a', 'conflict'));
    expect(conflict).toEqual({ label: '冲突', detail: INTAKE_CONFLICT_DETAIL, tone: 'error' });
    expect(intakeQuestionStatus(question('a'), true, entry('a', 'duplicate')).label).toBe(
      '已存在 · 跳过',
    );
    expect(intakeQuestionStatus(question('a'), true, entry('a', 'duplicate', true))).toMatchObject({
      label: '已删除 · 跳过',
      detail: '以前接收过，已删除，将跳过。',
    });
    const invalid = intakeQuestionStatus(question('a', { answer: ' ' }), true, entry('a', 'new'));
    expect(invalid).toMatchObject({ label: '需要修改', tone: 'error' });
    expect(invalid.detail).toContain('参考答案不能为空');
  });

  it('estimates the save count from earlier results and newly included valid questions', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      key: intakeQuestionKey('r', id),
      question: question(id, id === 'e' ? { prompt: '' } : {}),
    }));
    const index = indexIntakeEntries({
      notes: 0,
      questions: 1,
      rewardReceiptIds: [],
      entries: [entry('a', 'new'), entry('b', 'duplicate'), entry('c', 'conflict')],
    });
    const selected = new Set(candidates.map((candidate) => candidate.key));
    // a stays new, b/c are not saved, d is newly included, e is invalid.
    expect(estimateIntakeSelection(candidates, selected, index)).toEqual({
      newQuestions: 2,
      conflicts: 1,
    });
    selected.delete(intakeQuestionKey('r', 'a'));
    selected.delete(intakeQuestionKey('r', 'c'));
    expect(estimateIntakeSelection(candidates, selected, index)).toEqual({
      newQuestions: 1,
      conflicts: 0,
    });
  });

  it('remembers a duplicate or conflict that a later check no longer covered', () => {
    const report = (...entries: IntakeEntryResult[]): IntakeResult => ({
      notes: 0,
      questions: entries.filter((value) => value.status === 'new').length,
      rewardReceiptIds: [],
      entries,
    });
    const candidates = ['a', 'b', 'c'].map((id) => ({
      key: intakeQuestionKey('r', id),
      question: question(id),
    }));
    let known = mergeIntakeEntries(
      undefined,
      report(entry('a', 'duplicate'), entry('b', 'conflict'), entry('c', 'new')),
    );
    // a and b are unticked; the fresh check covers c only.
    known = mergeIntakeEntries(known, report(entry('c', 'new')));
    // Re-ticking them must not count them as new while the next check runs.
    const all = new Set(candidates.map((candidate) => candidate.key));
    expect(estimateIntakeSelection(candidates, all, known)).toEqual({
      newQuestions: 1,
      conflicts: 1,
    });
    expect(intakeQuestionStatus(question('a'), true, known.get(candidates[0]!.key)).label).toBe(
      '已存在 · 跳过',
    );
    // A newer result replaces the older outcome for the questions it covers.
    known = mergeIntakeEntries(known, report(entry('a', 'new')));
    expect(known.get(candidates[0]!.key)?.status).toBe('new');
    expect(known.get(candidates[1]!.key)?.status).toBe('conflict');
    // An edit drops the outcome of the old content; nothing else changes.
    const edited = forgetIntakeEntry(known, candidates[1]!.key);
    expect(edited.has(candidates[1]!.key)).toBe(false);
    expect(edited.get(candidates[0]!.key)?.status).toBe('new');
    expect(forgetIntakeEntry(edited, candidates[1]!.key)).toBe(edited);
  });
});
