import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyCard } from 'ts-fsrs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository, type LearningItem } from '../database';
import { ReadingCapture, type ReadingCaptureProps } from './ReadingCapture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const categories = async () => [];

describe('shared reading authoring', () => {
  let host: HTMLDivElement;
  let root: Root;
  let item: LearningItem;
  beforeEach(async () => {
    installDraftMemoryPort();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const repo = new ValRecallRepository({ databaseName: `reading-ui-${crypto.randomUUID()}` });
    item = await repo.createTextItem({
      title: 'Test',
      itemType: 'Understand',
      recallPrompt: '为什么需要证据？',
      coreLesson: '答案不会提前显示',
      referenceAnswer: '',
      readingSource: {
        schemaVersion: 1,
        excerpt: '原文不可提前看到',
        bookTitle: '测试书',
        location: '42',
      },
      fsrsCard: createEmptyCard(new Date()),
    });
    repo.close();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const render = async (props: ReadingCaptureProps = {}) => {
    await act(async () => root.render(<ReadingCapture loadCategories={categories} {...props} />));
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((el) => el.textContent === label)!;
  const type = (element: HTMLTextAreaElement | HTMLInputElement, value: string) => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const fill = () => {
    const fields = host.querySelectorAll('textarea');
    type(fields[0]!, '原文不可提前看到');
    type(fields[1]!, '为什么需要证据？');
    type(fields[2]!, '答案不会提前显示');
  };

  it('previews only the question, reveals evidence explicitly and never saves during preview', async () => {
    const save = vi.fn();
    await render({ save });
    fill();
    await act(async () => button('预览回忆题').click());
    expect(host.textContent).toContain('为什么需要证据？');
    expect(host.textContent).not.toContain('答案不会提前显示');
    expect(host.textContent).not.toContain('原文不可提前看到');
    await act(async () => button('揭晓答案').click());
    expect(host.textContent).toContain('答案不会提前显示');
    expect(host.querySelector('.reading-source-details')?.hasAttribute('open')).toBe(false);
    await act(async () => button('返回编辑').click());
    expect(host.querySelectorAll('textarea')[0]!.value).toBe('原文不可提前看到');
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps input and stable identity after failure, and disables duplicate submission', async () => {
    let reject: (error: Error) => void = () => undefined;
    const save = vi
      .fn<NonNullable<ReadingCaptureProps['save']>>()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue({ item, allowance: null, warning: '奖励未能确认' });
    await render({ save });
    fill();
    await act(async () => {
      button('保存阅读摘录').click();
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(button('保存中…').disabled).toBe(true);
    await act(async () => reject(new Error('写入失败，请重试')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('写入失败');
    expect(host.querySelectorAll('textarea')[2]!.value).toBe('答案不会提前显示');
    await act(async () => button('保存阅读摘录').click());
    expect(save.mock.calls[0]![0].id).toBe(save.mock.calls[1]![0].id);
    expect(host.textContent).toContain('阅读摘录已保存');
    expect(host.textContent).toContain('奖励未能确认');
  });

  it('preserves hidden-mode input and carries only book/category into the next capture', async () => {
    const save = vi
      .fn<NonNullable<ReadingCaptureProps['save']>>()
      .mockResolvedValue({ item, allowance: null, warning: null });
    await render({ save });
    fill();
    type(host.querySelectorAll('input')[0]!, '测试书');
    await render({ save, active: false });
    await render({ save, active: true });
    expect(host.querySelectorAll('textarea')[0]!.value).toBe('原文不可提前看到');
    await act(async () => button('保存阅读摘录').click());
    await act(async () => button('继续记录').click());
    expect(host.querySelectorAll('input')[0]!.value).toBe('测试书');
    expect([...host.querySelectorAll('textarea')].every((entry) => entry.value === '')).toBe(true);
  });

  it('requires explicit discard and does not overwrite the question when a guide changes', async () => {
    await render();
    fill();
    await act(async () => button('比较区别').click());
    expect(host.querySelectorAll('textarea')[1]!.value).toBe('为什么需要证据？');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button('放弃本条').click());
    expect(window.confirm).toHaveBeenLastCalledWith('放弃这条阅读摘录？');
    expect(host.querySelectorAll('textarea')[0]!.value).toBe('原文不可提前看到');
    await act(async () => button('放弃本条').click());
    expect(host.querySelectorAll('textarea')[0]!.value).toBe('');
  });

  it('replaces from a selection without asking and keeps authored fields when the excerpt changes', async () => {
    await render();
    fill();
    const excerpt = host.querySelector('textarea')!;
    type(excerpt, '证据支持推理。证据可以检验。');
    await act(async () => {
      excerpt.focus();
      excerpt.setSelectionRange(0, 2);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      excerpt.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    expect(button('选中挖空').disabled).toBe(false);
    await act(async () => button('选中挖空').click());
    const question = host.querySelectorAll('textarea')[1]!.value;
    expect(question).toContain('［……］支持推理。［……］可以检验。');
    expect(host.querySelectorAll('textarea')[2]!.value).toBe('证据');
    expect(window.confirm).not.toHaveBeenCalled();
    type(excerpt, '另一段原文');
    expect(host.querySelectorAll('textarea')[1]!.value).toBe(question);
    expect(host.querySelectorAll('textarea')[2]!.value).toBe('证据');
  });

  it('uses the selection as the answer at once, over a hand-written one', async () => {
    await render();
    fill();
    const excerpt = host.querySelector('textarea')!;
    await act(async () => {
      excerpt.focus();
      excerpt.setSelectionRange(0, 2);
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
      excerpt.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    });
    await act(async () => button('用作答案要点').click());
    expect(host.querySelectorAll('textarea')[2]!.value).toBe('原文');
    expect(host.querySelectorAll('textarea')[1]!.value).toBe('为什么需要证据？');
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
