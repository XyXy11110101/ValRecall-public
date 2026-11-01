import type { DraftValue } from '../database/drafts';
import {
  intakeQuestionKey,
  isCategoryId,
  parseIntakePackage,
  readIntakeCategoryMap,
  type IntakePackageV1,
} from './package';

/** The package-wide category plus the questions that differ from it. */
export interface IntakeCategoryChoice {
  /** 统一分类 for every question without its own choice; null = 未分类. */
  defaultCategory: string | null;
  /**
   * intakeQuestionKey → the question's own category. An entry is an explicit choice:
   * it keeps its value when the package default changes, even if the two are equal.
   */
  overrides: Readonly<Record<string, string | null>>;
}

export const UNIFORM_INTAKE_CATEGORY: IntakeCategoryChoice = {
  defaultCategory: null,
  overrides: {},
};

export function intakeQuestionCategory(choice: IntakeCategoryChoice, key: string): string | null {
  return Object.hasOwn(choice.overrides, key)
    ? (choice.overrides[key] ?? null)
    : choice.defaultCategory;
}

/**
 * A new package default never touches a question's own choice. Stepping through the
 * package select with the keyboard (one change per option) must not erase overrides.
 */
export function withDefaultCategory(
  choice: IntakeCategoryChoice,
  categoryId: string | null,
): IntakeCategoryChoice {
  return { defaultCategory: categoryId, overrides: choice.overrides };
}

/** Choosing the default value in a row clears that row's own choice. */
export function withQuestionCategory(
  choice: IntakeCategoryChoice,
  key: string,
  categoryId: string | null,
): IntakeCategoryChoice {
  const overrides = Object.entries(choice.overrides).filter(([candidate]) => candidate !== key);
  if (categoryId !== choice.defaultCategory) overrides.push([key, categoryId]);
  return { defaultCategory: choice.defaultCategory, overrides: Object.fromEntries(overrides) };
}

/** The question follows the package default again, whatever its own value was. */
export function withoutQuestionCategory(
  choice: IntakeCategoryChoice,
  key: string,
): IntakeCategoryChoice {
  if (!Object.hasOwn(choice.overrides, key)) return choice;
  return {
    defaultCategory: choice.defaultCategory,
    overrides: Object.fromEntries(
      Object.entries(choice.overrides).filter(([candidate]) => candidate !== key),
    ),
  };
}

export function hasOwnCategory(choice: IntakeCategoryChoice, key: string): boolean {
  return Object.hasOwn(choice.overrides, key);
}

export function countCategoryOverrides(
  choice: IntakeCategoryChoice,
  keys: Iterable<string>,
): number {
  let count = 0;
  for (const key of keys) if (Object.hasOwn(choice.overrides, key)) count++;
  return count;
}

export interface RestoredIntakeDraft {
  id: string;
  text: string;
  packet: IntakePackageV1 | null;
  selected: string[];
  currentKey: string | null;
  categories: IntakeCategoryChoice;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Blob)
  );
}
function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function questionKeys(packet: IntakePackageV1 | null): Set<string> {
  return new Set(
    packet?.records.flatMap((record) =>
      record.questions.map((question) => intakeQuestionKey(record.id, question.id)),
    ) ?? [],
  );
}

/**
 * Runtime guard for a stored intake draft. Current drafts store the package default
 * plus per-question overrides; drafts written before per-question categories stored
 * one category per material, which becomes an override for each of its questions.
 */
export function readIntakeDraft(value: DraftValue, rowId: string): RestoredIntakeDraft {
  const invalid = () => new Error('整理草稿格式无效。');
  if (!plainObject(value)) throw invalid();
  const selected: unknown = value.selected;
  if (
    value.id !== rowId ||
    typeof value.text !== 'string' ||
    !(value.packetText === null || typeof value.packetText === 'string') ||
    !Array.isArray(selected) ||
    !selected.every(isText) ||
    !(value.currentKey === null || typeof value.currentKey === 'string')
  )
    throw invalid();
  const packet = value.packetText === null ? null : parseIntakePackage(value.packetText);
  const keys = questionKeys(packet);
  let categories: IntakeCategoryChoice;
  if (value.defaultCategory !== undefined || value.questionCategories !== undefined) {
    // No control can show or save an empty id; a damaged draft keeps it as 未分类.
    const overrides = readIntakeCategoryMap(value.questionCategories, { emptyAsNull: true });
    const defaultCategory = value.defaultCategory === '' ? null : value.defaultCategory;
    if (!overrides || !isCategoryId(defaultCategory)) throw invalid();
    categories = {
      defaultCategory,
      // Overrides are explicit choices, so one equal to the default is kept as well.
      overrides: Object.fromEntries(Object.entries(overrides).filter(([key]) => keys.has(key))),
    };
  } else {
    const legacy = readIntakeCategoryMap(value.categories, { emptyAsNull: true });
    if (!legacy) throw invalid();
    const overrides: [string, string | null][] = [];
    for (const record of packet?.records ?? []) {
      const id = Object.hasOwn(legacy, record.id) ? (legacy[record.id] ?? null) : null;
      if (id === null) continue;
      for (const question of record.questions)
        overrides.push([intakeQuestionKey(record.id, question.id), id]);
    }
    categories = { defaultCategory: null, overrides: Object.fromEntries(overrides) };
  }
  return {
    id: rowId,
    text: value.text,
    packet,
    selected,
    currentKey: value.currentKey,
    categories,
  };
}
