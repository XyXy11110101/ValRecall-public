import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualQuestionForm, type ManualQuestionFormProps } from '../authoring/ManualQuestionForm';
import type { ManualQuestionReceipt } from '../authoring/save-manual';
import { installDraftMemoryPort } from '../testing/draft-port';

vi.hoisted(() => Object.assign(globalThis, { __VALRECALL_PUBLIC_RELEASE__: true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STALE_LIST = '已保存，列表未更新，请刷新。';

describe('manual question saved view, public edition', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installDraftMemoryPort();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const button = (text: string) => {
    const found = [...host.querySelectorAll('button')].find((entry) => entry.textContent === text);
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  };

  const type = (label: string, value: string) => {
    const element = [...host.querySelectorAll('label')]
      .find((entry) => entry.querySelector('span')?.textContent === label)
      ?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
    if (!element) throw new Error(`Missing field ${label}`);
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  async function saveWith(onSaved: NonNullable<ManualQuestionFormProps['onSaved']>, warning = '') {
    const receipt = {
      item: { id: 'saved', title: '标题', recallPrompt: '问题？' },
      allowance: null,
      manualReward: null,
      warning: warning || null,
    } as unknown as ManualQuestionReceipt;
    const save = vi.fn<NonNullable<ManualQuestionFormProps['save']>>().mockResolvedValue(receipt);
    await act(async () =>
      root.render(
        <ManualQuestionForm loadCategories={async () => []} save={save} onSaved={onSaved} />,
      ),
    );
    type('标题', '标题');
    type('回忆问题', '问题？');
    type('答案要点', '答案');
    await act(async () => button('保存回忆题').click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(host.querySelector('h2')?.textContent).toBe('回忆题已保存');
  }

  const failing = () => {
    throw new Error('list refresh failed');
  };

  it('shows the error in the saved view when the list could not be updated', async () => {
    await saveWith(failing);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(STALE_LIST);
    expect(alert?.className).toBe('notice error');
  });

  it('keeps the save warning next to the error', async () => {
    await saveWith(failing, '图片未保存。');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(STALE_LIST);
    expect(host.querySelector('.notice.warning')?.textContent).toBe('图片未保存。');
  });

  it('shows no error when the list was updated', async () => {
    await saveWith(() => undefined);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain(STALE_LIST);
  });

  it('clears the error when the person continues to the next question', async () => {
    await saveWith(failing);
    await act(async () => button('继续记录').click());
    expect(host.textContent).not.toContain(STALE_LIST);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(button('保存回忆题')).toBeTruthy();
  });
});
