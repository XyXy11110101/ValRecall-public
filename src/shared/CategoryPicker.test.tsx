import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MomentCategory } from '../models/category';
import { CategoryPicker } from './CategoryPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-08-03T10:00:00.000Z');

function category(index: number): MomentCategory {
  return {
    id: `category-${index}`,
    schemaVersion: 1,
    name: `Category ${String(index).padStart(2, '0')}`,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: new Date(now.getTime() - index * 1000),
  };
}

describe('CategoryPicker', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('defaults to Uncategorized and bounds large option lists behind search', async () => {
    const categories = Array.from({ length: 30 }, (_, index) => category(index));
    await act(async () => {
      root.render(
        <CategoryPicker categories={categories} value={null} onChange={() => undefined} />,
      );
      await Promise.resolve();
    });

    const select = container.querySelector('select');
    expect(select?.value).toContain('uncategorized');
    expect(select?.options).toHaveLength(13);
    expect(container.textContent).toContain('显示 12 / 30');

    const search = container.querySelector('input[type="search"]');
    await act(async () => {
      if (!(search instanceof HTMLInputElement)) throw new Error('Expected Category search.');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, '29');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect([...select!.options].some((option) => option.textContent === 'Category 29')).toBe(true);
  });

  it('creates one Category inline and selects its stable ID', async () => {
    const onChange = vi.fn();
    const created = category(99);
    const onCreate = vi.fn(async () => created);
    await act(async () => {
      root.render(
        <CategoryPicker categories={[]} value={null} onChange={onChange} onCreate={onCreate} />,
      );
      await Promise.resolve();
    });

    act(() => button('新建分类')?.click());
    const input = container.querySelector('input[maxlength="80"]');
    await act(async () => {
      if (!(input instanceof HTMLInputElement)) throw new Error('Expected Category name input.');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'Utility');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      button('创建')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledWith('Utility');
    expect(onChange).toHaveBeenCalledWith(created.id);
  });

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }
});
