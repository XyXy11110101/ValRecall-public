import { installDraftMemoryPort } from '../testing/draft-port';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { IntakeView, type IntakeViewProps } from './IntakeView';
import type { IntakePackageV1, IntakeSelection } from './package';
import type { IntakeEntryResult, IntakeResult } from '../database/intake-types';
import type { MomentCategory } from '../database';
import { INTAKE_CONFLICT_DETAIL } from './intake-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const packet: IntakePackageV1 = {
  format: 'valrecall-intake',
  version: 1,
  packageId: 'ui-package',
  records: [
    {
      id: 'r1',
      title: '手机里的想法',
      excerpt: '<script>not executable</script>',
      thought: '我的感想',
      summary: 'AI 整理',
      aiAdditions: '待核实',
      bookTitle: '',
      location: '',
      questions: [
        { id: 'q1', prompt: '如何应用？', answer: '用户提供的答案', needsConfirmation: false },
        { id: 'q2', prompt: '需要核实的问题？', answer: '需要核实的答案', needsConfirmation: true },
      ],
    },
  ],
};
const report: IntakeResult = {
  notes: 0,
  questions: 1,
  rewardReceiptIds: ['q'],
  entries: [
    {
      kind: 'question',
      recordId: 'r1',
      questionId: 'q1',
      status: 'new',
      targetId: 'q',
      deleted: false,
    },
  ],
};
const categoriesLoader = async () => [];
/** Two materials, four questions; the last one needs confirmation and starts unselected. */
const wide: IntakePackageV1 = {
  ...packet,
  packageId: 'wide-package',
  records: [
    {
      ...packet.records[0]!,
      id: 'r1',
      title: '第一份材料',
      questions: [
        { id: 'a', prompt: '问题甲？', answer: '答案甲', needsConfirmation: false },
        { id: 'b', prompt: '问题乙？', answer: '答案乙', needsConfirmation: false },
      ],
    },
    {
      ...packet.records[0]!,
      id: 'r2',
      title: '第二份材料',
      questions: [
        { id: 'c', prompt: '问题丙？', answer: '答案丙', needsConfirmation: false },
        { id: 'd', prompt: '问题丁？', answer: '答案丁', needsConfirmation: true },
      ],
    },
  ],
};
/** A deterministic local check: every selected question is new unless listed. */
function checker(statuses: Record<string, IntakeEntryResult['status']> = {}) {
  return vi.fn(async (selection: IntakeSelection): Promise<IntakeResult> => {
    const entries = selection.package.records.flatMap((record) =>
      record.questions.map((question): IntakeEntryResult => ({
        kind: 'question',
        recordId: record.id,
        questionId: question.id,
        status: statuses[question.id] ?? 'new',
        targetId: `t-${question.id}`,
        deleted: false,
      })),
    );
    return {
      notes: 0,
      questions: entries.filter((entry) => entry.status === 'new').length,
      rewardReceiptIds: [],
      entries,
    };
  });
}
const category = (id: string, name: string): MomentCategory => ({
  id,
  schemaVersion: 1,
  name,
  createdAt: new Date('2026-10-11T12:00:00Z'),
  updatedAt: new Date('2026-10-11T12:00:00Z'),
  lastUsedAt: new Date('2026-10-11T12:00:00Z'),
});
const twoCategories = async () => [category('c1', '阅读'), category('c2', '工作')];
const threeCategories = async () => [
  category('c1', '阅读'),
  category('c2', '工作'),
  category('c3', '生活'),
];
const box = (top: number, height = 30) =>
  ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 300,
    bottom: top + height,
    width: 300,
    height,
    toJSON: () => ({}),
  }) as DOMRect;
const questionIds = (selection: IntakeSelection) =>
  selection.package.records.flatMap((record) => record.questions.map((question) => question.id));

