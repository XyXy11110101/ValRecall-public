export const CATEGORY_SCHEMA_VERSION = 1 as const;
export const CATEGORY_CATALOG_META_KEY = 'momentCategories.v1';
export const MAX_CATEGORY_NAME_LENGTH = 80;
export const CATEGORY_PICKER_VISIBLE_LIMIT = 12;

export interface MomentCategory {
  id: string;
  schemaVersion: typeof CATEGORY_SCHEMA_VERSION;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date;
}

export interface PersistedMomentCategory extends Omit<
  MomentCategory,
  'createdAt' | 'updatedAt' | 'lastUsedAt'
> {
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

export interface PersistedCategoryCatalog {
  schemaVersion: typeof CATEGORY_SCHEMA_VERSION;
  categories: PersistedMomentCategory[];
}

export interface CategorySummary {
  category: MomentCategory | null;
  totalCount: number;
  dueCount: number;
  nextReviewAt: Date | null;
}

export function categoryNameIssue(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) return '请填写分类名称。';
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    return `分类名称不能超过 ${MAX_CATEGORY_NAME_LENGTH} 个字符。`;
  }
  return null;
}

export function categoryNameKey(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').normalize('NFKC').toLocaleLowerCase();
}

export function categoryLabel(category: MomentCategory | null): string {
  return category?.name ?? '未分类';
}

export function sortCategoriesByName(categories: readonly MomentCategory[]): MomentCategory[] {
  return [...categories].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
      left.id.localeCompare(right.id),
  );
}

export function sortCategoriesByRecentUse(categories: readonly MomentCategory[]): MomentCategory[] {
  return [...categories].sort(
    (left, right) =>
      right.lastUsedAt.getTime() - left.lastUsedAt.getTime() ||
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
      left.id.localeCompare(right.id),
  );
}
