import type { LearningItemType } from '../models/learning-item';

export interface ReadingDraft {
  id: string;
  excerpt: string;
  recallPrompt: string;
  coreLesson: string;
  bookTitle: string;
  location: string;
  categoryId: string | null;
  itemType: LearningItemType;
}

export function newReadingDraft(previous?: ReadingDraft): ReadingDraft {
  return {
    id: crypto.randomUUID(),
    excerpt: '',
    recallPrompt: '',
    coreLesson: '',
    bookTitle: previous?.bookTitle ?? '',
    location: '',
    categoryId: previous?.categoryId ?? null,
    itemType: 'Understand',
  };
}

export const READING_GUIDES = [
  { label: '解释含义', example: '用自己的话解释这个概念。它与相近概念有什么不同？' },
  { label: '说明原因', example: '为什么会出现这个结果？其中最关键的原因是什么？' },
  { label: '比较区别', example: '这两种观点的区别是什么？各自适用于什么情况？' },
  { label: '举例应用', example: '在什么场景可以运用这个想法？举一个自己的例子。' },
] as const;

export function readingDraftIssue(draft: ReadingDraft): string | null {
  if (!draft.excerpt.trim()) return '请先粘贴要记录的原文。';
  if (!draft.recallPrompt.trim()) return '请写一个不看原文也能理解的问题，或选中重点挖空。';
  if (!draft.coreLesson.trim()) return '请填写答案要点，或选中原文用作答案。';
  return null;
}

export function hasReadingInput(draft: ReadingDraft): boolean {
  return Boolean(draft.excerpt || draft.recallPrompt || draft.coreLesson || draft.location);
}

export function readingTitle(prompt: string): string {
  return Array.from(prompt.replace(/\s+/gu, ' ').trim()).slice(0, 80).join('');
}

/** Exact, literal matching: punctuation is not interpreted as a regular expression. */
export function clozeFromSelection(
  excerpt: string,
  start: number,
  end: number,
): {
  recallPrompt: string;
  coreLesson: string;
} | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > excerpt.length ||
    end <= start
  )
    return null;
  const selected = excerpt.slice(start, end);
  if (!selected.trim() || selected.trim() === excerpt.trim()) return null;
  return {
    recallPrompt: `回忆空缺处的内容：\n${excerpt.split(selected).join('［……］')}`,
    coreLesson: selected,
  };
}
