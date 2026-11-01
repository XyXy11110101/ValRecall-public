// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  countCategoryOverrides,
  hasOwnCategory,
  intakeQuestionCategory,
  readIntakeDraft,
  UNIFORM_INTAKE_CATEGORY,
  withDefaultCategory,
  withoutQuestionCategory,
  withQuestionCategory,
} from './intake-draft';
import { intakeQuestionKey, type IntakePackageV1 } from './package';

const packet: IntakePackageV1 = {
  format: 'valrecall-intake',
  version: 1,
  packageId: 'draft-package',
  records: ['r1', 'r2'].map((id) => ({
    id,
    title: `材料 ${id}`,
    excerpt: '',
    thought: '想法',
    summary: '',
    aiAdditions: '',
    bookTitle: '',
    location: '',
    questions: ['a', 'b'].map((question) => ({
      id: `${id}-${question}`,
      prompt: `问题 ${question}？`,
      answer: `答案 ${question}`,
      needsConfirmation: false,
    })),
  })),
};
const key = (record: string, question: string) =>
  intakeQuestionKey(record, `${record}-${question}`);
const base = {
  id: 'draft',
  text: '',
  packetText: JSON.stringify(packet),
  selected: [key('r1', 'a')],
  currentKey: null,
};

describe('intake category choice', () => {
  it('lets a question differ from the package default and follow it again', () => {
    let choice = withDefaultCategory(UNIFORM_INTAKE_CATEGORY, 'reading');
    choice = withQuestionCategory(choice, key('r1', 'a'), 'work');
    choice = withQuestionCategory(choice, key('r1', 'b'), null);
    expect(intakeQuestionCategory(choice, key('r1', 'a'))).toBe('work');
    expect(intakeQuestionCategory(choice, key('r1', 'b'))).toBeNull();
    expect(intakeQuestionCategory(choice, key('r2', 'a'))).toBe('reading');
    expect(countCategoryOverrides(choice, [key('r1', 'a'), key('r1', 'b'), key('r2', 'a')])).toBe(
      2,
    );
    // Choosing the default value clears the row's own choice.
    choice = withQuestionCategory(choice, key('r1', 'a'), 'reading');
    expect(choice.overrides).toEqual({ [key('r1', 'b')]: null });
    // The follow action clears one row's choice and leaves the others.
    choice = withQuestionCategory(choice, key('r2', 'b'), 'work');
    expect(withoutQuestionCategory(choice, key('r2', 'b')).overrides).toEqual({
      [key('r1', 'b')]: null,
    });
    expect(withoutQuestionCategory(choice, key('r2', 'a'))).toBe(choice);
  });

  it('keeps a question choice while the package default steps through every option', () => {
    // ArrowDown on a closed select fires one change per option: A -> B -> C.
    let choice = withDefaultCategory(UNIFORM_INTAKE_CATEGORY, 'a');
    choice = withQuestionCategory(choice, key('r1', 'b'), 'b');
    choice = withDefaultCategory(choice, 'b');
    // Equal to the default now, but still the question's own, visible choice.
    expect(hasOwnCategory(choice, key('r1', 'b'))).toBe(true);
    choice = withDefaultCategory(choice, 'c');
    expect(intakeQuestionCategory(choice, key('r1', 'b'))).toBe('b');
    expect(intakeQuestionCategory(choice, key('r1', 'a'))).toBe('c');
    expect(choice).toEqual({ defaultCategory: 'c', overrides: { [key('r1', 'b')]: 'b' } });
  });
});

describe('intake draft restore guard', () => {
  it('restores the current shape, keeps explicit choices and drops unknown questions', () => {
    const restored = readIntakeDraft(
      {
        ...base,
        defaultCategory: 'reading',
        questionCategories: {
          [key('r1', 'a')]: 'work',
          [key('r1', 'b')]: 'reading',
          [intakeQuestionKey('gone', 'q')]: 'work',
        },
      },
      'draft',
    );
    expect(restored.packet).toEqual(packet);
    expect(restored.selected).toEqual([key('r1', 'a')]);
    expect(restored.categories).toEqual({
      defaultCategory: 'reading',
      overrides: { [key('r1', 'a')]: 'work', [key('r1', 'b')]: 'reading' },
    });
  });

  it('restores an empty category id from a damaged draft as 未分类', () => {
    expect(
      readIntakeDraft(
        { ...base, defaultCategory: '', questionCategories: { [key('r1', 'a')]: '' } },
        'draft',
      ).categories,
    ).toEqual({ defaultCategory: null, overrides: { [key('r1', 'a')]: null } });
    expect(readIntakeDraft({ ...base, categories: { r1: '' } }, 'draft').categories).toEqual(
      UNIFORM_INTAKE_CATEGORY,
    );
  });

  it('turns a material category from an older draft into overrides for its questions', () => {
    const restored = readIntakeDraft({ ...base, categories: { r2: 'work', r1: null } }, 'draft');
    expect(restored.categories).toEqual({
      defaultCategory: null,
      overrides: { [key('r2', 'a')]: 'work', [key('r2', 'b')]: 'work' },
    });
    expect(readIntakeDraft({ ...base, packetText: null, categories: {} }, 'draft')).toMatchObject({
      packet: null,
      categories: UNIFORM_INTAKE_CATEGORY,
    });
  });

  it('rejects drafts with a wrong owner, malformed fields or category values', () => {
    const invalid = [
      { ...base, categories: {} },
      { ...base, id: 'other', categories: {} },
      { ...base, selected: [1], categories: {} },
      { ...base },
      { ...base, categories: { r1: 3 } },
      { ...base, defaultCategory: 4, questionCategories: {} },
      { ...base, defaultCategory: null, questionCategories: [] },
      { ...base, defaultCategory: null },
    ];
    expect(() => readIntakeDraft(invalid[0]!, 'draft-x')).toThrow('整理草稿格式无效');
    for (const value of invalid.slice(1))
      expect(() => readIntakeDraft(value, 'draft')).toThrow('整理草稿格式无效');
    expect(() => readIntakeDraft(['not', 'an', 'object'], 'draft')).toThrow('整理草稿格式无效');
  });
});