describe('question-centered intake workspace', () => {
  let host: HTMLDivElement;
  let root: Root;
  let drafts: ReturnType<typeof installDraftMemoryPort>;
  beforeEach(() => {
    vi.useFakeTimers();
    drafts = installDraftMemoryPort();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const button = (text: string) =>
    [...host.querySelectorAll('button')].find((element) => element.textContent === text)!;
  const saveButton = () =>
    host.querySelector<HTMLButtonElement>('.intake-selection-bar .primary-action')!;
  const settleCheck = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
  };
  const type = (element: HTMLTextAreaElement, value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const directoryCheckboxes = () => [
    ...host.querySelectorAll<HTMLInputElement>('.intake-directory input'),
  ];
  const directoryButtons = () => [
    ...host.querySelectorAll<HTMLButtonElement>('.intake-directory button'),
  ];
  async function render(props: Partial<IntakeViewProps> = {}) {
    await act(async () =>
      root.render(
        <IntakeView
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          onViewItem={vi.fn()}
          categoriesLoader={categoriesLoader}
          {...props}
        />,
      ),
    );
  }
  function parse(value = packet) {
    type(host.querySelector('textarea')!, JSON.stringify(value));
    act(() => button('读取并预览').click());
  }
  function edit(index = 0) {
    act(() => directoryButtons()[index]!.click());
    act(() => button('编辑问题与答案').click());
  }
  const rowStatuses = () =>
    [...host.querySelectorAll('.intake-directory-status')].map((node) => node.textContent);
  const summary = () => host.querySelector<HTMLElement>('.intake-check-summary')!;
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('.intake-directory li')];
  const defaultCategory = () =>
    host.querySelector<HTMLSelectElement>('.intake-default-category select')!;
  const rowCategory = (number: number) =>
    host.querySelector<HTMLSelectElement>(`[aria-label="第 ${number} 题分类"]`)!;
  const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const hint = () => host.querySelector('.intake-selection-hint')?.textContent;
  const saveSlot = () => host.querySelector<HTMLElement>('.intake-save-slot')!;

  it('reads one question at a time and keeps uncertain questions unchecked with distinct source provenance', async () => {
    await render();
    parse();
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelectorAll('textarea')).toHaveLength(0);
    expect(directoryCheckboxes().map((element) => element.checked)).toEqual([true, false]);
    expect(host.querySelectorAll('.intake-question-reading')).toHaveLength(1);
    expect(host.querySelector('.intake-read-prompt')?.textContent).toBe('如何应用？');
    expect(host.querySelectorAll('.note-content h4')).toHaveLength(4);
    expect(host.textContent).toContain('自己的感想');
    expect(host.textContent).toContain('整理摘要 · AI');
    expect(host.textContent).not.toContain('保存笔记');
    await act(async () => directoryButtons()[1]!.click());
    expect(host.querySelector('.intake-read-prompt')?.textContent).toBe('需要核实的问题？');
    expect(host.textContent).toContain('这题需要核实依据，确认后再勾选');
  });

  it('edits on demand, cancels to original content and returns focus to the edit control', async () => {
    await render();
    parse();
    edit();
    expect(document.activeElement).toBe(host.querySelector('textarea'));
    type(host.querySelector('textarea')!, '尚未完成的修改');
    await act(async () => button('放弃修改').click());
    expect(host.querySelectorAll('textarea')).toHaveLength(0);
    expect(host.querySelector('.intake-read-prompt')?.textContent).toBe('如何应用？');
    expect(document.activeElement).toBe(button('编辑问题与答案'));
  });

  it('asks before dropping an edit only when the question or answer really changed', async () => {
    await render();
    parse();
    edit();
    await act(async () => button('放弃修改').click());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(host.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.activeElement).toBe(button('编辑问题与答案'));

    act(() => button('编辑问题与答案').click());
    type(host.querySelector('textarea')!, '尚未完成的修改');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button('放弃修改').click());
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('放弃这次修改？');
    expect(host.querySelector('textarea')?.value).toBe('尚未完成的修改');

    // Typing the original text back is no change either.
    type(host.querySelector('textarea')!, '如何应用？');
    vi.mocked(window.confirm).mockClear();
    await act(async () => button('放弃修改').click());
    expect(window.confirm).not.toHaveBeenCalled();
    expect(host.querySelector('.intake-read-prompt')?.textContent).toBe('如何应用？');
  });

  it('uses edited selected questions and per-source categories for preview and invalidates an old check', async () => {
    const preview = vi.fn().mockResolvedValue(report);
    await render({
      preview,
      categoriesLoader: async () => [
        {
          id: 'c',
          schemaVersion: 1,
          name: '阅读',
          createdAt: new Date('2026-10-11T12:00:00Z'),
          updatedAt: new Date('2026-10-11T12:00:00Z'),
          lastUsedAt: new Date('2026-10-11T12:00:00Z'),
        },
      ],
    });
    parse();
    edit();
    type(host.querySelector('textarea')!, '我编辑的问题');
    await act(async () => button('完成编辑').click());
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'c';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settleCheck();
    expect(preview.mock.calls[0]![0].package.records[0].questions).toEqual([
      { ...packet.records[0]!.questions[0], prompt: '我编辑的问题' },
    ]);
    // The package-wide choice reaches every selected question; the legacy record map stays empty.
    expect(preview.mock.calls[0]![0].categories).toEqual({});
    expect(preview.mock.calls[0]![0].questionCategories).toEqual({ '["r1","q1"]': 'c' });
    expect(host.textContent).toContain('基础奖励 +2');
    await act(async () => directoryButtons()[1]!.click());
    expect(host.querySelector('select')?.value).toBe('c');
    expect(host.querySelector<HTMLSelectElement>('.intake-detail select')?.value).toBe('c');
    await act(async () => directoryCheckboxes()[1]!.click());
    expect(saveButton().disabled).toBe(true);
    await settleCheck();
    expect(preview.mock.calls[1]![0].package.records[0].questions[1].needsConfirmation).toBe(false);
  });

  it('restores focus to the same directory question after narrow detail navigation', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    await render();
    parse();
    await act(async () => directoryButtons()[1]!.click());
    expect(host.querySelector('.intake-workspace')?.getAttribute('data-pane')).toBe('detail');
    expect(document.activeElement).toBe(host.querySelector('.intake-detail h3'));
    // Focus never lets the browser jump the page.
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(focus.mock.contexts.at(-1)).toBe(host.querySelector('.intake-detail h3'));
    await act(async () => button('返回题目目录').click());
    expect(host.querySelector('.intake-workspace')?.getAttribute('data-pane')).toBe('directory');
    expect(document.activeElement).toBe(directoryButtons()[1]);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(focus.mock.calls.every(([options]) => options?.preventScroll === true)).toBe(true);
  });

  it('scrolls a newly focused question into view only when it is hidden', async () => {
    let headingTop = 300;
    // The browser honours the scroll margin: the heading lands just below the bar.
    const scroll = vi.fn(() => {
      headingTop = 46;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('.intake-detail h3')) return box(headingTop);
      return box(this.matches('.intake-selection-bar') ? 0 : 200);
    });
    try {
      await render();
      parse();
      await act(async () => directoryButtons()[1]!.click());
      expect(scroll).not.toHaveBeenCalled();
      headingTop = -400;
      await act(async () => directoryButtons()[0]!.click());
      expect(document.activeElement).toBe(host.querySelector('.intake-detail h3'));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollBy).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('reveals the back button and heading below a bar taller than the scroll margin', async () => {
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    });
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    // Narrow single pane: the back button is rendered above the question heading.
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return (this.matches('.intake-return') ? [box(176)] : []) as unknown as DOMRectList;
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      if (this.matches('.intake-selection-bar')) return box(0, 227);
      if (this.matches('.intake-return')) return box(176, 44);
      if (this.matches('.intake-detail h3')) return box(250);
      return box(500);
    });
    try {
      await render();
      parse(wide);
      await act(async () => directoryButtons()[2]!.click());
      expect(document.activeElement).toBe(host.querySelector('.intake-detail h3'));
      // The back button is the area to reveal; the CSS margin still left it under the bar.
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(host.querySelector('.intake-return'));
      expect(scrollBy).toHaveBeenCalledWith({ top: -(227 - 176 + 8) });
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('drives the sticky offsets from the measured height of the selection bar', async () => {
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    let height = 227;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return this.matches('.intake-selection-bar') ? box(0, height) : box(0, 0);
    });
    await render();
    parse(wide);
    const area = host.querySelector<HTMLElement>('.intake-packet')!;
    expect(area.style.getPropertyValue('--intake-cover')).toBe('227px');
    height = 150.2;
    act(() => resize!());
    expect(area.style.getPropertyValue('--intake-cover')).toBe('151px');
    await act(async () => button('返回 JSON').click());
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('preserves edits and location on failures, locks repeated saving and links only questions', async () => {
    const preview = vi
      .fn()
      .mockRejectedValueOnce(new Error('local unavailable'))
      .mockResolvedValue(report);
    const save = vi.fn().mockRejectedValueOnce(new Error('write unavailable'));
    const onViewItem = vi.fn();
    const onChanged = vi.fn();
    await render({ preview, save, onViewItem, onChanged });
    parse();
    edit();
    type(host.querySelector('textarea')!, '保留修改');
    await settleCheck();
    expect(host.textContent).toContain('local unavailable');
    expect(host.querySelector('textarea')?.value).toBe('保留修改');
    await act(async () => button('重试核对').click());
    await settleCheck();
    await act(async () => button('保存已选 1 道题').click());
    expect(host.textContent).toContain('write unavailable');
    expect(host.querySelector('textarea')?.value).toBe('保留修改');
    expect(host.querySelector('.intake-workspace')?.getAttribute('data-pane')).toBe('detail');
    expect(onChanged).not.toHaveBeenCalled();
    let resolve!: (value: unknown) => void;
    save.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await settleCheck();
    await act(async () => {
      saveButton().click();
      saveButton().click();
    });
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () =>
      resolve({ ...report, rewardAmount: null, warning: '奖励未确认，请查看账本' }),
    );
    expect(host.textContent).toContain('已新增 1 道回忆题');
    expect(host.textContent).toContain('奖励未确认');
    expect(host.textContent).not.toContain('查看笔记');
    expect(onChanged).toHaveBeenCalledTimes(1);
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((element) => element.textContent?.startsWith('查看回忆题'))!
        .click(),
    );
    expect(onViewItem).toHaveBeenCalledWith('q');
  });

  it('blocks selected invalid questions but ignores them when excluded', async () => {
    const preview = vi.fn().mockResolvedValue(report);
    await render({ preview });
    parse({
      ...packet,
      records: [
        {
          ...packet.records[0]!,
          questions: [
            ...packet.records[0]!.questions,
            { id: 'q3', prompt: '', answer: '', needsConfirmation: false },
          ],
        },
      ],
    });
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain('1 道需要补全');
    await act(async () => directoryCheckboxes()[2]!.click());
    await settleCheck();
    expect(saveButton().disabled).toBe(false);
    await settleCheck();
    expect(preview.mock.calls[0]![0].package.records[0].questions).toHaveLength(1);
  });

  it('locates conflicts per question and requires a fresh check after excluding them', async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce({
        ...report,
        questions: 1,
        entries: [
          { ...report.entries[0]!, status: 'conflict' },
          { ...report.entries[0]!, questionId: 'q2', targetId: 'q2' },
        ],
      })
      .mockResolvedValue(report);
    const save = vi.fn();
    await render({ preview, save });
    parse();
    await act(async () => directoryCheckboxes()[1]!.click());
    await settleCheck();
    expect(host.textContent).toContain('有冲突题，请在目录中排除');
    expect(saveButton().disabled).toBe(true);
    await act(async () => directoryCheckboxes()[0]!.click());
    await settleCheck();
    expect(
      preview.mock.calls[1]![0].package.records[0].questions.map(
        (question: { id: string }) => question.id,
      ),
    ).toEqual(['q2']);
    expect(save).not.toHaveBeenCalled();
  });

  it('makes note-only material explicitly unsaved and prevents empty or deselected batches', async () => {
    const preview = vi.fn();
    const save = vi.fn();
    await render({ preview, save });
    parse({ ...packet, records: [{ ...packet.records[0]!, questions: [] }] });
    expect(host.textContent).toContain('这份材料还没有回忆题');
    expect(host.textContent).toContain('1 条无题材料 · 未保存');
    expect(saveButton().disabled).toBe(true);
    await settleCheck();
    expect(preview).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await act(async () => button('放弃本次').click());
    parse();
    await act(async () => directoryCheckboxes()[0]!.click());
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain('已选 0 / 2');
  });

  it('omits no-question source records from a mixed selected package', async () => {
    const preview = vi.fn().mockResolvedValue(report);
    await render({ preview });
    parse({
      ...packet,
      records: [...packet.records, { ...packet.records[0]!, id: 'empty', questions: [] }],
    });
    await settleCheck();
    expect(preview.mock.calls[0]![0].package.records).toHaveLength(1);
    expect(host.textContent).toContain('1 条无题材料 · 未保存');
  });

  it('retains JSON and question drafts across inactive routes without saving', async () => {
    const save = vi.fn();
    await render({ save });
    type(host.querySelector('textarea')!, 'not json');
    await render({ active: false, save });
    await render({ active: true, save });
    expect(host.querySelector('textarea')?.value).toBe('not json');
    await act(async () => button('读取并预览').click());
    expect(host.querySelector('[role=alert]')?.textContent).toContain('JSON');
    parse();
    edit(1);
    type(host.querySelector('textarea')!, '跨页面保留');
    await render({ active: false, save });
    await render({ active: true, save });
    expect(host.querySelector('textarea')?.value).toBe('跨页面保留');
    expect(directoryCheckboxes()[1]?.checked).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('does not promise check-in or save an entirely duplicate package; deleted targets have no link', async () => {
    const save = vi.fn();
    await render({
      save,
      preview: vi.fn().mockResolvedValue({
        notes: 0,
        questions: 0,
        entries: report.entries.map((entry) => ({
          ...entry,
          status: 'duplicate',
          deleted: true,
        })),
        rewardReceiptIds: [],
      }),
    });
    parse();
    await settleCheck();
    expect(host.textContent).toContain('没有新题。');
    expect(host.textContent).not.toContain('另 +5');
    expect(host.textContent).not.toContain('查看回忆题');
    expect(button('没有新题需要保存').disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('handles JSON files and rejects oversized files without reading them', async () => {
    await render();
    const field = host.querySelector<HTMLInputElement>('input[type=file]')!;
    const read = vi.fn().mockResolvedValue(JSON.stringify(packet));
    Object.defineProperty(field, 'files', {
      configurable: true,
      value: [{ size: 2 * 1024 * 1024, text: read }],
    });
    await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })));
    expect(host.textContent).toContain('超过 1 MiB');
    expect(read).not.toHaveBeenCalled();
    Object.defineProperty(field, 'files', {
      configurable: true,
      value: [{ size: 2048, text: read }],
    });
    await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })));
    expect(host.textContent).toContain('手机里的想法');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('asks before a file replaces current content, but an oversized file replaces nothing', async () => {
    await render();
    const field = host.querySelector<HTMLInputElement>('input[type=file]')!;
    const read = vi.fn().mockResolvedValue(JSON.stringify(packet));
    const choose = (size: number) => {
      Object.defineProperty(field, 'files', { configurable: true, value: [{ size, text: read }] });
      return act(async () => field.dispatchEvent(new Event('change', { bubbles: true })));
    };
    type(host.querySelector('textarea')!, '粘贴到一半的内容');
    await choose(2 * 1024 * 1024);
    expect(window.confirm).not.toHaveBeenCalled();
    expect(host.textContent).toContain('超过 1 MiB');
    expect(host.querySelector('textarea')?.value).toBe('粘贴到一半的内容');

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await choose(2048);
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('用这个文件替换当前内容？');
    expect(read).not.toHaveBeenCalled();
    expect(host.querySelector('textarea')?.value).toBe('粘贴到一半的内容');

    await choose(2048);
    expect(read).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('手机里的想法');
  });

  it('asks before throwing away the current intake with a short question', async () => {
    await render();
    parse();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button('放弃本次').click());
    expect(window.confirm).toHaveBeenCalledExactlyOnceWith('放弃这次整理？');
    expect(host.textContent).toContain('手机里的想法');
    await act(async () => button('放弃本次').click());
    expect(host.textContent).not.toContain('手机里的想法');
  });

  it('keeps category failure recoverable without blocking uncategorized questions', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing categories'))
      .mockResolvedValue([]);
    const preview = vi.fn().mockResolvedValue(report);
    await render({ preview, categoriesLoader: loader });
    parse();
    expect(host.textContent).toContain('分类加载失败');
    const selects = [...host.querySelectorAll('select')];
    expect(selects.length).toBeGreaterThan(2);
    expect(selects.every((select) => select.disabled && select.value === '')).toBe(true);
    await settleCheck();
    expect(saveButton().disabled).toBe(false);
    expect(preview.mock.calls[0]![0].questionCategories).toEqual({ '["r1","q1"]': null });
    await act(async () => button('重试分类').click());
    expect(host.textContent).not.toContain('分类加载失败');
    expect([...host.querySelectorAll('select')].every((select) => !select.disabled)).toBe(true);
  });

  it('lets editing continue while checks are pending and ignores stale responses', async () => {
    const resolves: ((value: IntakeResult) => void)[] = [];
    const preview = vi
      .fn()
      .mockImplementation(() => new Promise<IntakeResult>((resolve) => resolves.push(resolve)));
    const onDraftStateChange = vi.fn();
    await render({ preview, onDraftStateChange });
    parse();
    await settleCheck();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(directoryCheckboxes().every((field) => !field.disabled)).toBe(true);
    expect(button('返回 JSON').disabled).toBe(false);
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, busy: false });
    edit();
    type(host.querySelector('textarea')!, '新的问题');
    await settleCheck();
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => resolves[0]!({ ...report, questions: 99 }));
    expect(host.textContent).not.toContain('99');
    expect(saveButton().disabled).toBe(true);
    await act(async () => resolves[1]!(report));
    expect(saveButton().textContent).toBe('保存已选 1 道题');
    expect(saveButton().disabled).toBe(false);
  });

  it('previews without leaking source or answer and saves directly after a fresh final check', async () => {
    const preview = vi.fn().mockResolvedValue(report);
    const save = vi.fn().mockResolvedValue({ ...report, rewardAmount: 2, warning: null });
    await render({ preview, save });
    parse();
    await settleCheck();
    await act(async () => button('模拟复习预览').click());
    expect(host.textContent).not.toContain('用户提供的答案');
    expect(host.textContent).not.toContain('手机里的想法');
    expect(host.textContent).not.toContain('我的感想');
    await act(async () => saveButton().click());
    expect(preview).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('已新增 1 道回忆题');
  });

  it('rechecks before saving and refuses a conflict introduced after automatic preflight', async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce(report)
      .mockResolvedValue({ ...report, entries: [{ ...report.entries[0]!, status: 'conflict' }] });
    const save = vi.fn();
    await render({ preview, save });
    parse();
    await settleCheck();
    await act(async () => saveButton().click());
    expect(preview).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).toContain('出现冲突题，请在目录中排除后重试');
    await settleCheck();
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain('有冲突题，请在目录中排除');
  });

  it('does not publish a late check after leaving the package', async () => {
    let resolve!: (value: IntakeResult) => void;
    const preview = vi.fn().mockImplementation(
      () =>
        new Promise<IntakeResult>((done) => {
          resolve = done;
        }),
    );
    await render({ preview });
    parse();
    await settleCheck();
    await act(async () => button('返回 JSON').click());
    await act(async () => resolve({ ...report, questions: 99 }));
    expect(host.textContent).not.toContain('99');
    expect(host.querySelector('.intake-selection-bar')).toBeNull();
    expect(host.querySelector('textarea')?.value).toContain('如何应用');
  });
  it('replays an uncertain commit even when the saved questions now look duplicate', async () => {
    const duplicate = {
      ...report,
      questions: 0,
      entries: report.entries.map((entry) => ({ ...entry, status: 'duplicate' as const })),
    };
    const preview = vi
      .fn()
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce(report)
      .mockResolvedValue(duplicate);
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue({ ...report, rewardAmount: 2, warning: null });
    await render({ preview, save });
    parse();
    await settleCheck();
    await act(async () => saveButton().click());
    await settleCheck();
    expect(saveButton().textContent).toBe('核对上次保存结果');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]![3]).toEqual(save.mock.calls[1]![3]);
    expect(host.textContent).toContain('已新增 1 道回忆题');
  });

  it('keeps the last result on screen, busy and muted, while a new selection is checked', async () => {
    const preview = checker();
    await render({ preview });
    parse(wide);
    await settleCheck();
    const node = summary();
    expect(node.textContent).toContain('将新增 3 道回忆题');
    expect(node.getAttribute('aria-busy')).toBe('false');
    expect(node.getAttribute('aria-live')).toBe('polite');
    await act(async () => directoryCheckboxes()[1]!.click());
    // Same node, previous wording, marked busy: nothing unmounts or collapses.
    expect(summary()).toBe(node);
    expect(node.getAttribute('aria-busy')).toBe('true');
    expect(node.getAttribute('data-stale')).toBe('true');
    expect(node.textContent).toContain('将新增 3 道回忆题');
    await settleCheck();
    expect(summary()).toBe(node);
    expect(node.getAttribute('aria-busy')).toBe('false');
    expect(node.hasAttribute('data-stale')).toBe(false);
    expect(node.querySelector('.intake-check-headline')?.textContent).toBe('将新增 2 道回忆题');
    expect(
      [...node.querySelectorAll('.intake-check-facts li')].map((li) => li.textContent),
    ).toEqual(['新增 2 道', '重复跳过 0 道', '冲突 0 道', '基础奖励 +4']);
    expect(node.querySelector('.intake-check-note')?.textContent).toContain('另 +5');
  });

  it('marks a kept result stale but not busy when the newer check fails', async () => {
    const quick = checker();
    let calls = 0;
    const preview = vi.fn((selection: IntakeSelection) => {
      calls++;
      return calls === 2 ? Promise.reject(new Error('local unavailable')) : quick(selection);
    });
    await render({ preview });
    parse(wide);
    await settleCheck();
    await act(async () => directoryCheckboxes()[1]!.click());
    await settleCheck();
    expect(host.textContent).toContain('local unavailable');
    expect(summary().getAttribute('aria-busy')).toBe('false');
    expect(summary().getAttribute('data-stale')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute('aria-busy')).toBe('false');
    expect(saveButton().hasAttribute('data-check')).toBe(false);
    await act(async () => button('重试核对').click());
    await settleCheck();
    expect(summary().hasAttribute('data-stale')).toBe(false);
    expect(summary().textContent).toContain('将新增 2 道回忆题');
    expect(saveButton().disabled).toBe(false);
  });

  it('changes only the toggled row status; every other row keeps its checked wording', async () => {
    await render({ preview: checker({ c: 'duplicate' }) });
    parse(wide);
    await settleCheck();
    const before = rowStatuses();
    expect(before).toEqual(['将新增', '将新增', '已存在 · 跳过', '待核实 · 未选']);
    await act(async () => directoryCheckboxes()[1]!.click());
    const during = rowStatuses();
    expect(during).toEqual([before[0], '未选', before[2], before[3]]);
    await settleCheck();
    expect(rowStatuses()).toEqual(during);
    await act(async () => directoryCheckboxes()[3]!.click());
    expect(rowStatuses()).toEqual([before[0], '未选', before[2], '已选']);
    await settleCheck();
    expect(rowStatuses()).toEqual([before[0], '未选', before[2], '将新增']);
  });

  it('keeps the save label steady, busy and disabled until the check is fresh', async () => {
    const save = vi.fn();
    await render({ preview: checker(), save });
    parse(wide);
    await settleCheck();
    expect(saveButton().textContent).toBe('保存已选 3 道题');
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute('aria-busy')).toBe('false');
    await act(async () => directoryCheckboxes()[1]!.click());
    expect(saveButton().textContent).toBe('保存已选 2 道题');
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    // A quick check keeps the settled look; the shared busy styles wait for the delay.
    expect(saveButton().getAttribute('data-check')).toBe('quiet');
    await act(async () => saveButton().click());
    expect(save).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('正在核对');
    await settleCheck();
    expect(saveButton().textContent).toBe('保存已选 2 道题');
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().getAttribute('aria-busy')).toBe('false');
    expect(saveButton().hasAttribute('data-check')).toBe(false);
  });

  it('never saves against a stale result, even when the disabled state is bypassed', async () => {
    const preview = checker();
    const save = vi.fn().mockResolvedValue({
      notes: 0,
      questions: 2,
      rewardReceiptIds: [],
      entries: [],
      rewardAmount: 4,
      warning: null,
    });
    await render({ preview, save });
    parse(wide);
    await settleCheck();
    await act(async () => directoryCheckboxes()[1]!.click());
    const action = saveButton();
    action.disabled = false;
    await act(async () => action.click());
    expect(save).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledTimes(1);
    await settleCheck();
    const ids = (selection: IntakeSelection) =>
      selection.package.records.flatMap((record) =>
        record.questions.map((question) => question.id),
      );
    expect(ids(preview.mock.calls[1]![0])).toEqual(['a', 'c']);
    await act(async () => saveButton().click());
    expect(preview).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
    expect(ids(save.mock.calls[0]![0])).toEqual(['a', 'c']);
  });

  it('keeps one detail status slot and the confirmation note in place while ticking', async () => {
    await render({ preview: checker() });
    parse(wide);
    await settleCheck();
    const slot = host.querySelector('.intake-detail-status')!;
    expect(slot.textContent).toBe('保存后进入复习。');
    await act(async () => host.querySelector<HTMLInputElement>('.intake-check input')!.click());
    expect(host.querySelector('.intake-detail-status')).toBe(slot);
    expect(slot.textContent).toBe('未选。');
    await settleCheck();
    expect(host.querySelector('.intake-detail-status')).toBe(slot);
    await act(async () => directoryButtons()[3]!.click());
    const unconfirmed = host.querySelector('.intake-detail-status')!;
    const note = host.querySelector('.intake-confirm-note')!;
    expect(note.textContent).toContain('这题需要核实依据');
    expect(unconfirmed.textContent).toBe('核实依据后再勾选。');
    await act(async () => host.querySelector<HTMLInputElement>('.intake-check input')!.click());
    expect(host.querySelector('.intake-confirm-note')).toBe(note);
    expect(host.querySelector('.intake-detail-status')).toBe(unconfirmed);
    expect(unconfirmed.textContent).toBe('已选，正在检查。');
    await settleCheck();
    expect(unconfirmed.textContent).toBe('保存后进入复习。');
  });

  it('shows a short conflict label in the row and the full explanation in the detail pane', async () => {
    await render({ preview: checker({ a: 'conflict' }) });
    parse(wide);
    await settleCheck();
    expect(rowStatuses()[0]).toBe('冲突');
    expect(host.querySelector('.intake-directory')?.textContent).not.toContain('相同 ID');
    expect(host.querySelector('.intake-detail-status')?.textContent).toBe(INTAKE_CONFLICT_DETAIL);
    expect(saveButton().disabled).toBe(true);
    expect(summary().textContent).toContain('冲突 1 道');
    expect(host.querySelector('.intake-selection-hint')?.textContent).toBe(
      '有冲突题，排除后才能保存',
    );
  });

  it('shows pending text only when a check outlasts the quiet delay', async () => {
    const quick = checker();
    let calls = 0;
    let release: ((value: IntakeResult) => void) | undefined;
    const preview = vi.fn((selection: IntakeSelection) => {
      calls++;
      return calls === 2
        ? new Promise<IntakeResult>((resolve) => {
            release = resolve;
          })
        : quick(selection);
    });
    await render({ preview });
    parse(wide);
    await settleCheck();
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(host.textContent ?? ''));
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    // The second check is slow: nothing changes before the delay, then one pending state.
    await act(async () => directoryCheckboxes()[1]!.click());
    await advance(500);
    expect(seen.some((text) => text.includes('正在检查'))).toBe(false);
    expect(saveButton().getAttribute('data-check')).toBe('quiet');
    await advance(100);
    expect(host.querySelector('.intake-selection-hint')?.textContent).toBe('正在检查…');
    expect(saveButton().hasAttribute('data-check')).toBe(false);
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    const result = await quick(preview.mock.calls[1]![0]);
    await act(async () => release!(result));
    expect(host.querySelector('.intake-selection-hint')?.textContent).toBe('');
    // A check that settles within the delay never shows the pending state.
    seen.length = 0;
    await act(async () => directoryCheckboxes()[1]!.click());
    for (let step = 0; step < 8; step++) await advance(100);
    observer.disconnect();
    expect(seen.some((text) => text.includes('正在检查'))).toBe(false);
    expect(saveButton().disabled).toBe(false);
  });

  it('keeps the draft status steady while toggling and stores the new selection', async () => {
    await render({ preview: checker() });
    parse(wide);
    await advance(500);
    expect(host.textContent).toContain('已存草稿');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(host.textContent ?? ''));
    observer.observe(host, { subtree: true, childList: true, characterData: true });
    await act(async () => directoryCheckboxes()[1]!.click());
    await advance(800);
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((text) => text.includes('正在存草稿'))).toBe(false);
    expect(host.textContent).toContain('已存草稿');
    const stored = [...drafts.values()].find((row) => row.scope === 'intake')!.payload;
    expect(stored).toMatchObject({ selected: ['["r1","a"]', '["r2","c"]'] });
  });

  it('serializes the package once per package change, not per toggle', async () => {
    await render({ preview: checker() });
    parse(wide);
    await settleCheck();
    const stringify = vi.spyOn(JSON, 'stringify');
    const packageCalls = () =>
      stringify.mock.calls.filter(
        ([value]) =>
          typeof value === 'object' && value !== null && 'format' in value && 'records' in value,
      ).length;
    await act(async () => directoryCheckboxes()[1]!.click());
    await act(async () => directoryCheckboxes()[3]!.click());
    await settleCheck();
    expect(packageCalls()).toBe(0);
    edit(0);
    type(host.querySelector('textarea')!, '改过的问题？');
    expect(packageCalls()).toBe(1);
  });

  it('applies one package category to every question and lets each row differ in place', async () => {
    const preview = checker();
    await render({ preview, categoriesLoader: twoCategories });
    parse(wide);
    // Every category control is visible at once: bar, one per row, and the detail pane.
    const selects = [...host.querySelectorAll('select')];
    expect(selects).toHaveLength(1 + 4 + 1);
    expect(selects.every((select) => !select.closest('details') && !select.disabled)).toBe(true);
    expect(host.textContent).not.toContain('更多选项');
    await choose(defaultCategory(), 'c1');
    await choose(rowCategory(2), 'c2');
    await choose(rowCategory(3), '');
    await settleCheck();
    expect(preview.mock.lastCall![0].questionCategories).toEqual({
      '["r1","a"]': 'c1',
      '["r1","b"]': 'c2',
      '["r2","c"]': null,
    });
    expect(rows().map((row) => row.getAttribute('data-category'))).toEqual([
      null,
      'override',
      'override',
      null,
    ]);
    expect(rows()[1]!.querySelector('.intake-category-flag')?.textContent).toContain('单独');
    expect(host.querySelector('.intake-override-note')?.textContent).toContain('2 道单独设置');
    expect(host.querySelector<HTMLSelectElement>('.intake-detail select')?.value).toBe('c1');
    // Choosing the package value in a row makes that row follow the package again.
    await choose(rowCategory(2), 'c1');
    expect(rows()[1]!.hasAttribute('data-category')).toBe(false);
    expect(host.querySelector('.intake-override-note')?.textContent).toContain('1 道单独设置');
    await choose(defaultCategory(), 'c2');
    await settleCheck();
    expect(preview.mock.lastCall![0].questionCategories).toEqual({
      '["r1","a"]': 'c2',
      '["r1","b"]': 'c2',
      '["r2","c"]': null,
    });
    await act(async () => button('全部跟随统一分类').click());
    expect(document.activeElement).toBe(defaultCategory());
    expect(host.querySelector('.intake-override-note')?.textContent).toBe('全部题目跟随统一分类');
    await settleCheck();
    expect(preview.mock.lastCall![0].questionCategories).toEqual({
      '["r1","a"]': 'c2',
      '["r1","b"]': 'c2',
      '["r2","c"]': 'c2',
    });
    expect(rowCategory(4).value).toBe('c2');
  });

  it('never flashes pending feedback when quick checks follow a series of quick changes', async () => {
    const quick = checker();
    // Each check takes 60 ms; the second change lands while the first request runs.
    const preview = vi.fn(async (selection: IntakeSelection) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return quick(selection);
    });
    await render({ preview });
    parse(wide);
    await advance(400);
    expect(saveButton().disabled).toBe(false);
    const seen: { hint: string; check: string | null; busy: string | null }[] = [];
    const observer = new MutationObserver(() =>
      seen.push({
        hint: hint() ?? '',
        check: saveButton().getAttribute('data-check'),
        busy: saveButton().getAttribute('aria-busy'),
      }),
    );
    observer.observe(host, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    await act(async () => directoryCheckboxes()[1]!.click());
    await advance(280);
    await act(async () => directoryCheckboxes()[0]!.click());
    for (let step = 0; step < 10; step++) await advance(70);
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((sample) => sample.hint.includes('正在检查'))).toBe(false);
    // Busy is announced, but the shared spinner and dimming never showed.
    expect(seen.filter((sample) => sample.busy === 'true' && sample.check === null)).toEqual([]);
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toBe('保存已选 1 道题');
  });

  it('keeps the expected look during a quick check after loading, in conflict and re-ticking', async () => {
    await render({ preview: checker({ a: 'conflict' }) });
    parse(wide);
    // First load: no result yet, and still no spinner.
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(saveButton().getAttribute('data-check')).toBe('quiet');
    await settleCheck();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().hasAttribute('data-check')).toBe(false);
    // Excluding the conflict: the expected result can be saved, so it looks ready at once.
    await act(async () => directoryCheckboxes()[0]!.click());
    expect(saveButton().getAttribute('data-check')).toBe('quiet');
    expect(hint()).toBe('');
    await settleCheck();
    expect(saveButton().disabled).toBe(false);
    // Re-ticking the known conflict keeps the plain disabled look, never the busy one.
    await act(async () => directoryCheckboxes()[0]!.click());
    expect(saveButton().getAttribute('data-check')).toBe('quiet-off');
    expect(saveButton().textContent).toBe('保存已选 2 道题');
    expect(rowStatuses()[0]).toBe('冲突');
    expect(hint()).toBe('有冲突题，排除后才能保存');
    await settleCheck();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe('保存已选 2 道题');
    expect(saveButton().hasAttribute('data-check')).toBe(false);
  });

  it('keeps a re-ticked known duplicate out of the save count while it is checked', async () => {
    await render({ preview: checker({ a: 'duplicate', b: 'duplicate', c: 'duplicate' }) });
    parse(wide);
    await settleCheck();
    expect(saveButton().textContent).toBe('没有新题需要保存');
    await act(async () => directoryCheckboxes()[0]!.click());
    expect(saveButton().textContent).toBe('没有新题需要保存');
    expect(saveButton().getAttribute('data-check')).toBe('quiet-off');
    await settleCheck();
    await act(async () => directoryCheckboxes()[0]!.click());
    // The last result did not cover row 1, but its outcome is still known.
    expect(saveButton().textContent).toBe('没有新题需要保存');
    expect(saveButton().getAttribute('data-check')).toBe('quiet-off');
    expect(rowStatuses()[0]).toBe('已存在 · 跳过');
    await settleCheck();
    expect(saveButton().textContent).toBe('没有新题需要保存');
  });

  it('lists questions already in the library below the workspace, steady while toggling', async () => {
    const onViewItem = vi.fn();
    await render({
      preview: checker({ a: 'duplicate', b: 'duplicate', c: 'duplicate' }),
      onViewItem,
    });
    parse(wide);
    await settleCheck();
    const packetArea = host.querySelector('.intake-packet')!;
    const workspace = host.querySelector('.intake-workspace')!;
    const above = () => {
      const children = [...packetArea.children];
      return children.slice(0, children.indexOf(workspace));
    };
    const before = above();
    const existing = host.querySelector('.intake-existing')!;
    expect(workspace.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(existing.querySelector('summary')?.textContent).toBe('3 道已在资料库 · 查看');
    const same = (nodes: Element[]) =>
      nodes.length === before.length && nodes.every((node, index) => node === before[index]);
    await act(async () => directoryCheckboxes()[0]!.click());
    await settleCheck();
    expect(same(above())).toBe(true);
    expect(host.querySelector('.intake-existing')).toBe(existing);
    expect(existing.querySelectorAll('li')).toHaveLength(3);
    // Ticking a new question changes the result, not what sits above the workspace.
    await act(async () => directoryCheckboxes()[3]!.click());
    await settleCheck();
    expect(same(above())).toBe(true);
    expect(existing.querySelectorAll('li')).toHaveLength(3);
    await act(async () => existing.querySelector('button')!.click());
    expect(onViewItem).toHaveBeenCalledWith('t-a');
    // Editing an unticked duplicate drops the link that described its old content.
    await act(async () => directoryCheckboxes()[1]!.click());
    await settleCheck();
    edit(1);
    type(host.querySelector('textarea')!, '改写后的问题乙？');
    expect(existing.querySelectorAll('li')).toHaveLength(2);
    expect(existing.textContent).not.toContain('问题乙');
  });

  it('remembers a save pressed during a quick check and saves once that selection is fresh', async () => {
    const save = vi.fn().mockResolvedValue({
      notes: 0,
      questions: 2,
      rewardReceiptIds: [],
      entries: [],
      rewardAmount: 4,
      warning: null,
    });
    await render({ preview: checker(), save });
    parse(wide);
    await settleCheck();
    await act(async () => directoryCheckboxes()[1]!.click());
    expect(saveButton().disabled).toBe(true);
    expect(saveSlot().getAttribute('data-check')).toBe('quiet');
    // The disabled button lets the press through to its slot, which answers at once.
    await act(async () => saveSlot().click());
    expect(save).not.toHaveBeenCalled();
    expect(hint()).toBe('检查后自动保存');
    expect(saveButton().getAttribute('aria-busy')).toBe('true');
    expect(saveButton().hasAttribute('data-check')).toBe(false);
    await settleCheck();
    await advance(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(questionIds(save.mock.calls[0]![0])).toEqual(['a', 'c']);
    expect(host.textContent).toContain('已新增 2 道回忆题');
  });

  it('drops a remembered save when the selection changes again before the check', async () => {
    const save = vi.fn();
    await render({ preview: checker(), save });
    parse(wide);
    await settleCheck();
    await act(async () => directoryCheckboxes()[1]!.click());
    await act(async () => saveSlot().click());
    expect(hint()).toBe('检查后自动保存');
    await act(async () => directoryCheckboxes()[2]!.click());
    expect(hint()).not.toBe('检查后自动保存');
    await settleCheck();
    await advance(0);
    expect(save).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
    expect(hint()).toBe('');
    // A press that came from the button itself is never taken for a remembered save.
    await act(async () => directoryCheckboxes()[2]!.click());
    const action = saveButton();
    action.disabled = false;
    await act(async () => action.click());
    expect(hint()).not.toBe('检查后自动保存');
  });

  it('keeps a question category while the package category steps past it, and can follow again', async () => {
    const preview = checker();
    await render({ preview, categoriesLoader: threeCategories });
    parse(wide);
    await choose(defaultCategory(), 'c1');
    await choose(rowCategory(2), 'c2');
    // ArrowDown on the closed package select fires one change per option.
    await choose(defaultCategory(), 'c2');
    expect(rows()[1]!.getAttribute('data-category')).toBe('override');
    await choose(defaultCategory(), 'c3');
    expect(rowCategory(2).value).toBe('c2');
    expect(rows()[1]!.getAttribute('data-category')).toBe('override');
    expect(host.querySelector('.intake-override-note')?.textContent).toContain('1 道单独设置');
    await settleCheck();
    expect(preview.mock.lastCall![0].questionCategories).toEqual({
      '["r1","a"]': 'c3',
      '["r1","b"]': 'c2',
      '["r2","c"]': 'c3',
    });
    // The detail pane shows the same choice and can let this question follow again.
    await act(async () => directoryButtons()[1]!.click());
    const note = host.querySelector('.intake-detail .intake-category-note')!;
    expect(note.textContent).toContain('单独设置');
    await act(async () => button('改为跟随统一分类').click());
    expect(rowCategory(2).value).toBe('c3');
    expect(rows()[1]!.hasAttribute('data-category')).toBe(false);
    expect(host.querySelector('.intake-detail .intake-category-note')).toBe(note);
    expect(note.textContent).toBe('跟随统一分类');
    expect(document.activeElement).toBe(host.querySelector('.intake-detail select'));
  });

  it('continues at the package category after a successful category retry', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing categories'))
      .mockResolvedValue([category('c1', '阅读')]);
    await render({ preview: checker(), categoriesLoader: loader });
    parse(wide);
    const heading = host.querySelector('h2')!;
    const focus = vi.spyOn(heading, 'focus');
    const retry = button('重试分类');
    retry.focus();
    await act(async () => retry.click());
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(defaultCategory());
    expect(defaultCategory().disabled).toBe(false);
  });

  it('keeps the follow-all action disabled until the categories have loaded', async () => {
    drafts.set('loading-draft', {
      schemaVersion: 1,
      id: 'loading-draft',
      scope: 'intake',
      revision: 1,
      updatedAt: '2026-10-20T10:00:00.000Z',
      summary: '整理回忆题 · 4 道',
      payload: {
        id: 'loading-draft',
        text: '',
        packetText: JSON.stringify(wide),
        selected: ['["r1","a"]'],
        currentKey: null,
        defaultCategory: null,
        questionCategories: { '["r1","a"]': 'c2' },
      },
    });
    await render({ preview: checker(), categoriesLoader: () => new Promise(() => undefined) });
    await act(async () => button('继续').click());
    expect(host.querySelector('.intake-override-note')?.textContent).toContain('1 道单独设置');
    expect(button('全部跟随统一分类').disabled).toBe(true);
  });

  it('shows the draft line from the first change and updates it in place once saved', async () => {
    await render({ preview: checker() });
    parse(wide);
    const line = host.querySelector('.draft-recovery [role=status]');
    expect(line?.textContent).toBe('\u00a0');
    await advance(500);
    expect(host.querySelector('.draft-recovery [role=status]')).toBe(line);
    expect(line?.textContent).toBe('已存草稿');
  });

  it('restores a draft saved before per-question categories as overrides for that material', async () => {
    drafts.set('old-draft', {
      schemaVersion: 1,
      id: 'old-draft',
      scope: 'intake',
      revision: 1,
      updatedAt: '2026-10-20T10:00:00.000Z',
      summary: '整理回忆题 · 4 道',
      payload: {
        id: 'old-draft',
        text: '',
        packetText: JSON.stringify(wide),
        selected: ['["r1","a"]', '["r2","c"]'],
        currentKey: '["r2","c"]',
        categories: { r2: 'c2' },
      },
    });
    const preview = checker();
    await render({ preview, categoriesLoader: twoCategories });
    await act(async () => button('继续').click());
    await settleCheck();
    expect(preview.mock.lastCall![0].questionCategories).toEqual({
      '["r1","a"]': null,
      '["r2","c"]': 'c2',
    });
    expect(defaultCategory().value).toBe('');
    expect([1, 2, 3, 4].map((number) => rowCategory(number).value)).toEqual(['', '', 'c2', 'c2']);
    // The next draft write uses the current shape.
    await advance(500);
    expect(drafts.get('old-draft')?.payload).toMatchObject({
      defaultCategory: null,
      questionCategories: { '["r2","c"]': 'c2', '["r2","d"]': 'c2' },
    });
  });
});
