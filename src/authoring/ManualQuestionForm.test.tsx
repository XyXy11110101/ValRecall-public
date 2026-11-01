import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository, type LearningItem } from '../database';
import { ManualQuestionForm, type ManualQuestionFormProps } from './ManualQuestionForm';
import { manualDraftValue, newManualDraft } from './manual-draft';
import type { ManualQuestionReceipt } from './save-manual';

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../shared/library-image', async (original) => ({
  ...(await original<typeof import('../shared/library-image')>()),
  prepareLibraryImage: mocks.prepare,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const loadCategories = async () => [
  {
    schemaVersion: 1 as const,
    id: 'first',
    name: 'First',
    color: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: new Date(),
  },
  {
    schemaVersion: 1 as const,
    id: 'second',
    name: 'Second',
    color: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUsedAt: new Date(),
  },
];

describe('unified manual question form', () => {
  let root: Root;
  let host: HTMLDivElement;
  let item: LearningItem;
  let save: ReturnType<typeof vi.fn<NonNullable<ManualQuestionFormProps['save']>>>;
  const prepared = { blob: new Blob(['image'], { type: 'image/png' }), width: 200, height: 100 };
  beforeEach(async () => {
    installDraftMemoryPort();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const repository = new ValRecallRepository({
      databaseName: `authoring-${crypto.randomUUID()}`,
    });
    item = await repository.createTextItem({
      title: 'Draft',
      itemType: 'Understand',
      recallPrompt: 'Question?',
      coreLesson: 'Answer evidence',
      referenceAnswer: 'Answer evidence',
      fsrsCard: createEmptyCard(new Date()),
    });
    repository.close();
    save = vi
      .fn<NonNullable<ManualQuestionFormProps['save']>>()
      .mockResolvedValue({ item, allowance: null, manualReward: 3, warning: null });
    mocks.prepare.mockReset().mockResolvedValue(prepared);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = vi.fn(() => 'blob:manual-preview');
        static revokeObjectURL = vi.fn();
      },
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = async (props: ManualQuestionFormProps = {}) => {
    await act(async () =>
      root.render(<ManualQuestionForm loadCategories={loadCategories} save={save} {...props} />),
    );
  };
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent === text)!;
  const field = (text: string) =>
    [...host.querySelectorAll('label')]
      .find((entry) => entry.querySelector('span')?.textContent === text)
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input,textarea,select',
      );
  const type = (label: string, value: string) => {
    const element = field(label)!;
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
      );
    });
  };
  const fill = () => {
    type('标题', 'Retained title');
    type('回忆问题', '  Question?  ');
    type('答案要点', 'Answer evidence');
  };
  const selectImage = () => {
    const input = field('主图')!;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'cue.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('shares the required Q/A fields and previews without saving or revealing the answer', async () => {
    await render({ embedded: true });
    // Hidden from view because the mode switch names it, but still the form's focus target.
    const formHeading = host.querySelector<HTMLElement>('h3')!;
    expect(formHeading.textContent).toBe('手动创建');
    expect(formHeading.className).toBe('sr-only');
    expect(document.activeElement).toBe(formHeading);
    expect(host.querySelector('section')?.getAttribute('aria-labelledby')).toBe(formHeading.id);
    await act(async () => button('保存回忆题').click());
    expect(save).not.toHaveBeenCalled();
    fill();
    expect(field('Reference answer')).toBeUndefined();
    await act(async () => button('预览回忆题').click());
    expect(host.textContent).toContain('Question?');
    expect(host.textContent).not.toContain('Answer evidence');
    await act(async () => button('揭晓答案').click());
    expect(host.textContent).toContain('Answer evidence');
    await act(async () => button('返回编辑').click());
    expect(field('回忆问题')?.value).toBe('  Question?  ');
    expect(save).not.toHaveBeenCalled();
  });
  it('locks pending saves and retains input and stable UUID after failure', async () => {
    let reject: (error: Error) => void = () => undefined;
    save.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const changed = vi.fn();
    await render({ onSaved: changed });
    fill();
    await act(async () => {
      button('保存回忆题').click();
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(button('放弃本条').disabled).toBe(true);
    await act(async () => reject(new Error('Write failed')));
    expect(field('标题')?.value).toBe('Retained title');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Write failed');
    await act(async () => button('保存回忆题').click());
    expect(save.mock.calls[0]![0].id).toBe(save.mock.calls[1]![0].id);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('+3 零花钱');
  });
  it('consumes source requests once while preserving shared fields and dirty category choices', async () => {
    await render({ sourceRequest: { key: 1, categoryId: 'first' } });
    fill();
    await render({ sourceRequest: { key: 2, source: 'reading', categoryId: 'second' } });
    expect(field('分类')?.value).toBe('first');
    expect(field('回忆问题')?.value).toBe('  Question?  ');
    type('原文', 'Book excerpt');
    type('书名', 'Book');
    await act(async () => button('直接出题').click());
    await render({
      sourceRequest: { key: 2, source: 'reading', categoryId: 'second' },
      active: false,
    });
    await render({ sourceRequest: { key: 2, source: 'reading', categoryId: 'second' } });
    expect(field('标题')?.value).toBe('Retained title');
    expect(button('直接出题').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('阅读摘录').click());
    expect(field('原文')?.value).toBe('Book excerpt');
    expect(field('书名')?.value).toBe('Book');
  });
  it('retains source-specific values across switches and clears irrelevant errors', async () => {
    await render();
    fill();
    await act(async () => button('视频链接').click());
    type('视频链接', 'https://example.com/video');
    await act(async () => button('保存回忆题').click());
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => button('图片').click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => selectImage());
    expect(host.querySelector('.manual-image-preview')).not.toBeNull();
    await act(async () => button('直接出题').click());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:manual-preview');
    await act(async () => button('视频链接').click());
    expect(field('视频链接')?.value).toBe('https://example.com/video');
    await act(async () => button('图片').click());
    expect(host.querySelector('.manual-image-preview')).not.toBeNull();
    expect((field('主图') as HTMLInputElement).required).toBe(false);
    await act(async () => button('保存回忆题').click());
    expect(save.mock.calls[0]![0]).toMatchObject({
      source: 'image',
      title: 'Retained title',
      image: prepared,
    });
  });
  it('locks source changes and discard during image preparation', async () => {
    let resolve: (value: typeof prepared) => void = () => undefined;
    mocks.prepare.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await act(async () => button('图片').click());
    await act(async () => selectImage());
    expect(button('放弃本条').disabled).toBe(true);
    await act(async () => button('直接出题').click());
    expect(field('主图')).toBeDefined();
    await act(async () => resolve(prepared));
    expect(button('放弃本条').disabled).toBe(false);
    expect(host.querySelector('.manual-image-preview')).not.toBeNull();
  });
  it('keeps image clues visible before reveal, retains failed image saves and discards explicitly', async () => {
    await render();
    fill();
    await act(async () => button('图片').click());
    await act(async () => selectImage());
    await act(async () => button('预览回忆题').click());
    expect(host.querySelector('img')).not.toBeNull();
    expect(host.textContent).not.toContain('Answer evidence');
    await act(async () => button('返回编辑').click());
    save.mockRejectedValueOnce(new Error('Image write failed'));
    await act(async () => button('保存回忆题').click());
    expect(host.querySelector('img')).not.toBeNull();
    expect(field('答案要点')?.value).toBe('Answer evidence');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button('放弃本条').click());
    expect(window.confirm).toHaveBeenLastCalledWith('放弃这道回忆题？');
    expect(field('答案要点')?.value).toBe('Answer evidence');
    await act(async () => button('放弃本条').click());
    expect(field('答案要点')?.value).toBe('');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('resets an untouched form without asking', async () => {
    await render();
    await act(async () => button('放弃本条').click());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(field('标题')?.value).toBe('');
  });
  it('removes the slogans and format notes but keeps every field reachable', async () => {
    await render({ sourceRequest: { key: 1, source: 'reading' } });
    for (const removed of [
      '把读到的',
      '围绕一个知识点',
      '从一个知识点开始',
      '先问一个值得记住的问题',
      '选中重点',
      '需要提问思路',
      '（可选',
      '先写问题',
      '+2 零花钱',
      '+3 零花钱',
    ])
      expect(host.textContent).not.toContain(removed);
    expect(host.querySelector('.manual-source-picker legend')?.className).toBe('sr-only');
    await act(async () => button('图片').click());
    expect(host.textContent).not.toContain('JPEG');
    expect(host.textContent).not.toContain('12 MB');
    await act(async () => button('视频链接').click());
    expect(field('时间戳')).toBeDefined();
    await act(async () => button('直接出题').click());
    expect(host.querySelector('.manual-direct-hint')).toBeNull();
    expect(field('标签（用逗号分隔）')).toBeDefined();
  });
  it('tucks the question guides into a closed disclosure that never fills the question in', async () => {
    await render({ sourceRequest: { key: 1, source: 'reading' } });
    const guides = [...host.querySelectorAll('details')].find(
      (entry) => entry.querySelector('summary')?.textContent === '提问思路',
    )!;
    expect(guides.open).toBe(false);
    expect(guides.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('提问方向');
    expect(guides.textContent).toContain('解释含义');
    expect(field('回忆问题')?.hasAttribute('aria-describedby')).toBe(false);
    await act(async () => button('比较区别').click());
    expect(button('比较区别').getAttribute('aria-pressed')).toBe('true');
    expect(guides.querySelector('p')?.textContent).toBe(
      '这两种观点的区别是什么？各自适用于什么情况？',
    );
    expect(field('回忆问题')?.value).toBe('');
  });
  it.each([
    ['标题', () => undefined, '标题'],
    ['回忆问题', () => type('标题', 'Title'), '回忆问题'],
    [
      '答案要点',
      () => {
        type('标题', 'Title');
        type('回忆问题', 'Question?');
      },
      '答案要点',
    ],
  ])('focuses the empty field %s when saving is refused', async (_name, prepare, expected) => {
    await render();
    prepare();
    await act(async () => button('保存回忆题').click());
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field(expected));
    expect(host.querySelector('.manual-question-panel [role="alert"]')?.textContent).toBe(
      '标题、回忆问题和答案要点都是必填的。',
    );
  });
  it('takes a rejected save back to the source field and shows the error beside it', async () => {
    await render({ sourceRequest: { key: 1, source: 'reading' } });
    type('回忆问题', 'Question?');
    await act(async () => button('预览回忆题').click());
    expect(document.activeElement).toBe(field('原文'));
    expect(host.querySelector('.manual-preview')).toBeNull();
    const grid = () => host.querySelector('.manual-editor-grid')!;
    expect(grid().getAttribute('data-pane')).toBe('source');
    expect(host.querySelector('.manual-materials [role="alert"]')?.textContent).toBe(
      '请先粘贴要记录的原文。',
    );
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    type('原文', 'Excerpt');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button('保存阅读摘录').click());
    expect(document.activeElement).toBe(field('答案要点'));
    expect(grid().getAttribute('data-pane')).toBe('question');
    expect(host.querySelector('.manual-save-area [role="alert"]')).not.toBeNull();
  });
  it('takes focus to the rejected field on every refusal, and never later', async () => {
    await render();
    await act(async () => button('保存回忆题').click());
    expect(document.activeElement).toBe(field('标题'));
    // Nothing else changes on the second refusal, and focus must still go there, now.
    await act(async () => button('保存回忆题').focus());
    await act(async () => button('保存回忆题').click());
    expect(document.activeElement).toBe(field('标题'));
    await act(async () => button('预览回忆题').focus());
    await act(async () => button('预览回忆题').click());
    expect(document.activeElement).toBe(field('标题'));
    // Which leaves nothing armed: typing elsewhere stays where it is, with no jump.
    const answer = field('答案要点')!;
    await act(async () => answer.focus());
    type('答案要点', '第');
    expect(document.activeElement).toBe(answer);
    type('答案要点', '第三');
    expect(document.activeElement).toBe(answer);
    expect(answer.value).toBe('第三');
  });
  it('leaves nothing armed in the reading form either', async () => {
    await render({ readingOnly: true });
    await act(async () => button('保存阅读摘录').click());
    expect(document.activeElement).toBe(field('原文'));
    await act(async () => button('保存阅读摘录').click());
    const book = field('书名')!;
    await act(async () => book.focus());
    type('书名', '书');
    expect(document.activeElement).toBe(book);
  });
  it('forgets the selection when an older reading draft is restored', async () => {
    const rows = installDraftMemoryPort();
    const older = {
      ...newManualDraft({ source: 'reading', categoryId: null, bookTitle: '' }),
      excerpt: '以前保存的原文，它和现在的不一样',
      recallPrompt: '以前的问题',
      coreLesson: '我手写的答案，很长很长',
    };
    rows.set(older.id, {
      schemaVersion: 1,
      id: older.id,
      scope: 'reading',
      summary: '以前的问题',
      revision: 1,
      updatedAt: new Date().toISOString(),
      payload: manualDraftValue(older),
    });
    await render({ readingOnly: true });
    type('原文', '现在粘贴的一段原文');
    const excerpt = field('原文') as HTMLTextAreaElement;
    await act(async () => {
      excerpt.focus();
      excerpt.setSelectionRange(0, 3);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      excerpt.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    expect(button('用作答案要点').disabled).toBe(false);
    await act(async () => button('继续').click());
    expect(field('原文')?.value).toBe(older.excerpt);
    expect(button('用作答案要点').disabled).toBe(true);
    expect(button('选中挖空').disabled).toBe(true);
    await act(async () => button('用作答案要点').click());
    expect(field('答案要点')?.value).toBe('我手写的答案，很长很长');
  });
  it('focuses the missing image and the bad video link or time when saving is refused', async () => {
    await render();
    fill();
    await act(async () => button('图片').click());
    await act(async () => button('保存回忆题').click());
    expect(document.activeElement).toBe(field('主图'));
    expect(host.querySelector('.manual-materials [role="alert"]')?.textContent).toContain(
      '请选择一张有效图片',
    );
    await act(async () => button('视频链接').click());
    await act(async () => button('保存回忆题').click());
    expect(document.activeElement).toBe(field('视频链接'));
    type('视频链接', 'https://www.bilibili.com/video/BV1Ef411g7Hj');
    type('时间戳', 'not a time');
    await act(async () => button('保存回忆题').click());
    expect(document.activeElement).toBe(field('时间戳'));
    expect(save).not.toHaveBeenCalled();
  });
  it('states the image size limit only as an error beside the file picker', async () => {
    await render();
    await act(async () => button('图片').click());
    const huge = new File(['image'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 13 * 1024 * 1024 });
    const input = field('主图')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [huge] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(host.querySelector('.manual-materials [role="alert"]')?.textContent).toBe(
      '所选图片超过 12 MB 输入上限。',
    );
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
  it('shows a save failure beside Save even after a source error moved the pane', async () => {
    await render();
    fill();
    await act(async () => button('图片').click());
    await act(async () => button('保存回忆题').click());
    expect(host.querySelector('.manual-materials [role="alert"]')).not.toBeNull();
    await act(async () => selectImage());
    save.mockRejectedValueOnce(new Error('Write failed'));
    await act(async () => button('保存回忆题').click());
    expect(host.querySelector('.manual-save-area [role="alert"]')?.textContent).toContain(
      'Write failed',
    );
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });
  it('keeps one saved line, the title, one reward and two buttons after saving', async () => {
    await render({ embedded: true, onViewItem: vi.fn() });
    fill();
    await act(async () => button('保存回忆题').click());
    const form = host.querySelector('.manual-question-form')!;
    const heading = form.querySelector<HTMLElement>('h3')!;
    expect(heading.textContent).toBe('回忆题已保存');
    expect(document.activeElement).toBe(heading);
    expect(form.querySelector('.reading-question')?.textContent).toBe('Draft');
    expect(form.querySelectorAll('.reading-reward')).toHaveLength(1);
    expect(form.querySelector('.reading-reward')?.textContent).toBe('手动出题 +3 零花钱');
    expect(form.querySelectorAll('button')).toHaveLength(2);
    for (const removed of ['已加入复习', '查看已保存的题目', 'Answer evidence'])
      expect(form.textContent).not.toContain(removed);
    expect(form.querySelector('.notice')).toBeNull();
  });
  it('lets the praise stand for the saved line when the reading reward has one', async () => {
    save.mockResolvedValueOnce({
      item,
      allowance: {
        captureReward: 2,
        checkIn: true,
        checkInReward: 5,
        praise: '你又抓住一个 Moment 了，真厉害～',
        checkInPraise: null,
      },
      manualReward: null,
      warning: null,
    });
    await render({ sourceRequest: { key: 1, source: 'reading' } });
    type('原文', 'Excerpt');
    type('回忆问题', 'Question?');
    type('答案要点', 'Answer');
    await act(async () => button('保存阅读摘录').click());
    const heading = host.querySelector<HTMLElement>('.manual-question-form h2')!;
    expect(heading.querySelector('.sr-only')?.textContent).toBe('阅读摘录已保存');
    expect(heading.textContent).toContain('你又抓住一个 Moment 了，真厉害～');
    expect(document.activeElement).toBe(heading);
    expect(host.querySelectorAll('.reading-reward')).toHaveLength(1);
    expect(host.querySelector('.reading-reward')?.textContent).toBe(
      '阅读摘录 +2 零花钱 · 每日打卡 +5',
    );
  });
  it('reports draft/busy state, shows saved warnings, and opens the saved item explicitly', async () => {
    const state = vi.fn();
    const view = vi.fn();
    const receipt: ManualQuestionReceipt = {
      item,
      allowance: null,
      manualReward: null,
      warning: '奖励未能确认',
    };
    save.mockResolvedValue(receipt);
    await render({ onDraftStateChange: state, onViewItem: view });
    fill();
    expect(state).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    await act(async () => button('保存回忆题').click());
    expect(state).toHaveBeenLastCalledWith({ dirty: false, busy: false });
    expect(host.textContent).toContain('奖励未能确认');
    await act(async () => button('在资料库查看').click());
    expect(view).toHaveBeenCalledWith(item.id);
    const firstId = save.mock.calls[0]![0].id;
    await act(async () => button('继续记录').click());
    fill();
    await act(async () => button('保存回忆题').click());
    expect(save.mock.calls[1]![0].id).not.toBe(firstId);
  });
  it.each(['invalid', 'decode'] as const)(
    'clears the previous image when a replacement fails at %s',
    async (failure) => {
      await render();
      fill();
      await act(async () => button('图片').click());
      await act(async () => selectImage());
      expect(host.querySelector('img')).not.toBeNull();
      if (failure === 'decode') mocks.prepare.mockRejectedValueOnce(new Error('Decode failed'));
      await act(async () => {
        const input = field('主图')!;
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: [
            new File(['replacement'], 'replacement.bin', {
              type: failure === 'invalid' ? 'application/octet-stream' : 'image/png',
            }),
          ],
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(host.querySelector('img')).toBeNull();
      await act(async () => button('保存回忆题').click());
      expect(save).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('请选择一张有效图片');
    },
  );
  it('protects metadata-only edits without treating inherited book/category defaults as dirty', async () => {
    const state = vi.fn();
    await render({
      sourceRequest: { key: 1, source: 'reading', categoryId: 'first' },
      onDraftStateChange: state,
    });
    expect(state).toHaveBeenLastCalledWith({ dirty: false, busy: false });
    type('书名', 'A book');
    expect(state).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    await render({ sourceRequest: { key: 2, categoryId: 'second' }, onDraftStateChange: state });
    expect(field('分类')?.value).toBe('first');
    type('原文', 'Excerpt');
    type('回忆问题', 'Question?');
    type('答案要点', 'Answer');
    await act(async () => button('保存阅读摘录').click());
    await act(async () => button('继续记录').click());
    expect(field('书名')?.value).toBe('A book');
    expect(field('分类')?.value).toBe('first');
    expect(state).toHaveBeenLastCalledWith({ dirty: false, busy: false });
    type('学习目标', 'Do');
    expect(state).toHaveBeenLastCalledWith({ dirty: true, busy: false });
  });
  it('starts a new requested source after a completed receipt without mislabeling the saved item', async () => {
    await render();
    fill();
    await act(async () => button('保存回忆题').click());
    expect(host.textContent).toContain('回忆题已保存');
    const previousId = save.mock.calls[0]![0].id;
    await render({ sourceRequest: { key: 1, source: 'reading', categoryId: null } });
    expect(host.textContent).not.toContain('已保存');
    expect(field('原文')?.value).toBe('');
    type('原文', 'Excerpt');
    type('回忆问题', 'Question?');
    type('答案要点', 'Answer');
    await act(async () => button('保存阅读摘录').click());
    expect(save.mock.calls[1]![0].id).not.toBe(previousId);
  });
  it('saves directly from preview, preserves it after failure and only celebrates committed content', async () => {
    save.mockRejectedValueOnce(new Error('preview write failed'));
    await render();
    fill();
    await act(async () => button('预览回忆题').click());
    await act(async () => button('保存回忆题').click());
    expect(host.textContent).toContain('preview write failed');
    expect(button('返回编辑')).toBeDefined();
    expect(host.textContent).not.toContain('Answer evidence');
    await act(async () => button('保存回忆题').click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].id).toBe(save.mock.calls[0]![0].id);
    expect(host.textContent).toContain('回忆题已保存');
  });
  it('keeps source and question input while switching narrow panes and focuses the new pane', async () => {
    await render();
    fill();
    await act(async () => button('来源材料').click());
    expect(host.querySelector('.manual-editor-grid')?.getAttribute('data-pane')).toBe('source');
    expect(document.activeElement?.textContent).toBe('来源材料');
    await act(async () => button('阅读摘录').click());
    type('原文', '会泄露答案的原文');
    type('书名', '也会泄露答案的书名');
    await act(async () => button('继续写题').click());
    expect(field('回忆问题')?.value).toBe('  Question?  ');
    expect(document.activeElement?.textContent).toBe('当前回忆题');
    await act(async () => button('预览回忆题').click());
    expect(host.textContent).not.toContain('会泄露答案');
    expect(host.querySelector('textarea')).toBeNull();
    await act(async () => button('返回编辑').click());
    expect(field('原文')?.value).toBe('会泄露答案的原文');
    expect(field('书名')?.value).toBe('也会泄露答案的书名');
  });
});
