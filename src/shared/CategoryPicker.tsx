import { useId, useMemo, useState } from 'react';

import {
  CATEGORY_PICKER_VISIBLE_LIMIT,
  categoryNameIssue,
  sortCategoriesByRecentUse,
  type MomentCategory,
} from '../models/category';

const UNCATEGORIZED_VALUE = '__valrecall_uncategorized__';

export interface CategoryPickerProps {
  categories: readonly MomentCategory[];
  value: string | null;
  onChange: (categoryId: string | null) => void;
  onCreate?: (name: string) => Promise<MomentCategory>;
  disabled?: boolean;
  label?: string;
  compact?: boolean;
  includeUncategorized?: boolean;
}

export function CategoryPicker({
  categories,
  value,
  onChange,
  onCreate,
  disabled = false,
  label = '分类',
  compact = false,
  includeUncategorized = true,
}: CategoryPickerProps) {
  const fieldId = useId();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matching = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return sortCategoriesByRecentUse(categories).filter(
      (category) => !normalizedQuery || category.name.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [categories, query]);
  const visible = matching.slice(0, CATEGORY_PICKER_VISIBLE_LIMIT);
  const selected = value === null ? null : categories.find((category) => category.id === value);
  if (selected && !visible.some((category) => category.id === selected.id))
    visible.unshift(selected);
  const showSearch = categories.length > CATEGORY_PICKER_VISIBLE_LIMIT || query.length > 0;

  async function submitCategory() {
    if (!onCreate) return;
    const issue = categoryNameIssue(newName);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const category = await onCreate(newName.trim());
      onChange(category.id);
      setNewName('');
      setQuery('');
      setCreating(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建分类。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`category-picker stack-tight${compact ? ' compact' : ''}`}>
      <label className="field" htmlFor={fieldId}>
        <span>{label}</span>
        <select
          id={fieldId}
          value={value ?? UNCATEGORIZED_VALUE}
          disabled={disabled || busy}
          onChange={(event) =>
            onChange(event.target.value === UNCATEGORIZED_VALUE ? null : event.target.value)
          }
        >
          <option value={UNCATEGORIZED_VALUE}>
            {includeUncategorized ? '未分类' : '选择一个分类'}
          </option>
          {selected === undefined && value !== null && <option value={value}>分类不可用</option>}
          {visible.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      {showSearch && (
        <label className="field category-search-field">
          <span className="sr-only">搜索分类</span>
          <input
            type="search"
            value={query}
            disabled={disabled || busy}
            placeholder="搜索分类"
            onChange={(event) => setQuery(event.target.value)}
          />
          <small className="field-help">
            显示 {Math.min(matching.length, CATEGORY_PICKER_VISIBLE_LIMIT)} / {matching.length}
          </small>
        </label>
      )}
      {onCreate && !creating && (
        <button
          type="button"
          className="button text-button small-button category-create-toggle"
          disabled={disabled}
          onClick={() => {
            setCreating(true);
            setError(null);
          }}
        >
          新建分类
        </button>
      )}
      {onCreate && creating && (
        <div className="category-create-row stack-tight">
          <label className="field">
            <span>新分类名称</span>
            <input
              value={newName}
              disabled={busy}
              maxLength={80}
              autoFocus
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitCategory();
                }
              }}
            />
          </label>
          <div className="cluster">
            <button
              type="button"
              className="button small-button"
              disabled={busy}
              onClick={() => void submitCategory()}
            >
              {busy ? '创建中…' : '创建'}
            </button>
            <button
              type="button"
              className="button secondary small-button"
              disabled={busy}
              onClick={() => {
                setCreating(false);
                setNewName('');
                setError(null);
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}
