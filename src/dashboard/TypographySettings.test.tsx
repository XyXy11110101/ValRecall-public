import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTypographyStore,
  TYPOGRAPHY_STORAGE_KEY,
  type TypographyStorage,
} from '../ui/typography';
import { TypographySettings } from './TypographySettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('TypographySettings', () => {
  let container: HTMLDivElement;
  let root: Root;
  let html: HTMLElement;
  let change: Parameters<TypographyStorage['onChanged']>[0];
  let storage: {
    get: ReturnType<typeof vi.fn<TypographyStorage['get']>>;
    set: ReturnType<typeof vi.fn<TypographyStorage['set']>>;
    onChanged: TypographyStorage['onChanged'];
  };

  async function render() {
    const store = createTypographyStore({
      storage: () => storage,
      root: () => html,
      faces: () => Promise.resolve(),
    });
    await store.start();
    await act(async () => root.render(<TypographySettings store={store} />));
    return store;
  }

  const radios = (name: string) => [
    ...container.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`),
  ];
  const radio = (name: string, value: string) => radios(name).find((r) => r.value === value)!;
  const checked = (name: string) => radios(name).find((r) => r.checked)?.value;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    html = document.createElement('html');
    change = () => undefined;
    storage = {
      get: vi.fn<TypographyStorage['get']>().mockResolvedValue({}),
      set: vi.fn<TypographyStorage['set']>().mockResolvedValue(undefined),
      onChanged: (listener) => {
        change = listener;
      },
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers two labelled radio groups, with the defaults chosen', async () => {
    await render();
    const groups = [...container.querySelectorAll('fieldset')];
    expect(groups.map((group) => group.querySelector('legend')?.textContent)).toEqual([
      '字体',
      '大小',
    ]);
    expect(radios('typography-font').map((r) => r.value)).toEqual([
      'wenkai',
      'misans',
      'noto',
      'yahei',
    ]);
    expect(radios('typography-size').map((r) => r.value)).toEqual([
      'small',
      'standard',
      'large',
      'xlarge',
    ]);
    expect(checked('typography-font')).toBe('wenkai');
    expect(checked('typography-size')).toBe('standard');
    for (const input of [...radios('typography-font'), ...radios('typography-size')])
      expect(input.closest('label')).not.toBeNull();
  });

  it('names each size and font, and shows each font with digits in its own font', async () => {
    await render();
    const labels = (name: string) => radios(name).map((r) => r.closest('label')?.textContent);
    expect(labels('typography-size')).toEqual(['小', '标准', '大', '特大']);
    expect(labels('typography-font')).toEqual([
      '霞鹜文楷今天复习 19 道',
      'MiSans今天复习 19 道',
      '思源黑体今天复习 19 道',
      '微软雅黑今天复习 19 道',
    ]);
    const samples = [...container.querySelectorAll<HTMLElement>('[data-font-sample]')];
    expect(samples.map((sample) => sample.dataset.fontSample)).toEqual([
      'wenkai',
      'misans',
      'noto',
      'yahei',
    ]);
    // Read once by name: the sample repeats on all four, so it stays out of the group's names.
    for (const sample of samples) expect(sample.getAttribute('aria-hidden')).toBe('true');
  });

  it('has no explanation, save button or success notice', async () => {
    await render();
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('p')).toBeNull();
    await act(async () => radio('typography-size', 'large').click());
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[role="status"], [role="alert"], .notice')).toBeNull();
  });

  it('applies a choice at once and stores it', async () => {
    await render();
    await act(async () => radio('typography-size', 'xlarge').click());
    expect(html.getAttribute('data-text-size')).toBe('xlarge');
    expect(checked('typography-size')).toBe('xlarge');
    expect(storage.set).toHaveBeenCalledExactlyOnceWith({
      [TYPOGRAPHY_STORAGE_KEY]: { size: 'xlarge', font: 'wenkai' },
    });
    await act(async () => radio('typography-font', 'misans').click());
    expect(html.getAttribute('data-font')).toBe('misans');
    expect(html.getAttribute('data-text-size')).toBe('xlarge');
    expect(checked('typography-font')).toBe('misans');
    expect(storage.set).toHaveBeenLastCalledWith({
      [TYPOGRAPHY_STORAGE_KEY]: { size: 'xlarge', font: 'misans' },
    });
  });

  it('keeps one choice per group', async () => {
    await render();
    await act(async () => radio('typography-font', 'noto').click());
    await act(async () => radio('typography-font', 'yahei').click());
    expect(radios('typography-font').filter((r) => r.checked)).toHaveLength(1);
    expect(checked('typography-font')).toBe('yahei');
  });

  it('shows a change made on another page', async () => {
    await render();
    act(() => change({ [TYPOGRAPHY_STORAGE_KEY]: { newValue: { size: 'large', font: 'noto' } } }));
    expect(checked('typography-size')).toBe('large');
    expect(checked('typography-font')).toBe('noto');
  });

  it('opens on the stored choice', async () => {
    storage.get.mockResolvedValue({ [TYPOGRAPHY_STORAGE_KEY]: { size: 'small', font: 'yahei' } });
    await render();
    expect(checked('typography-size')).toBe('small');
    expect(checked('typography-font')).toBe('yahei');
  });

  it('goes back and reports it when the choice cannot be stored, until the next one works', async () => {
    await render();
    storage.set.mockRejectedValueOnce(new Error('quota'));
    await act(async () => radio('typography-size', 'xlarge').click());
    expect(container.textContent).toContain('字体和大小没保存，请重试。');
    expect(checked('typography-size')).toBe('standard');
    expect(html.getAttribute('data-text-size')).toBe('standard');
    await act(async () => radio('typography-size', 'large').click());
    expect(container.textContent).not.toContain('没保存');
    expect(checked('typography-size')).toBe('large');
  });

  it('renders on the server path without a snapshot error', () => {
    const store = createTypographyStore({ storage: () => null, root: () => html });
    expect(renderToStaticMarkup(<TypographySettings store={store} />)).toContain('字体');
  });
});
