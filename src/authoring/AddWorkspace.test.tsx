import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValRecallRepository } from '../database';
import { DraftRepository } from '../database/drafts';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import { requestEditorLeaveAsync } from '../shared/edit-protection';
import { installDraftMemoryPort } from '../testing/draft-port';
import { AddWorkspace } from './AddWorkspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('add workspace draft navigation', () => {
  let host: HTMLDivElement;
  let root: Root;
  let rows: ReturnType<typeof installDraftMemoryPort>;
  beforeEach(() => {
    rows = installDraftMemoryPort();
    vi.spyOn(ValRecallRepository.prototype, 'listCategories').mockResolvedValue([]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  function type(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
    act(() => {
      const prototype =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function render(active = true) {
    await act(async () =>
      root.render(
        <AddWorkspace
          active={active}
          request={{ key: 1, mode: 'manual' }}
          preferences={DEFAULT_PREFERENCES}
          onChanged={vi.fn()}
          onViewItem={vi.fn()}
        />,
      ),
    );
  }
  it('opens on the page title with no slogan above it', async () => {
    await render();
    const heading = host.querySelector<HTMLElement>('h2')!;
    expect(heading.textContent).toBe('添加回忆题');
    expect(document.activeElement).toBe(heading);
    expect(heading.className).not.toContain('sr-only');
    expect(host.textContent).not.toContain('留给下一次回忆');
    expect(host.querySelector('.add-workspace > header')?.querySelector('.eyebrow')).toBeNull();
    expect(host.querySelector('.add-mode-switch')?.getAttribute('aria-label')).toBe('添加方式');
  });
  it('retains both modes before leaving without a redundant discard prompt', async () => {
    await render();
    type(host.querySelector<HTMLInputElement>('.manual-question-panel input')!, '手动题标题');
    await act(async () => button('接收 ChatGPT 整理').click());
    type(host.querySelector<HTMLTextAreaElement>('.intake-input textarea')!, '稍后解析的整理包');
    let left = false;
    await act(async () => {
      left = await requestEditorLeaveAsync();
    });
    expect(left).toBe(true);
    expect([...rows.values()].map((row) => row.scope).sort()).toEqual(['intake', 'manual']);
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => button('手动创建').click());
    expect(host.querySelector<HTMLInputElement>('.manual-question-panel input')?.value).toBe(
      '手动题标题',
    );
  });
  it('keeps the workspace mounted if a hidden mode fails to retain its latest input', async () => {
    await render();
    type(host.querySelector<HTMLInputElement>('.manual-question-panel input')!, '不能丢失的输入');
    await act(async () => button('接收 ChatGPT 整理').click());
    vi.mocked(DraftRepository.prototype.save).mockRejectedValue(new Error('保留失败'));
    let left = true;
    await act(async () => {
      left = await requestEditorLeaveAsync();
    });
    expect(left).toBe(false);
    expect(window.confirm).not.toHaveBeenCalled();
    await act(async () => button('手动创建').click());
    expect(host.querySelector<HTMLInputElement>('.manual-question-panel input')?.value).toBe(
      '不能丢失的输入',
    );
    expect(host.textContent).toContain('保留失败');
  });
});
