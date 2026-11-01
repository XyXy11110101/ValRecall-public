import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { LegacyNotesArchive } from './LegacyNotesArchive';
import type { NoteRecord } from '../models/note';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const note: NoteRecord = {
  schemaVersion: 1,
  id: 'legacy',
  title: '旧材料',
  excerpt: '原文仍然保留',
  thought: '个人感想',
  summary: 'AI 摘要',
  aiAdditions: '需要核实',
  bookTitle: '书名',
  location: '第十页',
  categoryId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('historical notes archive', () => {
  it('loads only when expanded and exposes reading without authoring actions', async () => {
    const load = vi.fn(async () => [note]);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<LegacyNotesArchive load={load} />));
      expect(load).not.toHaveBeenCalled();
      await act(async () => {
        const details = container.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });
      expect(load).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('原文仍然保留');
      expect(container.textContent).toContain('整理摘要 · AI');
      expect(container.querySelector('textarea,input,button')).toBeNull();
      expect(container.querySelectorAll('details')).toHaveLength(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it('reports errors separately from empty data and retries', async () => {
    const load = vi
      .fn<() => Promise<NoteRecord[]>>()
      .mockRejectedValueOnce(new Error('读取失败'))
      .mockResolvedValueOnce([]);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<LegacyNotesArchive load={load} />));
      await act(async () => {
        const details = container.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });
      expect(container.textContent).toContain('读取失败');
      expect(container.textContent).not.toContain('没有历史笔记');
      await act(async () => container.querySelector('button')!.click());
      expect(container.textContent).toContain('没有历史笔记');
    } finally {
      act(() => root.unmount());
    }
  });
});
