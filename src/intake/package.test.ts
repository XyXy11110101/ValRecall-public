// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_MAX_BYTES,
  intakeQuestionKey,
  parseIntakePackage,
  questionIssue,
  readIntakeCategoryMap,
  resolveIntakeCategory,
  validateIntakePackage,
} from './package';

export function samplePackage() {
  return parseIntakePackage(
    readFileSync('skills/valrecall-organize/references/example.json', 'utf8'),
  );
}

describe('organize skill transport contract', () => {
  it('accepts the shipped skill output with separated provenance and confirmation', () => {
    const packet = samplePackage();
    expect(packet.records[0]?.excerpt).toBe('');
    expect(packet.records[0]?.thought).toContain('我经常');
    expect(packet.records[0]?.aiAdditions).toContain('没有');
    expect(packet.records[0]?.questions.map((q) => q.needsConfirmation)).toEqual([false, true]);
    expect(packet.records[0]?.questions.map(questionIssue)).toEqual([null, null]);
  });
  it('accepts one fence but not surrounding chat or HTML execution', () => {
    const text = JSON.stringify(samplePackage());
    expect(parseIntakePackage('```json\n' + text + '\n```')).toEqual(samplePackage());
    expect(() => parseIntakePackage('Here it is:\n' + text)).toThrow('JSON');
    const packet = samplePackage();
    packet.records[0]!.thought = '<script>alert(1)</script>';
    expect(validateIntakePackage(packet).records[0]?.thought).toBe('<script>alert(1)</script>');
  });
  it('accepts legacy questionless material, original-only and long bilingual input for preview', () => {
    const packet = samplePackage();
    Object.assign(packet.records[0]!, {
      thought: '',
      excerpt: '原文 English '.repeat(3000),
      questions: [],
    });
    expect(validateIntakePackage(packet).records[0]?.questions).toEqual([]);
  });
  it('rejects unsafe/foreign fields, duplicate IDs and unsupported versions', () => {
    expect(() => validateIntakePackage({ ...samplePackage(), fsrs: {} })).toThrow('fsrs');
    expect(() => validateIntakePackage({ ...samplePackage(), version: 2 })).toThrow('第 1 版');
    const packet = samplePackage();
    packet.records.push(packet.records[0]!);
    expect(() => validateIntakePackage(packet)).toThrow('重复');
  });
  it('enforces bounds before parsing or saving', () => {
    expect(() => parseIntakePackage(' '.repeat(INTAKE_MAX_BYTES + 1))).toThrow('1 MiB');
    const packet = samplePackage();
    packet.records = Array.from({ length: 51 }, (_, i) => ({ ...packet.records[0]!, id: `r${i}` }));
    expect(() => validateIntakePackage(packet)).toThrow('1–50');
    packet.records = [packet.records[0]!];
    packet.records[0]!.questions = Array.from({ length: 201 }, (_, i) => ({
      id: `q${i}`,
      prompt: '',
      answer: '',
      needsConfirmation: true,
    }));
    expect(() => validateIntakePackage(packet)).toThrow('200');
  });
});

describe('per-question intake categories', () => {
  it('keys questions by record and question id without ambiguity', () => {
    expect(intakeQuestionKey('r1', 'q1')).toBe('["r1","q1"]');
    expect(intakeQuestionKey('a:b', 'c')).not.toBe(intakeQuestionKey('a', 'b:c'));
  });
  it('accepts only id or null values from a plain object', () => {
    expect(readIntakeCategoryMap({ a: 'c', b: null })).toEqual({ a: 'c', b: null });
    expect(readIntakeCategoryMap({})).toEqual({});
    expect(readIntakeCategoryMap({ a: 1 })).toBeNull();
    // An empty id can never name a category; only a stored draft may read it as 未分类.
    expect(readIntakeCategoryMap({ a: '' })).toBeNull();
    expect(readIntakeCategoryMap({ a: '' }, { emptyAsNull: true })).toEqual({ a: null });
    expect(readIntakeCategoryMap(['c'])).toBeNull();
    expect(readIntakeCategoryMap(null)).toBeNull();
    expect(readIntakeCategoryMap(undefined)).toBeNull();
    expect(readIntakeCategoryMap(new Map())).toBeNull();
    const hostile = readIntakeCategoryMap(JSON.parse('{"__proto__":"c"}'));
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
    expect(Object.hasOwn(hostile!, '__proto__')).toBe(true);
  });
  it('prefers a question entry, including an explicit null, over the legacy record entry', () => {
    const selection = {
      categories: { r1: 'record', constructor: 'x' },
      questionCategories: {
        [intakeQuestionKey('r1', 'q1')]: 'own',
        [intakeQuestionKey('r1', 'q2')]: null,
      },
    };
    expect(resolveIntakeCategory(selection, 'r1', 'q1')).toBe('own');
    expect(resolveIntakeCategory(selection, 'r1', 'q2')).toBeNull();
    expect(resolveIntakeCategory(selection, 'r1', 'q3')).toBe('record');
    expect(resolveIntakeCategory(selection, 'r2', 'q1')).toBeNull();
    expect(resolveIntakeCategory({ categories: {} }, 'toString', 'q')).toBeNull();
  });
});
