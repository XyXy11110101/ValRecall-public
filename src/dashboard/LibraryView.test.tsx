import { installDraftMemoryPort } from '../testing/draft-port';
import { DraftRepository } from '../database/drafts';
import { requestEditorLeaveAsync } from '../shared/edit-protection';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ImageLearningItem, TextLearningItem, VideoLearningItem } from '../database';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { LIBRARY_REFRESH_NOTICE_MS, LibraryView } from './LibraryView';

const mocks = vi.hoisted(() => ({
  listItems: vi.fn(),
  getItem: vi.fn(),
  getScreenshot: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  listCategorySummaries: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
  mergeCategory: vi.fn(),
  deleteCategory: vi.fn(),
  openSourceAtTimestamp: vi.fn(),
}));

vi.mock('./services', () => ({
  repository: {
    listItems: mocks.listItems,
    getItem: mocks.getItem,
    getScreenshot: mocks.getScreenshot,
    updateItem: mocks.updateItem,
    deleteItem: mocks.deleteItem,
    listCategorySummaries: mocks.listCategorySummaries,
    createCategory: mocks.createCategory,
    renameCategory: mocks.renameCategory,
    mergeCategory: mocks.mergeCategory,
    deleteCategory: mocks.deleteCategory,
  },
}));

vi.mock('../shared/extension', () => ({
  displayError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
  openSourceAtTimestamp: mocks.openSourceAtTimestamp,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date('2026-07-22T12:00:00.000Z');
const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');
const workspaceCss = readFileSync(resolve('src/dashboard/library-workspace.css'), 'utf8');
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

function youtubeItem(overrides: Partial<VideoLearningItem> = {}): VideoLearningItem {
  const base: VideoLearningItem = {
    id: 'youtube-item',
    schemaVersion: 2,
    platform: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    videoId: 'abcdefghijk',
    videoTitle: 'YouTube lesson',
    uploader: 'Channel creator',
    description: null,
    timestampSeconds: 42,
    timestampDisplay: '00:42',
    videoDurationSeconds: 180,
    chapterTitle: null,
    screenshotId: null,
    subtitleBefore: [],
    subtitleCurrent: [],
    subtitleAfter: [],
    subtitleCueData: [],
    categoryId: null,
    itemType: 'Do',
    personalNote: '',
    situation: 'A test situation',
    coreLesson: 'Hold the angle.',
    mistakeToAvoid: '',
    recommendedAction: 'Hold the angle.',
    reason: '',
    recallPrompt: 'What should you do?',
    referenceAnswer: 'Hold the angle.',
    tags: ['youtube', 'do'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
  };
  return { ...base, ...overrides };
}

function douyinItem(overrides: Partial<VideoLearningItem> = {}): VideoLearningItem {
  return {
    ...youtubeItem(),
    id: 'douyin-item',
    platform: 'douyin',
    sourceUrl: 'https://www.douyin.com/video/7391234567890123456?tracking=1',
    canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
    videoId: '7391234567890123456',
    videoTitle: 'Douyin lesson',
    uploader: 'Douyin creator',
    ...overrides,
  };
}

function textItem(overrides: Partial<TextLearningItem> = {}): TextLearningItem {
  return {
    id: 'text-item',
    schemaVersion: 2,
    sourceType: 'text',
    title: 'Text lesson',
    categoryId: null,
    itemType: 'Understand',
    personalNote: '',
    situation: '',
    coreLesson: 'Use cover before taking the duel.',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'How should I prepare this duel?',
    referenceAnswer: 'Use cover and pre-aim the likely swing.',
    tags: ['text'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
    ...overrides,
  };
}

function imageItem(overrides: Partial<ImageLearningItem> = {}): ImageLearningItem {
  return {
    id: 'image-item',
    schemaVersion: 2,
    sourceType: 'image',
    title: 'Image lesson',
    imageAssetId: 'image-image-item',
    imageMimeType: 'image/webp',
    imageWidth: 1200,
    imageHeight: 800,
    categoryId: null,
    itemType: 'Notice',
    personalNote: '',
    situation: '',
    coreLesson: 'Use the upper corner.',
    mistakeToAvoid: '',
    recommendedAction: '',
    reason: '',
    recallPrompt: 'Where should the crosshair align?',
    referenceAnswer: 'On the upper corner.',
    tags: ['image'],
    createdAt: now,
    updatedAt: now,
    fsrsCard: createEmptyCard(now),
    reviewHistory: [],
    suspended: false,
    extractionDiagnostics: [],
    ...overrides,
  };
}

describe('LibraryView platform integration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let drafts: ReturnType<typeof installDraftMemoryPort>;

  beforeEach(() => {
    drafts = installDraftMemoryPort();
    mocks.getItem.mockReset().mockResolvedValue(youtubeItem());
    mocks.listItems.mockReset().mockResolvedValue([youtubeItem()]);
    mocks.getScreenshot.mockReset().mockResolvedValue(undefined);
    mocks.updateItem.mockReset();
    mocks.deleteItem.mockReset();
    mocks.listCategorySummaries
      .mockReset()
      .mockResolvedValue([{ category: null, totalCount: 1, dueCount: 1, nextReviewAt: now }]);
    mocks.createCategory.mockReset();
    mocks.renameCategory.mockReset();
    mocks.mergeCategory.mockReset();
    mocks.deleteCategory.mockReset();
    mocks.openSourceAtTimestamp.mockReset().mockResolvedValue({
      ok: true,
      attempts: 1,
      timestampSeconds: 42,
      error: null,
      diagnostics: [],
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:library-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
    Reflect.deleteProperty(document, 'startViewTransition');
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('opens readonly content without writes and returns to it after cancelling an edit', async () => {
    await renderLibrary();
    expect(mocks.listItems).toHaveBeenCalledWith(
      expect.objectContaining({ includeReviewHistory: false }),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    expect(container.querySelector('.library-reading')?.textContent).toContain('Hold the angle.');
    expect(fieldTextarea('答案要点')).toBeUndefined();
    await act(async () => button('编辑')?.click());
    expect(fieldTextarea('答案要点')).toBeDefined();
    await act(async () => button('收起编辑')?.click());
    expect(container.querySelector('.library-reading')).not.toBeNull();
    expect(mocks.updateItem).not.toHaveBeenCalled();
    await act(async () => {
      button('返回目录')?.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement?.hasAttribute('data-library-read-button')).toBe(true);
  });

  it('reads and edits a reading source without losing the original on cancel or failure', async () => {
    const readingSource = {
      schemaVersion: 1 as const,
      excerpt: '原文第一段\n第二段',
      bookTitle: '阅读测试',
      location: '第 42 页',
    };
    const item = textItem({ readingSource });
    mocks.listItems.mockResolvedValue([item]);
    await renderLibrary();
    expect(container.textContent).toContain('阅读摘录');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    expect(container.querySelector('.library-reading .reading-excerpt')?.textContent).toBe(
      readingSource.excerpt,
    );
    expect(mocks.updateItem).not.toHaveBeenCalled();
    await act(async () => button('编辑')?.click());
    await act(async () => changeTextarea(fieldTextarea('阅读原文'), '尚未保存的修改'));
    await act(async () => button('收起编辑')?.click());
    expect(container.querySelector('.library-reading .reading-excerpt')?.textContent).toBe(
      readingSource.excerpt,
    );
    await act(async () => button('编辑')?.click());
    await act(async () => changeTextarea(fieldTextarea('阅读原文'), '更新原文'));
    mocks.updateItem
      .mockRejectedValueOnce(new Error('保存失败'))
      .mockImplementationOnce(async () => {
        const updated = textItem({ readingSource: { ...readingSource, excerpt: '更新原文' } });
        mocks.listItems.mockResolvedValue([updated]);
        return updated;
      });
    await act(async () => button('保存更改')?.click());
    expect(fieldTextarea('阅读原文')?.value).toBe('更新原文');
    await act(async () => button('保存更改')?.click());
    expect(mocks.updateItem).toHaveBeenLastCalledWith(
      item.id,
      expect.objectContaining({ readingSource: { ...readingSource, excerpt: '更新原文' } }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
    expect(container.querySelector('.library-reading .reading-excerpt')?.textContent).toBe(
      '更新原文',
    );
  });

  it('preserves failed edits and returns to updated readonly content after retry', async () => {
    const updated = youtubeItem({ coreLesson: 'Updated answer' });
    mocks.updateItem
      .mockRejectedValueOnce(new Error('Save unavailable'))
      .mockImplementationOnce(async () => {
        mocks.listItems.mockResolvedValue([updated]);
        return updated;
      });
    await renderLibrary();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    await act(async () => button('编辑')?.click());
    await act(async () => changeTextarea(fieldTextarea('答案要点'), 'Updated answer'));
    await act(async () => button('保存更改')?.click());
    expect(container.textContent).toContain('Save unavailable');
    expect(fieldTextarea('答案要点')?.value).toBe('Updated answer');
    await act(async () => button('保存更改')?.click());
    expect(container.querySelector('.library-reading-answer')?.textContent).toBe('Updated answer');
    expect(container.querySelector('[data-library-editor-for]')).toBeNull();
  });

  it('opens full readonly content from the explicit detail action and restores its focus', async () => {
    await renderLibrary();
    const trigger = container.querySelector<HTMLButtonElement>('[data-library-read-button]');
    await act(async () => trigger?.click());
    expect(trigger?.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('.library-reading')?.textContent).toContain('Hold the angle.');
    expect(fieldTextarea('答案要点')).toBeUndefined();
    await act(async () => {
      button('返回目录')?.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('.library-learning-workspace')?.getAttribute('data-pane')).toBe(
      'directory',
    );
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('resolves an external detail request without entering edit mode and consumes it', async () => {
    const consume = vi.fn();
    await act(async () =>
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          detailRequest={{ key: 1, itemId: 'youtube-item' }}
          onDetailRequestConsumed={consume}
        />,
      ),
    );
    expect(mocks.getItem).toHaveBeenCalledWith('youtube-item');
    expect(container.querySelector('.library-reading')).not.toBeNull();
    expect(fieldTextarea('答案要点')).toBeUndefined();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('keeps the library usable when an external target was deleted', async () => {
    mocks.getItem.mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          detailRequest={{ key: 2, itemId: 'deleted' }}
        />,
      ),
    );
    expect(container.textContent).toContain('这道回忆题已不存在');
    expect(container.querySelector('.library-reading')).toBeNull();
    expect(container.querySelectorAll('.library-row')).toHaveLength(1);
  });

  it.each(['all', 'uncategorized', 'reading'])(
    'opens the shared authoring workspace with the %s category context',
    async (scope) => {
      const reading = category('reading', '阅读');
      mocks.listCategorySummaries.mockResolvedValue([
        { category: null, totalCount: 1, dueCount: 1, nextReviewAt: now },
        { category: reading, totalCount: 0, dueCount: 0, nextReviewAt: null },
      ]);
      const onAddQuestion = vi.fn();
      await renderLibrary({ onAddQuestion });
      await act(async () => changeSelect(fieldSelect('资料库分类'), scope));
      await act(async () => button('添加回忆题')?.click());
      expect(onAddQuestion).toHaveBeenCalledExactlyOnceWith(scope === 'reading' ? 'reading' : null);
      expect(button('新 Moment')).toBeUndefined();
      expect(button('记录阅读')).toBeUndefined();
      expect(container.querySelector('form#library-new-moment')).toBeNull();
      expect(mocks.updateItem).not.toHaveBeenCalled();
    },
  );

  it('has no disconnected authoring fallback when no add callback is provided', async () => {
    await renderLibrary();
    expect(button('添加回忆题')).toBeUndefined();
    expect(container.querySelector('.text-moment-form')).toBeNull();
  });

  it('locates an externally created question through filters, expands its source group and focuses read-only detail', async () => {
    const reading = category('reading', '阅读');
    const created = youtubeItem({
      id: 'new-question',
      categoryId: 'reading',
      videoId: 'newvideo123',
      canonicalUrl: 'https://www.youtube.com/watch?v=newvideo123',
      videoTitle: '刚添加的回忆题',
    });
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 1, dueCount: 1, nextReviewAt: now },
      { category: reading, totalCount: 1, dueCount: 1, nextReviewAt: now },
    ]);
    mocks.listItems.mockImplementation(async (options) =>
      options.query || options.source === 'image'
        ? []
        : options.categoryId === 'reading'
          ? [created]
          : [youtubeItem()],
    );
    await renderLibrary();
    await act(async () => changeSelect(arrangementSelect(), 'sources'));
    await act(async () => changeInput(searchInput(), 'unrelated search'));
    await act(async () => changeSelect(fieldSelect('按来源筛选'), 'image'));
    expect(container.querySelectorAll('.library-row')).toHaveLength(0);
    mocks.getItem.mockResolvedValue(created);
    const consumed = vi.fn();
    const request = { key: 54, itemId: created.id };
    await renderLibrary({ revision: 1, detailRequest: request, onDetailRequestConsumed: consumed });
    expect(searchInput()?.value).toBe('');
    expect(fieldSelect('按来源筛选')?.value).toBe('all');
    expect(fieldSelect('资料库分类')?.value).toBe('reading');
    expect(arrangementSelect()?.value).toBe('sources');
    const row = container.querySelector('[data-library-item-id="new-question"]');
    expect(row?.closest('.source-group')).not.toBeNull();
    expect(container.querySelector('.library-detail .library-reading')).not.toBeNull();
    expect(row?.querySelector('.library-reading')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.library-detail-heading h3'));
    expect(fieldTextarea('答案要点')).toBeUndefined();
    expect(consumed).toHaveBeenCalledTimes(1);
    const requestReads = () => mocks.getItem.mock.calls.filter(([id]) => id === created.id);
    expect(requestReads()).toHaveLength(1);
    await renderLibrary({ revision: 2, detailRequest: request, onDetailRequestConsumed: consumed });
    expect(requestReads()).toHaveLength(1);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('filters, displays, and reopens items with their platform', async () => {
    const onCreatePracticeTask = vi.fn();
    await act(async () => {
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          onCreatePracticeTask={onCreatePracticeTask}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('YouTube');
    const platformSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'youtube'),
    );
    if (!platformSelect) throw new Error('Expected the platform filter.');
    expect([...platformSelect.options].map((option) => option.value)).toEqual([
      'all',
      'text',
      'image',
      'bilibili',
      'youtube',
      'douyin',
    ]);

    await act(async () => {
      platformSelect.value = 'youtube';
      platformSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'youtube' }),
    );

    expect(arrangementSelect()?.value).toBe('recent');
    await act(async () => button('编辑')?.click());
    expect(container.textContent).toContain('捕获自 YouTube · 00:42');
    expect(container.textContent).toContain('Channel creator');

    await act(async () => button('收起编辑')?.click());
    await act(async () => button('创建练习任务')?.click());
    expect(onCreatePracticeTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'youtube-item' }),
    );

    await act(async () => {
      button('打开来源')?.click();
      await Promise.resolve();
    });
    expect(mocks.openSourceAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'youtube',
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      }),
    );
  });

  it('opens the exact requested Library item from an Upcoming review row', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({ id: 'other-item', videoTitle: 'Other lesson' }),
      youtubeItem({ id: 'requested-item', videoTitle: 'Requested future lesson' }),
    ]);

    await act(async () => {
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          initialSelectedItemId="requested-item"
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe(
      'Requested future lesson',
    );
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('filters and labels direct Douyin captures without changing source identity', async () => {
    mocks.listItems.mockResolvedValue([douyinItem()]);
    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Douyin lesson');
    expect(container.textContent).toContain('Douyin');
    const platformSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'douyin'),
    );
    if (!platformSelect) throw new Error('Expected the Douyin platform filter.');

    await act(async () => {
      platformSelect.value = 'douyin';
      platformSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'douyin' }));

    await act(async () => {
      button('打开来源')?.click();
      await Promise.resolve();
    });
    expect(mocks.openSourceAtTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'douyin',
        canonicalUrl: 'https://www.douyin.com/video/7391234567890123456',
      }),
    );
  });

  it('groups Moments, expands independent items, and opens canonical or saved context', async () => {
    const first = youtubeItem({
      id: 'youtube-first',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=FIRST_LIST&index=2&t=80s',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoTitle: 'First capture title',
      timestampSeconds: 80,
      timestampDisplay: '01:20',
      createdAt: new Date('2026-07-20T12:00:00.000Z'),
    });
    const second = youtubeItem({
      id: 'youtube-second',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=SECOND_LIST&index=6&t=20s',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      videoTitle: 'Most recent source title',
      timestampSeconds: 20,
      timestampDisplay: '00:20',
      recallPrompt: 'Which capture comes first?',
      videoOrigin: 'library',
      screenshotId: null,
      createdAt: new Date('2026-07-22T12:00:00.000Z'),
    });
    const onReviewItem = vi.fn();
    mocks.listItems.mockResolvedValue([first, second]);

    await act(async () => {
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          onReviewItem={onReviewItem}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => changeSelect(arrangementSelect(), 'sources'));
    expect(arrangementSelect()?.value).toBe('sources');
    expect(container.textContent).toContain('Most recent source title');
    expect(container.textContent).toContain('2 道回忆题');
    expect(container.textContent).toContain('保存于');
    expect(container.textContent).not.toContain('2 captured');
    expect(container.textContent).toContain('2 道到期');
    expect(container.querySelectorAll('.source-group')).toHaveLength(1);

    await act(async () => {
      button('打开原视频')?.click();
      await Promise.resolve();
    });
    expect(mocks.openSourceAtTimestamp).toHaveBeenLastCalledWith({
      platform: 'youtube',
      sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      timestampSeconds: null,
      pauseAfterSeek: DEFAULT_PREFERENCES.pauseAfterReopen,
    });
    expect(spoken()).toBe('已打开「Most recent source title」的来源。');
    expect(container.querySelector('.notice')).toBeNull();

    mocks.openSourceAtTimestamp.mockResolvedValueOnce({
      ok: false,
      attempts: 1,
      timestampSeconds: null,
      error: 'The source tab was unavailable.',
      diagnostics: [],
    });
    await act(async () => {
      button('打开原视频')?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('.notice.warning')?.textContent).toContain('来源无法打开。');
    expect(container.querySelector('.notice.warning')?.textContent).not.toContain('start position');

    await act(async () => button('展开')?.click());
    expect(button('收起')?.getAttribute('aria-expanded')).toBe('true');
    const rows = [...container.querySelectorAll<HTMLElement>('.source-group-items .library-row')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('00:20'),
      expect.stringContaining('01:20'),
    ]);
    expect(rows[0]?.textContent).toContain('Which capture comes first?');

    await act(async () => {
      rows[1]?.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click();
      await Promise.resolve();
    });
    await act(async () => button('打开来源')?.click());
    expect(mocks.openSourceAtTimestamp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=FIRST_LIST&index=2&t=80s',
        timestampSeconds: 80,
      }),
    );

    await act(async () =>
      rows[0]?.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    await act(async () => button('从本题开始复习')?.click());
    expect(onReviewItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'youtube-second' }));
    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.deleteItem).not.toHaveBeenCalled();

    const collapseButton = button('收起');
    collapseButton?.focus();
    await act(async () => collapseButton?.click());
    expect(container.querySelector('.source-group-disclosure')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(button('展开')).toBe(document.activeElement);

    await act(async () => changeSelect(arrangementSelect(), 'recent'));
    expect(arrangementSelect()?.value).toBe('recent');
    expect(container.querySelector('.library-results .motion-view-swap')).not.toBeNull();
  });

  it('keeps grouped mode available with platform filters', async () => {
    const youtube = youtubeItem({ id: 'youtube-filtered', videoTitle: 'YouTube group' });
    const douyin = douyinItem({ id: 'douyin-filtered', videoTitle: 'Douyin group' });
    mocks.listItems.mockImplementation(async (options: { source?: string }) =>
      options.source === 'youtube' ? [youtube] : [youtube, douyin],
    );

    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    await act(async () => changeSelect(arrangementSelect(), 'sources'));

    const platformSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'youtube'),
    );
    if (!platformSelect) throw new Error('Expected the platform filter.');
    await act(async () => {
      platformSelect.value = 'youtube';
      platformSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: 'youtube' }),
    );
    expect(container.textContent).toContain('YouTube group');
    expect(container.textContent).not.toContain('Douyin group');
    expect(arrangementSelect()?.value).toBe('sources');
  });

  it('shows fallback and ungrouped states without hiding malformed legacy items', async () => {
    const untitled = youtubeItem({
      id: 'untitled',
      videoTitle: ' ',
      screenshotId: null,
    });
    const malformed = youtubeItem({
      id: 'malformed',
      sourceUrl: 'https://www.youtube.com/shorts/abcdefghijk',
      canonicalUrl: null,
      videoTitle: 'Visible legacy item',
      screenshotId: null,
    });
    mocks.listItems.mockResolvedValue([untitled, malformed]);

    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    await act(async () => changeSelect(arrangementSelect(), 'sources'));

    expect(container.textContent).toContain('YouTube abcdefghijk');
    expect(container.textContent).not.toContain('标题不可用');
    expect(container.textContent).not.toContain('没有截图');
    expect(container.querySelector('.source-group-summary .thumbnail')).toBeNull();
    expect(container.textContent).toContain('独立回忆题');
    expect(container.textContent).toContain('Visible legacy item');
  });

  it('distinguishes an empty Library from a filtered no-match state', async () => {
    mocks.listItems.mockResolvedValue([]);
    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('还没有学习条目');
    expect(container.querySelector('.library-results .empty-state-major')).not.toBeNull();
    const quietCompanion = container.querySelector('.library-results .companion-empty');
    expect(quietCompanion?.tagName).toBe('DIV');
    expect(quietCompanion?.getAttribute('data-companion-state')).toBe('idle');
    expect(quietCompanion?.getAttribute('data-companion-placement')).toBe('empty');
    expect(quietCompanion?.getAttribute('data-companion-pose')).toBe('sleepy');
    expect(quietCompanion?.getAttribute('aria-hidden')).toBe('true');
    expect(quietCompanion?.getAttribute('role')).toBe('presentation');
    expect(quietCompanion?.querySelector('.companion-copy')).toBeNull();

    const platformSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'bilibili'),
    );
    if (!platformSelect) throw new Error('Expected the platform filter.');
    await act(async () => {
      platformSelect.value = 'bilibili';
      platformSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('没有匹配的Bilibili 回忆题');
    expect(container.querySelector('.library-results .empty-state-major')).not.toBeNull();
    expect(container.querySelector('.library-results .companion-empty')).toBeNull();
  });

  it('applies due-state filtering immediately without blanking retained results', async () => {
    const due = youtubeItem({ id: 'due', videoTitle: 'Due lesson' });
    mocks.listItems.mockImplementation(async (options: { status?: string }) =>
      options.status === 'due' || options.status === 'all' ? [due] : [],
    );
    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    const statusSelect = [...container.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'future'),
    );
    if (!statusSelect) throw new Error('Expected the status filter.');

    await act(async () => {
      statusSelect.value = 'due';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'due' }));
    expect(container.textContent).toContain('Due lesson');

    await act(async () => {
      statusSelect.value = 'future';
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('没有匹配的条目');
  });

  it('animates only a newly inserted item and retains existing rows during refresh', async () => {
    const existing = youtubeItem({ id: 'existing', videoTitle: 'Existing lesson' });
    const inserted = youtubeItem({ id: 'inserted', videoTitle: 'Inserted lesson' });
    let resolveRefresh: ((items: VideoLearningItem[]) => void) | undefined;
    mocks.listItems.mockResolvedValueOnce([existing]).mockImplementationOnce(
      () =>
        new Promise<VideoLearningItem[]>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    const existingRow = container.querySelector('[data-library-item-id="existing"]');

    await act(async () => {
      root.render(
        <LibraryView revision={1} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Existing lesson');
    expect(container.textContent).not.toContain('正在更新结果');
    expect(container.querySelector('[data-library-item-id="existing"]')).toBe(existingRow);

    await act(async () => {
      resolveRefresh?.([inserted, existing]);
      await Promise.resolve();
    });
    expect(
      container
        .querySelector('[data-library-item-id="inserted"]')
        ?.classList.contains('motion-list-enter'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-library-item-id="existing"]')
        ?.classList.contains('motion-list-enter'),
    ).toBe(false);
  });

  describe('the refresh line', () => {
    const line = () => container.querySelector('.library-toolbar-status')?.textContent ?? '';
    const dimmed = () =>
      container.querySelector('.library-results')?.getAttribute('data-refreshing');
    const finishers: Array<(items: VideoLearningItem[]) => void> = [];
    const refreshTo = (revision: number) => renderLibrary({ revision });
    const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

    beforeEach(async () => {
      finishers.length = 0;
      mocks.listItems.mockResolvedValueOnce([youtubeItem()]).mockImplementation(
        () =>
          new Promise<VideoLearningItem[]>((resolve) => {
            finishers.push(resolve);
          }),
      );
      await renderLibrary();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('stays hidden until a request outlasts the delay, while the page is busy at once', async () => {
      await refreshTo(1);
      expect(container.querySelector('.library-view')?.getAttribute('aria-busy')).toBe('true');
      await wait(LIBRARY_REFRESH_NOTICE_MS - 1);
      expect(line()).not.toContain('正在更新结果');
      expect(dimmed()).toBe('false');
      await wait(1);
      expect(line()).toContain('正在更新结果');
      expect(dimmed()).toBe('true');
      await act(async () => finishers[0]?.([youtubeItem()]));
      expect(line()).not.toContain('正在更新结果');
      expect(dimmed()).toBe('false');
    });

    it('never shows for a quick request', async () => {
      await refreshTo(1);
      await wait(LIBRARY_REFRESH_NOTICE_MS - 1);
      await act(async () => finishers[0]?.([youtubeItem()]));
      await wait(LIBRARY_REFRESH_NOTICE_MS);
      expect(line()).not.toContain('正在更新结果');
      expect(dimmed()).toBe('false');
    });

    it('waits from each request, not from the first of a series', async () => {
      await refreshTo(1);
      await wait(LIBRARY_REFRESH_NOTICE_MS - 100);
      await refreshTo(2);
      await wait(LIBRARY_REFRESH_NOTICE_MS - 1);
      expect(line()).not.toContain('正在更新结果');
      await wait(1);
      expect(line()).toContain('正在更新结果');
    });

    it('stays on screen across a newer request until its result arrives', async () => {
      await refreshTo(1);
      await wait(LIBRARY_REFRESH_NOTICE_MS);
      await refreshTo(2);
      expect(line()).toContain('正在更新结果');
      // The older result is ignored, so it does not take the line away.
      await act(async () => finishers[0]?.([youtubeItem()]));
      expect(line()).toContain('正在更新结果');
      await act(async () => finishers[1]?.([youtubeItem()]));
      expect(line()).not.toContain('正在更新结果');
    });
  });

  it('titles the page without a slogan and keeps its heading a focus target', async () => {
    await renderLibrary();
    const header = container.querySelector('.library-page-header');
    expect(header?.textContent).toBe('资料库');
    expect(header?.querySelector('h2')?.getAttribute('tabindex')).toBe('-1');
    expect(header?.querySelector('.eyebrow')).toBeNull();
  });

  it('marks a row only when it is due or paused', async () => {
    const later = { ...createEmptyCard(now), due: new Date(Date.now() + 86_400_000) };
    mocks.listItems.mockResolvedValue([
      youtubeItem({ id: 'due', videoTitle: 'Due' }),
      youtubeItem({ id: 'paused', videoTitle: 'Paused', suspended: true }),
      youtubeItem({ id: 'later', videoTitle: 'Later', fsrsCard: later }),
      textItem({ id: 'later-text', fsrsCard: later }),
    ]);
    await renderLibrary();
    const meta = (id: string) =>
      container.querySelector(`[data-library-item-id="${id}"] .muted.small`)?.textContent ?? null;
    expect(meta('due')).toBe('到期 · 00:42');
    expect(meta('paused')).toBe('已暂停 · 00:42');
    expect(meta('later')).toBe('00:42');
    expect(meta('later-text')).toBeNull();

    const eyebrow = async (id: string) => {
      await act(async () =>
        container.querySelector<HTMLButtonElement>(`[data-library-read-button="${id}"]`)?.click(),
      );
      return container.querySelector('.library-detail-heading .eyebrow')?.textContent;
    };
    expect(await eyebrow('due')).toBe('YouTube · 到期');
    expect(await eyebrow('paused')).toBe('YouTube · 已暂停');
    expect(await eyebrow('later')).toBe('YouTube');
    expect(container.textContent).not.toContain('已安排');
  });

  it('speaks pausing, restoring and deleting a question without a visible notice', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.updateItem.mockResolvedValue(youtubeItem());
    mocks.deleteItem.mockResolvedValue(undefined);
    await renderLibrary();
    mocks.listItems.mockResolvedValue([youtubeItem({ suspended: true })]);
    await act(async () => button('暂停复习')?.click());
    expect(mocks.updateItem).toHaveBeenLastCalledWith('youtube-item', { suspended: true });
    expect(spoken()).toBe('已暂停。');
    expect(container.querySelector('.notice')).toBeNull();

    mocks.listItems.mockResolvedValue([youtubeItem()]);
    await act(async () => button('取消暂停')?.click());
    expect(mocks.updateItem).toHaveBeenLastCalledWith('youtube-item', { suspended: false });
    expect(spoken()).toBe('已恢复复习。');
    expect(container.querySelector('.notice')).toBeNull();

    await act(async () => button('删除回忆题')?.click());
    expect(confirm).toHaveBeenCalledOnce();
    expect(mocks.deleteItem).toHaveBeenCalledWith('youtube-item');
    expect(spoken()).toBe('已删除。');
    expect(container.querySelector('.notice')).toBeNull();
  });

  it('flips the open question when pausing takes it out of the status filter', async () => {
    const paused = youtubeItem({ suspended: true, updatedAt: new Date(now.getTime() + 1000) });
    const resumed = youtubeItem({ updatedAt: new Date(now.getTime() + 2000) });
    await renderLibrary();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    await act(async () => changeSelect(fieldSelect('按复习状态筛选'), 'due'));
    const eyebrow = () => container.querySelector('.library-detail-heading .eyebrow')?.textContent;
    expect(eyebrow()).toBe('YouTube · 到期');

    mocks.updateItem.mockResolvedValueOnce(paused);
    mocks.listItems.mockResolvedValue([]);
    await act(async () => button('暂停复习')?.click());
    expect(container.querySelector('[data-library-item-id="youtube-item"]')).toBeNull();
    expect(eyebrow()).toBe('YouTube · 已暂停');
    expect(button('暂停复习')).toBeUndefined();
    expect(container.querySelector('.notice')).toBeNull();

    // So the same pane can undo it, and an edit compares against what is really stored.
    mocks.updateItem.mockResolvedValueOnce(resumed);
    await act(async () => button('取消暂停')?.click());
    expect(mocks.updateItem).toHaveBeenLastCalledWith('youtube-item', { suspended: false });
    expect(eyebrow()).toBe('YouTube · 到期');
    expect(button('暂停复习')).toBeDefined();

    await act(async () => button('编辑')?.click());
    mocks.updateItem.mockResolvedValueOnce(resumed);
    await act(async () => button('保存更改')?.click());
    const expected = (mocks.updateItem.mock.lastCall?.[2] as { expectedState: string })
      .expectedState;
    expect(expected).toContain(resumed.updatedAt.toISOString());
  });

  it('refreshes an open question that left the filter some other way', async () => {
    const reviewed = youtubeItem({ suspended: true, updatedAt: new Date(now.getTime() + 1000) });
    await renderLibrary();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    await act(async () => changeSelect(fieldSelect('按复习状态筛选'), 'due'));
    mocks.getItem.mockClear();
    // Reviewed on another page: a new revision, and it is no longer due.
    mocks.listItems.mockResolvedValue([]);
    mocks.getItem.mockResolvedValue(reviewed);
    await renderLibrary({ revision: 1 });
    expect(mocks.getItem).toHaveBeenCalledExactlyOnceWith('youtube-item');
    expect(container.querySelector('.library-detail-heading .eyebrow')?.textContent).toBe(
      'YouTube · 已暂停',
    );
    // Changing a filter changes no data, so it reads nothing more.
    await act(async () => changeSelect(fieldSelect('按复习状态筛选'), 'future'));
    expect(mocks.getItem).toHaveBeenCalledOnce();
    // And an item that really is gone stays as it was, with no error.
    mocks.getItem.mockResolvedValue(undefined);
    await renderLibrary({ revision: 2 });
    expect(container.querySelector('.library-detail-heading .eyebrow')?.textContent).toBe(
      'YouTube · 已暂停',
    );
    mocks.getItem.mockRejectedValue(new Error('read failed'));
    await renderLibrary({ revision: 3 });
    expect(container.querySelector('.notice.error')).toBeNull();
  });

  it('does not leave focus armed when the open row or 当前题目 is pressed again', async () => {
    mocks.listItems.mockImplementation(async () => [youtubeItem()]);
    await renderLibrary();
    const row = () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button="youtube-item"]')!;
    const heading = () => container.querySelector('.library-detail-heading h3');
    await act(async () => row().click());
    expect(document.activeElement).toBe(heading());
    await act(async () => row().focus());
    await act(async () => row().click());
    expect(document.activeElement).toBe(heading());
    await act(async () => button('当前题目')?.click());
    expect(document.activeElement).toBe(heading());

    // A refresh replaces the open item, and what is being typed in keeps the caret.
    const search = searchInput()!;
    await act(async () => search.focus());
    await act(async () => changeInput(search, 'a'));
    expect(document.activeElement).toBe(search);
    await renderLibrary({ revision: 1 });
    expect(document.activeElement).toBe(search);
  });

  it('keeps failures visible when pausing or deleting a question', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.updateItem.mockRejectedValueOnce(new Error('Pause failed'));
    mocks.deleteItem.mockRejectedValueOnce(new Error('Delete failed'));
    await renderLibrary();
    await act(async () => button('暂停复习')?.click());
    expect(container.querySelector('.notice.error')?.textContent).toContain('Pause failed');
    expect(spoken()).toBe('');
    await act(async () => button('删除回忆题')?.click());
    expect(container.querySelector('.notice.error')?.textContent).toContain('Delete failed');
    expect(spoken()).toBe('');
  });

  it('speaks a source that opened and warns only when it did not', async () => {
    await renderLibrary();
    await act(async () => button('打开来源')?.click());
    expect(spoken()).toBe('已打开来源，定位到 00:42。');
    expect(container.querySelector('.notice')).toBeNull();

    mocks.openSourceAtTimestamp.mockResolvedValueOnce({
      ok: false,
      attempts: 1,
      timestampSeconds: 42,
      error: null,
      diagnostics: [],
    });
    await act(async () => button('打开来源')?.click());
    expect(container.querySelector('.notice.warning')?.textContent).toBe(
      '已打开，请手动跳到 00:42。',
    );
  });

  it('speaks creating and renaming a category, and keeps its failures visible', async () => {
    const created = category('created', 'Created');
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 1, dueCount: 1, nextReviewAt: now },
      { category: created, totalCount: 0, dueCount: 0, nextReviewAt: null },
    ]);
    await renderLibrary();
    await act(async () => button('新建分类')?.click());
    await act(async () => changeInput(fieldInput('新分类名称'), 'Created'));
    mocks.createCategory.mockRejectedValueOnce(new Error('Create failed'));
    await act(async () => button('创建')?.click());
    expect(container.querySelector('.notice.error')?.textContent).toContain('Create failed');

    mocks.createCategory.mockResolvedValueOnce(created);
    await act(async () => button('创建')?.click());
    expect(spoken()).toBe('已创建分类「Created」。');
    expect(container.querySelector('.notice')).toBeNull();

    mocks.renameCategory.mockResolvedValueOnce({ ...created, name: 'Renamed' });
    await act(async () => button('重命名')?.click());
    expect(spoken()).toBe('分类已重命名为「Renamed」。');
    expect(container.querySelector('.notice')).toBeNull();
  });

  it('still shows how many questions a category merge or delete moved', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tactics = category('tactics', 'Tactics');
    const utility = category('utility', 'Utility');
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: tactics, totalCount: 3, dueCount: 3, nextReviewAt: now },
      { category: utility, totalCount: 0, dueCount: 0, nextReviewAt: null },
    ]);
    mocks.mergeCategory.mockResolvedValue(3);
    mocks.deleteCategory.mockResolvedValue(2);
    await renderLibrary();
    await act(async () => changeSelect(fieldSelect('资料库分类'), tactics.id));
    await act(async () => button('合并')?.click());
    expect(mocks.mergeCategory).toHaveBeenCalledWith(tactics.id, utility.id);
    expect(container.querySelector('.library-toast [role="status"]')?.textContent).toBe(
      '分类已合并。已移动 3 道回忆题。',
    );

    await act(async () => button('删除分类')?.click());
    expect(mocks.deleteCategory).toHaveBeenCalledWith(utility.id);
    expect(container.querySelector('.library-toast [role="status"]')?.textContent).toBe(
      '分类已删除。已将 2 道回忆题移到未分类。',
    );
  });

  it('renders several hundred lightweight items without per-row transition names', async () => {
    const manyItems = Array.from({ length: 300 }, (_, index) =>
      youtubeItem({
        id: `item-${index}`,
        videoId: `video-${index}`,
        videoTitle: `Lesson ${index}`,
      }),
    );
    mocks.listItems.mockResolvedValue(manyItems);

    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll('.library-row')).toHaveLength(300);
    expect(container.querySelectorAll('[style*="view-transition-name"]')).toHaveLength(0);
  });

  it('removes grouped spatial disclosure immediately in reduced motion', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    await act(async () => {
      root.render(
        <LibraryView revision={0} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });

    await act(async () => changeSelect(arrangementSelect(), 'sources'));
    await act(async () => button('展开')?.click());
    expect(container.querySelector('.source-group-items')).not.toBeNull();
    await act(async () => button('收起')?.click());
    expect(container.querySelector('.source-group-items')).toBeNull();
  });

  it('shows one Key takeaway editor and clears a hidden duplicate only on explicit Save', async () => {
    mocks.listItems.mockResolvedValue([youtubeItem({ personalNote: '  Hold\n  the angle.  ' })]);
    await renderLibrary();

    expect(container.textContent).not.toContain('Personal note');
    expect(container.textContent).not.toContain('旧版备注');
    await act(async () => button('编辑')?.click());

    expect(fieldTextarea('答案要点')?.value).toBe('Hold the angle.');
    expect(container.textContent).toContain('复习时揭晓。');
    expect(container.textContent).not.toContain('Personal note');
    expect(container.textContent).not.toContain('旧版备注');
    expect(mocks.updateItem).not.toHaveBeenCalled();

    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateItem).toHaveBeenCalledWith(
      'youtube-item',
      expect.objectContaining({
        coreLesson: 'Hold the angle.',
        personalNote: '',
      }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
  });

  it('shows a distinct Legacy note only in Library and stages merge until Save', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({ personalNote: 'Use utility before taking the angle.' }),
    ]);
    await renderLibrary();

    expect(container.querySelector('.library-directory')?.textContent).not.toContain(
      'Use utility before taking the angle.',
    );
    await act(async () => button('编辑')?.click());
    expect(container.textContent).toContain('旧版备注');
    expect(container.textContent).toContain('Use utility before taking the angle.');

    await act(async () => button('合并到答案要点')?.click());
    expect(fieldTextarea('答案要点')?.value).toBe(
      'Hold the angle.\n\nUse utility before taking the angle.',
    );
    expect(mocks.updateItem).not.toHaveBeenCalled();

    await act(async () => button('收起编辑')?.click());
    expect(mocks.updateItem).not.toHaveBeenCalled();
    await act(async () => button('编辑')?.click());
    expect(fieldTextarea('答案要点')?.value).toBe('Hold the angle.');

    await act(async () => button('合并到答案要点')?.click());
    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateItem).toHaveBeenCalledWith(
      'youtube-item',
      expect.objectContaining({
        coreLesson: 'Hold the angle.\n\nUse utility before taking the angle.',
        personalNote: '',
      }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
  });

  it('stages an explicit Legacy note discard without changing the Key takeaway', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({ personalNote: 'Old wording that is no longer wanted.' }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    await act(async () => button('丢弃旧版备注')?.click());
    expect(fieldTextarea('答案要点')?.value).toBe('Hold the angle.');
    expect(mocks.updateItem).not.toHaveBeenCalled();

    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'youtube-item',
      expect.objectContaining({ coreLesson: 'Hold the angle.', personalNote: '' }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
  });

  it('prefills an empty Key takeaway from a legacy note and moves it only on Save', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({ coreLesson: ' ', personalNote: 'Keep the crosshair at head height.' }),
    ]);
    await renderLibrary();
    expect(container.querySelector('.library-directory')?.textContent).not.toContain(
      'Keep the crosshair at head height.',
    );

    await act(async () => button('编辑')?.click());
    expect(fieldTextarea('答案要点')?.value).toBe('Keep the crosshair at head height.');
    expect(mocks.updateItem).not.toHaveBeenCalled();

    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'youtube-item',
      expect.objectContaining({
        coreLesson: 'Keep the crosshair at head height.',
        personalNote: '',
      }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
  });

  it.each([
    [
      'YouTube',
      () =>
        youtubeItem({
          subtitleBefore: ['Prepare utility.', 'Hold the angle.'],
          subtitleCurrent: ['Commit after the cue.', 'Commit after the cue.'],
          subtitleAfter: ['Commit after the cue.', 'Exit safely.'],
          reason: '  Commit after the cue.  ',
        }),
    ],
    [
      'Bilibili',
      () =>
        youtubeItem({
          platform: 'bilibili',
          sourceUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
          canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
          videoId: 'BV1Ab411c7Cd',
          videoTitle: 'Bilibili lesson',
          subtitleBefore: ['Prepare utility.', 'Hold the angle.'],
          subtitleCurrent: ['Commit after the cue.'],
          subtitleAfter: ['Commit after the cue.', 'Exit safely.'],
          reason: 'Commit after the cue.',
        }),
    ],
    [
      'Douyin',
      () =>
        douyinItem({
          subtitleBefore: ['Prepare utility.', 'Hold the angle.'],
          subtitleCurrent: ['Commit after the cue.'],
          subtitleAfter: ['Commit after the cue.', 'Exit safely.'],
          reason: 'Commit after the cue.',
        }),
    ],
  ] as const)(
    'keeps captured %s evidence in one secondary Source context disclosure',
    async (platform, createItem) => {
      mocks.listItems.mockResolvedValue([createItem()]);
      await renderLibrary();
      await act(async () => button('编辑')?.click());

      const editor = container.querySelector('[data-library-editor-for]');
      const sourceContext = editor?.querySelector<HTMLDetailsElement>(
        'details.source-context-disclosure',
      );
      expect(sourceContext).toBeDefined();
      expect(sourceContext?.open).toBe(false);
      expect(sourceContext?.querySelector('summary')?.textContent).toBe(
        `捕获自 ${platform} · 00:42`,
      );
      const metadataLabels = [...(sourceContext?.querySelectorAll('dt') ?? [])].map(
        (entry) => entry.textContent,
      );
      expect(metadataLabels).not.toContain('Platform');
      expect(metadataLabels).not.toContain('Timestamp');
      expect(metadataLabels).not.toContain('Source');
      expect(sourceContext?.querySelector('.screenshot')).not.toBeNull();
      expect(buttonWithin(sourceContext ?? undefined, '打开来源')).toBeDefined();
      expect(
        [...(editor?.querySelectorAll('button') ?? [])].filter(
          (candidate) => candidate.textContent === '打开来源',
        ),
      ).toHaveLength(1);
      expect(
        [...container.querySelectorAll('button')].filter(
          (candidate) => candidate.textContent === '打开来源',
        ),
      ).toHaveLength(1);
      expect(
        [...(sourceContext?.querySelectorAll('.source-context-lines p') ?? [])].map(
          (line) => line.textContent,
        ),
      ).toEqual(['Hold the angle.', 'Commit after the cue.']);
      expect(fieldTextarea('Reason')).toBeUndefined();
      expect(sourceContext?.textContent?.match(/Commit after the cue\./g)).toHaveLength(1);
      expect(editor?.textContent).not.toContain('旧版解释');
    },
  );

  it('keeps one captured Bilibili overlay cue inspectable in Library Source context', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({
        platform: 'bilibili',
        sourceUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
        canonicalUrl: 'https://www.bilibili.com/video/BV1Ab411c7Cd',
        videoId: 'BV1Ab411c7Cd',
        subtitleBefore: [],
        subtitleCurrent: ['这是当前正在播放的字幕'],
        subtitleAfter: [],
      }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    const sourceContext = editor?.querySelector<HTMLDetailsElement>(
      'details.source-context-disclosure',
    );
    expect(sourceContext?.open).toBe(false);
    expect(
      [...(sourceContext?.querySelectorAll('.source-context-lines p') ?? [])].map(
        (line) => line.textContent,
      ),
    ).toEqual(['这是当前正在播放的字幕']);
    expect(sourceContext?.textContent?.match(/这是当前正在播放的字幕/g)).toHaveLength(1);
  });

  it('shows a distinct Reason only as a readonly Legacy explanation and omits it from updates', async () => {
    const exactLegacyReason = '  My own explanation stays exact.\nKeep this second line.  ';
    const learningItem = youtubeItem({
      reason: exactLegacyReason,
      subtitleCurrent: ['Different nearby source evidence.'],
    });
    mocks.listItems.mockResolvedValue([learningItem]);
    mocks.updateItem.mockResolvedValue(learningItem);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    const legacyExplanation = [...(editor?.querySelectorAll('details') ?? [])].find(
      (details) => details.querySelector('summary')?.textContent === '旧版解释',
    );
    expect(legacyExplanation).toBeDefined();
    expect(legacyExplanation?.open).toBe(false);
    expect(legacyExplanation?.querySelector('blockquote')?.textContent).toBe(exactLegacyReason);
    expect(fieldTextarea('Reason')).toBeUndefined();

    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const changes = mocks.updateItem.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(changes).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(changes, 'reason')).toBe(false);
    expect(learningItem.reason).toBe(exactLegacyReason);
  });

  it('shows a whitespace-duplicate Reference answer only once as the Key takeaway', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({
        coreLesson: 'Hold the angle.',
        referenceAnswer: '  Hold\u00a0 the\nangle.  ',
      }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    expect(fieldTextarea('答案要点')?.value).toBe('Hold the angle.');
    expect(fieldTextarea('Reference answer')).toBeUndefined();
    expect(
      [...(editor?.querySelectorAll('summary') ?? [])].some(
        (summary) => summary.textContent === '旧版答案',
      ),
    ).toBe(false);
  });

  it('does not repeat a Reference answer when an older Personal note supplies the visible Key takeaway', async () => {
    mocks.listItems.mockResolvedValue([
      textItem({
        coreLesson: '  ',
        personalNote: 'Hold the inherited angle.',
        referenceAnswer: '  Hold\u00a0the inherited\nangle.  ',
      }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    expect(fieldTextarea('答案要点')?.value).toBe('Hold the inherited angle.');
    expect(
      [...(editor?.querySelectorAll('summary') ?? [])].some(
        (summary) => summary.textContent === '旧版答案',
      ),
    ).toBe(false);
  });

  it.each([
    ['Video', () => youtubeItem()],
    ['Text', () => textItem()],
    ['Image', () => imageItem()],
  ] as const)(
    'preserves a distinct legacy Reference answer exactly for a %s Moment',
    async (_source, createItem) => {
      const exactLegacyAnswer = '  A distinct earlier answer.\nKeep its second line.  ';
      const learningItem = createItem();
      const itemWithLegacyAnswer = {
        ...learningItem,
        coreLesson: 'The canonical Key takeaway.',
        referenceAnswer: exactLegacyAnswer,
      };
      mocks.listItems.mockResolvedValue([itemWithLegacyAnswer]);
      mocks.updateItem.mockResolvedValue(itemWithLegacyAnswer);
      await renderLibrary();
      await act(async () => button('编辑')?.click());

      const editor = container.querySelector('[data-library-editor-for]');
      const legacyAnswer = [...(editor?.querySelectorAll('details') ?? [])].find(
        (details) => details.querySelector('summary')?.textContent === '旧版答案',
      );
      expect(legacyAnswer).toBeDefined();
      expect(legacyAnswer?.open).toBe(false);
      expect(legacyAnswer?.querySelector('textarea, input')).toBeNull();
      expect(legacyAnswer?.querySelector('blockquote')?.textContent).toBe(exactLegacyAnswer);
      expect(fieldTextarea('Reference answer')).toBeUndefined();

      await act(async () => changeTextarea(fieldTextarea('问题'), 'Edited recall cue?'));
      await act(async () => {
        button('保存更改')?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      const changes = mocks.updateItem.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(changes).toBeDefined();
      expect(changes?.recallPrompt).toBe('Edited recall cue?');
      expect(Object.prototype.hasOwnProperty.call(changes, 'referenceAnswer')).toBe(false);
      expect(itemWithLegacyAnswer.referenceAnswer).toBe(exactLegacyAnswer);
    },
  );

  it('ignores an empty legacy Reference answer in the editor', async () => {
    mocks.listItems.mockResolvedValue([textItem({ referenceAnswer: ' \n\t ' })]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    expect(fieldTextarea('Reference answer')).toBeUndefined();
    expect(editor?.textContent).not.toContain('旧版答案');
  });

  it('keeps legacy structured fields editable but secondary and does not duplicate Reason', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({
        situation: 'Holding the site.',
        mistakeToAvoid: 'Do not swing early.',
        recommendedAction: 'Wait for the cue.',
        reason: 'Do not swing early.',
      }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    const structured = [...(editor?.querySelectorAll('details') ?? [])].find(
      (details) => details.querySelector('summary')?.textContent === '旧版结构化字段',
    );
    expect(structured).toBeDefined();
    expect(structured?.open).toBe(false);
    expect(fieldTextarea('情境')?.value).toBe('Holding the site.');
    expect(fieldTextarea('需要避免的错误')?.value).toBe('Do not swing early.');
    expect(fieldTextarea('建议行动')?.value).toBe('Wait for the cue.');
    expect(editor?.textContent).not.toContain('旧版解释');
    expect(fieldTextarea('Reason')).toBeUndefined();
  });

  it('keeps Library-created video metadata inspectable without captured media or captions', async () => {
    mocks.listItems.mockResolvedValue([
      youtubeItem({
        sourceType: 'video',
        videoOrigin: 'library',
        screenshotId: 'unexpected-captured-image',
        subtitleCurrent: ['This should not be presented as captured context.'],
      }),
    ]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    const sourceContext = editor?.querySelector<HTMLDetailsElement>(
      'details.source-context-disclosure',
    );
    expect(sourceContext?.textContent).toContain('YouTube');
    expect(sourceContext?.textContent).not.toContain('This should not be presented');
    expect(sourceContext?.textContent).not.toContain('no captured caption context');
    expect(sourceContext?.querySelector('.source-context-lines')).toBeNull();
    expect(sourceContext?.querySelector('.screenshot')).toBeNull();
  });

  it.each([
    ['Text', () => textItem()],
    ['Image', () => imageItem()],
  ] as const)('does not add video Source context to a %s Moment', async (_kind, createItem) => {
    mocks.listItems.mockResolvedValue([createItem()]);
    await renderLibrary();
    await act(async () => button('编辑')?.click());

    const editor = container.querySelector('[data-library-editor-for]');
    expect(
      [...(editor?.querySelectorAll('summary') ?? [])].some(
        (summary) => summary.textContent === '来源上下文',
      ),
    ).toBe(false);
    expect(editor?.textContent).not.toContain('Platform');
  });

  it('navigates by Category and changes one Moment Category only from Library edit', async () => {
    const tactics = {
      id: 'category-tactics',
      schemaVersion: 1 as const,
      name: 'Tactics',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    const utility = { ...tactics, id: 'category-utility', name: 'Utility' };
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: tactics, totalCount: 1, dueCount: 1, nextReviewAt: now },
      { category: utility, totalCount: 0, dueCount: 0, nextReviewAt: null },
    ]);
    mocks.listItems.mockResolvedValue([youtubeItem({ categoryId: tactics.id })]);

    await renderLibrary();
    const tacticsButton = [...container.querySelectorAll('.category-navigation-button')].find(
      (candidate) => candidate.textContent?.includes('Tactics'),
    );
    await act(async () => {
      (tacticsButton as HTMLButtonElement | undefined)?.click();
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: tactics.id }),
    );
    expect(button('重命名')).toBeDefined();
    expect(button('合并')).toBeDefined();
    expect(button('删除分类')).toBeDefined();

    await act(async () => button('编辑')?.click());
    const categorySelect = fieldSelect(
      '分类',
      container.querySelector('[data-library-editor-for="youtube-item"]'),
    );
    await act(async () => {
      if (!categorySelect) throw new Error('Expected the Moment Category selector.');
      categorySelect.value = utility.id;
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.updateItem).toHaveBeenCalledWith(
      'youtube-item',
      expect.objectContaining({ categoryId: utility.id }),
      expect.objectContaining({ expectedState: expect.any(String) }),
    );
  });

  it('keeps Category as the primary scope while applying and clearing Source', async () => {
    const valorant = category('category-valorant', 'Valorant');
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: valorant, totalCount: 2, dueCount: 1, nextReviewAt: now },
    ]);
    mocks.listItems.mockResolvedValue([youtubeItem({ categoryId: valorant.id })]);
    await renderLibrary();

    const valorantButton = [...container.querySelectorAll('.category-navigation-button')].find(
      (candidate) => candidate.textContent?.includes('Valorant'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      valorantButton?.click();
      await Promise.resolve();
    });
    expect(valorantButton?.getAttribute('aria-current')).toBe('page');
    expect(searchInput()?.placeholder).toBe('在「Valorant」中搜索');

    const platform = fieldSelect('按来源筛选');
    await act(async () => {
      changeSelect(platform, 'youtube');
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: valorant.id, source: 'youtube' }),
    );
    expect(platform?.classList.contains('active-filter')).toBe(true);

    await act(async () => {
      changeSelect(platform, 'all');
      await Promise.resolve();
    });
    const clearedOptions = mocks.listItems.mock.lastCall?.[0] as Record<string, unknown>;
    expect(clearedOptions).toEqual(expect.objectContaining({ categoryId: valorant.id }));
    expect(clearedOptions).not.toHaveProperty('source');
    expect(valorantButton?.getAttribute('aria-current')).toBe('page');
    expect(platform?.classList.contains('active-filter')).toBe(false);
  });

  it('scopes the single Moment search to the selected Category and keeps All Moments unscoped', async () => {
    const valorant = category('category-valorant', 'Valorant');
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: valorant, totalCount: 1, dueCount: 1, nextReviewAt: now },
    ]);
    await renderLibrary();

    expect(container.querySelectorAll('input[aria-label="搜索回忆题"]')).toHaveLength(1);
    expect(searchInput()?.placeholder).toBe('搜索全部回忆题');
    await act(async () => {
      changeInput(searchInput(), 'crosshair');
      await Promise.resolve();
    });
    const allOptions = mocks.listItems.mock.lastCall?.[0] as Record<string, unknown>;
    expect(allOptions).toEqual(expect.objectContaining({ query: 'crosshair' }));
    expect(allOptions).not.toHaveProperty('categoryId');

    const valorantButton = [...container.querySelectorAll('.category-navigation-button')].find(
      (candidate) => candidate.textContent?.includes('Valorant'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      valorantButton?.click();
      await Promise.resolve();
    });
    expect(searchInput()?.value).toBe('crosshair');
    expect(searchInput()?.placeholder).toBe('在「Valorant」中搜索');
    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: valorant.id, query: 'crosshair' }),
    );

    const allButton = [...container.querySelectorAll('.category-navigation-button')].find(
      (candidate) => candidate.textContent?.includes('全部回忆题'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      allButton?.click();
      await Promise.resolve();
    });
    const restoredAllOptions = mocks.listItems.mock.lastCall?.[0] as Record<string, unknown>;
    expect(restoredAllOptions).toEqual(expect.objectContaining({ query: 'crosshair' }));
    expect(restoredAllOptions).not.toHaveProperty('categoryId');
  });

  it('shows Category search only for a large list and never duplicates it in Library editing', async () => {
    await renderLibrary();
    expect(container.querySelectorAll('input[placeholder="搜索分类"]')).toHaveLength(0);

    const manyCategories = Array.from({ length: 13 }, (_, index) =>
      category(`category-${index}`, `Category ${index}`),
    );
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 1, dueCount: 1, nextReviewAt: now },
      ...manyCategories.map((entry) => ({
        category: entry,
        totalCount: 0,
        dueCount: 0,
        nextReviewAt: null,
      })),
    ]);
    await act(async () => {
      root.render(
        <LibraryView revision={1} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      );
      await Promise.resolve();
    });
    expect(container.querySelectorAll('input[placeholder="搜索分类"]')).toHaveLength(1);

    await act(async () => button('编辑')?.click());
    expect(container.querySelectorAll('input[placeholder="搜索分类"]')).toHaveLength(1);
    expect(fieldSelect('分类', container.querySelector('.motion-reveal'))).toBeDefined();
  });

  it('uses one compact accessible toolbar and selects sorting or source grouping', async () => {
    const older = youtubeItem({
      id: 'older',
      videoTitle: 'Older lesson',
      updatedAt: new Date('2026-07-20T12:00:00.000Z'),
    });
    const newer = youtubeItem({
      id: 'newer',
      videoTitle: 'Newer lesson',
      updatedAt: new Date('2026-07-22T12:00:00.000Z'),
    });
    const douyin = douyinItem({ videoTitle: 'Douyin lesson' });
    mocks.listItems.mockResolvedValue([newer, older, douyin]);
    await renderLibrary();

    const toolbar = container.querySelector('.library-toolbar');
    expect(container.querySelector('.library-query')?.getAttribute('aria-label')).toBe(
      '回忆题筛选与排列',
    );
    expect(toolbar?.querySelectorAll('select')).toHaveLength(4);
    expect(container.querySelector('details.library-filter-disclosure')?.hasAttribute('open')).toBe(
      false,
    );
    expect(searchInput()?.closest('details')).toBeNull();
    expect(container.querySelector('.library-view-switcher')).toBeNull();
    expect(button('Items')).toBeUndefined();
    expect(button('Grouped by source')).toBeUndefined();
    expect(arrangementSelect()?.getAttribute('aria-label')).toBe('排序或分组回忆题');

    await act(async () => changeSelect(arrangementSelect(), 'oldest'));
    expect(
      [...container.querySelectorAll<HTMLElement>('.library-row')].map(
        (row) => row.dataset.libraryItemId,
      ),
    ).toEqual(['older', 'douyin-item', 'newer']);

    await act(async () => changeSelect(arrangementSelect(), 'source-types'));
    expect(arrangementSelect()?.value).toBe('source-types');
    expect(
      [...container.querySelectorAll<HTMLElement>('.platform-group-heading h3')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(['YouTube', 'Douyin']);
    expect(container.querySelectorAll('.platform-group .library-row')).toHaveLength(3);

    await act(async () => changeSelect(arrangementSelect(), 'sources'));
    expect(arrangementSelect()?.value).toBe('sources');
    expect(container.querySelector('.source-group-list')).not.toBeNull();
  });

  it('provides responsive Category navigation and moves keyboard focus into creation', async () => {
    await renderLibrary();
    const responsiveSelect = container.querySelector<HTMLSelectElement>(
      '.category-mobile-picker select[aria-label="资料库分类"]',
    );
    expect(responsiveSelect).not.toBeNull();
    expect(globalCss).toMatch(
      /\.dashboard-main\s*\{[^}]*container: dashboard-main \/ inline-size[^}]*\}[\s\S]*?@container dashboard-main \(max-width: 60em\)[\s\S]*?\.category-desktop-navigation\s*\{[\s\S]*?display: none[\s\S]*?\.category-mobile-picker\s*\{[\s\S]*?display: grid/,
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.library-toolbar\s*\{[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.library-row\.text-moment-row\s*\{\s*grid-template-columns: 1fr/,
    );

    const newCategoryButton = button('新建分类');
    newCategoryButton?.focus();
    expect(document.activeElement).toBe(newCategoryButton);
    await act(async () => newCategoryButton?.click());
    const nameInput = fieldInput('新分类名称');
    expect(nameInput).toBe(document.activeElement);
    expect(nameInput?.maxLength).toBe(80);
  });

  it('speaks an updated item instead of showing a toast', async () => {
    await renderLibrary();
    await act(async () => button('编辑')?.click());
    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(spoken()).toBe('回忆题已更新。');
    expect(container.querySelector('.library-toast')).toBeNull();
    expect(container.querySelector('.notice')).toBeNull();
  });

  it('lets a category move toast expire on its own', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tactics = category('tactics', 'Tactics');
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: tactics, totalCount: 2, dueCount: 2, nextReviewAt: now },
    ]);
    mocks.deleteCategory.mockResolvedValue(2);
    await renderLibrary();
    await act(async () => changeSelect(fieldSelect('资料库分类'), tactics.id));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => button('删除分类')?.click());
    expect(container.querySelector('.library-toast')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(container.querySelector('.library-toast')).toBeNull();
  });

  it('persists an edit before collapsing and keeps the focused summary visibly anchored', async () => {
    let resolveUpdate: ((item: VideoLearningItem) => void) | undefined;
    mocks.updateItem.mockImplementation(
      () =>
        new Promise<VideoLearningItem>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    await renderLibrary();
    const originalSummary = container.querySelector<HTMLElement>(
      '[data-library-item-summary="youtube-item"]',
    );
    vi.spyOn(originalSummary!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: -120,
      width: 200,
      height: 40,
      top: -120,
      right: 200,
      bottom: -80,
      left: 0,
      toJSON: () => ({}),
    });

    await act(async () => button('编辑')?.click());
    await act(async () => changeTextarea(fieldTextarea('视频标题'), 'Updated video lesson'));
    await act(async () => button('保存更改')?.click());

    expect(mocks.updateItem).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-library-editor-for]')).not.toBeNull();
    expect(
      container
        .querySelector('[data-library-editor-for="youtube-item"] fieldset')
        ?.hasAttribute('disabled'),
    ).toBe(true);

    await act(async () => {
      resolveUpdate?.(
        youtubeItem({
          videoTitle: 'Updated video lesson',
          updatedAt: new Date('2026-07-22T12:01:00.000Z'),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const summary = container.querySelector<HTMLElement>(
      '[data-library-item-summary="youtube-item"]',
    );
    expect(summary?.textContent).toBe('Updated video lesson');
    expect(container.querySelector('[data-library-editor-for]')).toBeNull();
    expect(container.querySelector('#library-editor-youtube-item')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.library-detail-heading h3'));
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(spoken()).toBe('回忆题已更新。');
  });

  it('retains dirty edits across failed draft retention and external refresh', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderLibrary();
    await act(async () => button('编辑')!.click());
    await act(async () => changeTextarea(fieldTextarea('问题'), 'Keep this unsaved prompt?'));
    vi.mocked(DraftRepository.prototype.save).mockRejectedValueOnce(
      new Error('Draft retention failed'),
    );
    await act(async () => changeInput(searchInput(), 'different scope'));
    expect(confirm).not.toHaveBeenCalled();
    expect(searchInput()?.value).toBe('');
    expect(fieldTextarea('问题')?.value).toBe('Keep this unsaved prompt?');
    mocks.listItems.mockResolvedValue([
      youtubeItem({ updatedAt: new Date('2026-09-01'), recallPrompt: 'External change?' }),
    ]);
    await act(async () =>
      root.render(
        <LibraryView revision={1} preferences={DEFAULT_PREFERENCES} onChanged={vi.fn()} />,
      ),
    );
    expect(fieldTextarea('问题')?.value).toBe('Keep this unsaved prompt?');
    await act(async () => changeInput(searchInput(), 'new scope'));
    expect(confirm).not.toHaveBeenCalled();
    expect(JSON.stringify([...drafts.values()])).toContain('Keep this unsaved prompt?');
    expect(searchInput()?.value).toBe('new scope');
    expect(container.querySelector('[data-library-editor-for]')).toBeNull();
  });

  it('keeps an edited Moment open with its exact draft after validation or persistence failure', async () => {
    await renderLibrary();
    await act(async () => button('编辑')?.click());
    await act(async () => changeTextarea(fieldTextarea('问题'), ''));
    await act(async () => button('保存更改')?.click());

    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(container.querySelector('[data-library-editor-for]')).not.toBeNull();
    expect(fieldTextarea('问题')?.value).toBe('');
    expect(container.querySelector('[data-edit-error]')?.textContent).toContain('不能为空');
    expect(
      container.querySelectorAll('[data-library-editor-for="youtube-item"] [role="alert"]'),
    ).toHaveLength(1);

    await act(async () => changeTextarea(fieldTextarea('问题'), '  Keep my exact draft?  '));
    mocks.updateItem.mockRejectedValueOnce(new Error('Local write failed.'));
    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-library-editor-for]')).not.toBeNull();
    expect(fieldTextarea('问题')?.value).toBe('  Keep my exact draft?  ');
    expect(container.querySelector('[data-edit-error]')?.textContent).toContain(
      'Local write failed.',
    );
    expect(container.querySelector('.library-toast')).toBeNull();
  });

  it('prevents another editor from replacing the originating draft while a save is pending', async () => {
    let resolveUpdate: ((item: VideoLearningItem) => void) | undefined;
    mocks.listItems.mockResolvedValue([youtubeItem(), douyinItem()]);
    mocks.updateItem.mockImplementation(
      () =>
        new Promise<VideoLearningItem>((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    await renderLibrary();

    const youtubeRow = container.querySelector('[data-library-item-id="youtube-item"]');
    const douyinRow = container.querySelector('[data-library-item-id="douyin-item"]');
    await act(async () =>
      youtubeRow?.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    await act(async () => button('编辑')?.click());
    await act(async () => button('保存更改')?.click());

    const editButtons = [...container.querySelectorAll<HTMLButtonElement>('.library-row button')];
    expect(editButtons).toHaveLength(2);
    expect(editButtons.every((candidate) => candidate.disabled)).toBe(true);
    await act(async () =>
      douyinRow?.querySelector<HTMLButtonElement>('[data-library-read-button]')?.click(),
    );
    expect(container.querySelector('[data-library-editor-for="douyin-item"]')).toBeNull();
    expect(container.querySelector('[data-library-editor-for="youtube-item"]')).not.toBeNull();

    await act(async () => {
      resolveUpdate?.(youtubeItem({ updatedAt: new Date('2026-07-22T12:03:00.000Z') }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-library-editor-for="youtube-item"]')).toBeNull();
    expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe(
      'YouTube lesson',
    );
  });

  it('cancels an inline edit without saving or success feedback and restores summary focus', async () => {
    await renderLibrary();
    await act(async () => button('编辑')?.click());
    const draft = fieldTextarea('答案要点');
    await act(async () => {
      changeTextarea(draft, 'Unsaved change');
      draft?.focus();
      button('收起编辑')?.click();
    });

    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(container.querySelector('[data-library-editor-for]')).toBeNull();
    expect(container.querySelector('.library-toast')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.library-detail-heading h3'));
  });

  it('collapses editing immediately under reduced motion without a page transition', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const startViewTransition = vi.fn();
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: startViewTransition,
    });
    mocks.updateItem.mockResolvedValue(
      youtubeItem({ updatedAt: new Date('2026-07-22T12:02:00.000Z') }),
    );
    await renderLibrary();
    await act(async () => button('编辑')?.click());
    await act(async () => {
      button('保存更改')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-library-editor-for="youtube-item"]')).toBeNull();
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it('filters Text within the selected Category and edits it without source controls', async () => {
    const valorant = category('category-valorant', 'Valorant');
    const text = textItem({ categoryId: valorant.id });
    mocks.listCategorySummaries.mockResolvedValue([
      { category: null, totalCount: 0, dueCount: 0, nextReviewAt: null },
      { category: valorant, totalCount: 1, dueCount: 1, nextReviewAt: now },
    ]);
    mocks.listItems.mockResolvedValue([text]);
    await renderLibrary();

    const valorantButton = [...container.querySelectorAll('.category-navigation-button')].find(
      (candidate) => candidate.textContent?.includes('Valorant'),
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      valorantButton?.click();
      await Promise.resolve();
      changeSelect(fieldSelect('按来源筛选'), 'text');
      await Promise.resolve();
    });
    expect(mocks.listItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ categoryId: valorant.id, source: 'text' }),
    );
    expect(container.textContent).toContain('Text lesson');
    expect(container.textContent).not.toContain('Open source');

    await act(async () => button('编辑')?.click());
    expect(fieldInput('标题')).toBeUndefined();
    expect(fieldTextarea('标题')?.value).toBe('Text lesson');
    expect(container.querySelector('.screenshot')).toBeNull();
    expect(container.textContent).not.toContain('Platform');
  });

  it('keeps the thirtieth question, category filter, search and directory scroll after moving its category', async () => {
    const originalCategory = category('original', '原分类');
    const nextCategory = category('next', '新分类');
    const items = Array.from({ length: 30 }, (_, index) =>
      textItem({
        id: `item-${index}`,
        title: `Question ${index + 1}`,
        categoryId: originalCategory.id,
      }),
    );
    mocks.listCategorySummaries.mockResolvedValue([
      { category: originalCategory, totalCount: 30, dueCount: 30, nextReviewAt: now },
      { category: nextCategory, totalCount: 0, dueCount: 0, nextReviewAt: null },
    ]);
    mocks.listItems.mockResolvedValue(items);
    await renderLibrary();
    await act(async () => changeSelect(fieldSelect('资料库分类'), originalCategory.id));
    await act(async () => changeInput(searchInput(), 'Question'));
    const results = container.querySelector<HTMLElement>('.library-results')!;
    results.scrollTop = 880;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button="item-29"]')!.click(),
    );
    await act(async () => button('编辑')!.click());
    await act(async () =>
      changeSelect(
        fieldSelect('分类', container.querySelector('[data-library-editor-for]')),
        nextCategory.id,
      ),
    );
    const updated = { ...items[29]!, categoryId: nextCategory.id, coreLesson: 'Updated answer' };
    mocks.updateItem.mockResolvedValue(updated);
    await act(async () => button('保存更改')!.click());
    mocks.listItems.mockResolvedValue(items.slice(0, 29));
    await renderLibrary({ revision: 1 });
    expect(searchInput()?.value).toBe('Question');
    expect(fieldSelect('资料库分类')?.value).toBe(originalCategory.id);
    expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe('Question 30');
    expect(container.querySelector('.library-reading-answer')?.textContent).toBe('Updated answer');
    expect(container.textContent).not.toContain('这道题不在当前筛选结果里。');
    expect(container.querySelector('.library-results')).toBe(results);
    expect(results.scrollTop).toBe(880);
    expect(mocks.updateItem).toHaveBeenCalledTimes(1);
  });

  it('keeps directory order after a saved item would move to the top on refresh', async () => {
    const first = textItem({ id: 'first', title: 'First' });
    const second = textItem({ id: 'second', title: 'Second' });
    mocks.listItems.mockResolvedValue([first, second]);
    await renderLibrary();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-library-read-button="second"]')!.click(),
    );
    await act(async () => button('编辑')!.click());
    mocks.updateItem.mockResolvedValue({ ...second, updatedAt: new Date('2026-10-01') });
    await act(async () => button('保存更改')!.click());
    mocks.listItems.mockResolvedValue([second, first]);
    await renderLibrary({ revision: 1 });
    expect(
      [...container.querySelectorAll('[data-library-item-id]')].map((row) =>
        row.getAttribute('data-library-item-id'),
      ),
    ).toEqual(['first', 'second']);
  });

  it('returns to the same directory entry without mounting an editor in its row', async () => {
    await renderLibrary();
    const trigger = container.querySelector<HTMLButtonElement>('[data-library-read-button]')!;
    await act(async () => trigger.click());
    expect(container.querySelector('.library-learning-workspace')?.getAttribute('data-pane')).toBe(
      'content',
    );
    expect(container.querySelector('.library-row .library-reading')).toBeNull();
    expect(container.querySelectorAll('.library-detail .library-reading')).toHaveLength(1);
    await act(async () => {
      button('返回目录')!.click();
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(container.querySelector('.library-learning-workspace')?.getAttribute('data-pane')).toBe(
      'directory',
    );
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-current')).toBe('true');
    expect(workspaceCss).toContain('@container library-workspace (width < 52em)');
    expect(workspaceCss).toContain('minmax(0, 0.36fr) minmax(0, 0.64fr)');
  });

  it('keeps input when it changes during a pending draft write before switching questions', async () => {
    mocks.listItems.mockResolvedValue([youtubeItem(), douyinItem()]);
    await renderLibrary();
    await act(async () => button('编辑')!.click());
    await act(async () => changeTextarea(fieldTextarea('问题'), 'First draft'));
    const originalSave = vi.mocked(DraftRepository.prototype.save).getMockImplementation()!;
    let finishWrite: (() => void) | undefined;
    vi.mocked(DraftRepository.prototype.save).mockImplementationOnce(
      (input, revision) =>
        new Promise((resolve) => {
          finishWrite = () => {
            void originalSave(input, revision).then(resolve);
          };
        }),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-library-read-button="douyin-item"]')!
        .click(),
    );
    expect(finishWrite).toBeDefined();
    await act(async () => changeTextarea(fieldTextarea('问题'), 'Latest draft'));
    await act(async () => finishWrite!());
    expect(fieldTextarea('问题')?.value).toBe('Latest draft');
    expect(container.querySelector('[data-library-editor-for="youtube-item"]')).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-library-read-button="douyin-item"]')!
        .click(),
    );
    expect(container.querySelector('.library-detail-heading h3')?.textContent).toBe(
      'Douyin lesson',
    );
    expect(JSON.stringify([...drafts.values()])).toContain('Latest draft');
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('only discards an editing draft after confirmation and does not change the saved question', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderLibrary();
    await act(async () => button('编辑')!.click());
    await act(async () => changeTextarea(fieldTextarea('问题'), 'Discard this draft'));
    await act(async () => button('放弃修改')!.click());
    expect(fieldTextarea('问题')?.value).toBe('Discard this draft');
    confirm.mockReturnValue(true);
    await act(async () => button('放弃修改')!.click());
    expect(container.querySelector('[data-library-editor-for]')).toBeNull();
    expect(container.querySelector('.library-reading')?.textContent).toContain(
      'What should you do?',
    );
    expect([...drafts.values()]).toHaveLength(0);
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('does not focus or block navigation while the retained library is inactive', async () => {
    await renderLibrary();
    await act(async () => button('编辑')!.click());
    await act(async () => changeTextarea(fieldTextarea('问题'), 'Retained hidden draft'));
    await renderLibrary({ active: false });
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    mocks.listItems.mockResolvedValue([youtubeItem({ coreLesson: 'External update' })]);
    await renderLibrary({ active: false, revision: 1 });
    let allowed = false;
    await act(async () => {
      allowed = await requestEditorLeaveAsync();
    });
    expect(allowed).toBe(true);
    expect(document.activeElement).toBe(outside);
    expect(fieldTextarea('问题')?.value).toBe('Retained hidden draft');
    outside.remove();
  });

  async function renderLibrary(props: Partial<Parameters<typeof LibraryView>[0]> = {}) {
    await act(async () => {
      root.render(
        <LibraryView
          revision={0}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          {...props}
        />,
      );
      await Promise.resolve();
    });
  }

  function spoken(): string | null | undefined {
    return container.querySelector('.library-view > .sr-only[role="status"]')?.textContent;
  }

  function fieldTextarea(label: string): HTMLTextAreaElement | undefined {
    const field = [...container.querySelectorAll('label.field')].find(
      (candidate) => candidate.querySelector(':scope > span')?.textContent === label,
    );
    return field?.querySelector('textarea') ?? undefined;
  }

  function fieldSelect(
    label: string,
    scope: ParentNode | null = container,
  ): HTMLSelectElement | undefined {
    const target = scope ?? container;
    const labelledByText = [...target.querySelectorAll('label.field')].find(
      (candidate) => candidate.querySelector(':scope > span')?.textContent === label,
    );
    return (
      labelledByText?.querySelector('select') ??
      target.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ??
      undefined
    );
  }

  function fieldInput(label: string): HTMLInputElement | undefined {
    const field = [...container.querySelectorAll('label.field')].find(
      (candidate) => candidate.querySelector(':scope > span')?.textContent === label,
    );
    return field?.querySelector('input') ?? undefined;
  }

  function arrangementSelect(): HTMLSelectElement | undefined {
    return (
      container.querySelector<HTMLSelectElement>('select[aria-label="排序或分组回忆题"]') ??
      undefined
    );
  }

  function searchInput(): HTMLInputElement | undefined {
    return container.querySelector<HTMLInputElement>('input[aria-label="搜索回忆题"]') ?? undefined;
  }

  function changeSelect(select: HTMLSelectElement | undefined, value: string) {
    if (!select) throw new Error(`Expected a select before choosing ${value}.`);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function changeInput(input: HTMLInputElement | undefined, value: string) {
    if (!input) throw new Error('Expected an input.');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function changeTextarea(input: HTMLTextAreaElement | undefined, value: string) {
    if (!input) throw new Error('Expected a textarea.');
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function category(id: string, name: string) {
    return {
      id,
      schemaVersion: 1 as const,
      name,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }

  function buttonWithin(
    element: Element | undefined,
    label: string,
  ): HTMLButtonElement | undefined {
    if (!element) return undefined;
    return [...element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
  }
});
