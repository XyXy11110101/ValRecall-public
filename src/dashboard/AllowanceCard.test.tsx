import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ALLOWANCE } from '../shared/allowance';
import { AllowanceCard } from './AllowanceCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AllowanceCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('locks same-turn submits and keeps rejected inputs available for retry', async () => {
    let reject!: (error: Error) => void;
    const onSpend = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(true);
    act(() =>
      root.render(<AllowanceCard state={{ ...DEFAULT_ALLOWANCE, balance: 9 }} onSpend={onSpend} />),
    );
    const amount = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(amount, '2');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(onSpend).toHaveBeenCalledTimes(1);
    expect(amount.disabled).toBe(true);
    await act(async () => reject(new Error('storage unavailable')));
    expect(amount.value).toBe('2');
    expect(container.textContent).toContain('没能更新，请重试。');
    await act(async () =>
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true })),
    );
    expect(onSpend).toHaveBeenCalledTimes(2);
    expect(amount.value).toBe('');
  });

  it('shows the current balance and streak', () => {
    act(() =>
      root.render(
        <AllowanceCard
          state={{ ...DEFAULT_ALLOWANCE, balance: 12, currentStreak: 4 }}
          onSpend={() => true}
        />,
      ),
    );
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('当前余额');
    expect(container.textContent).toContain('4');
    expect(container.textContent).toContain('连续天数');
    const stats = container.querySelectorAll('.home-allowance-stat');
    expect(stats).toHaveLength(2);
    expect(stats[0]?.getAttribute('data-allowance-stat')).toBe('balance');
    expect(stats[1]?.getAttribute('data-allowance-stat')).toBe('streak');
    expect(container.querySelector('.home-allowance-spend')).not.toBeNull();
    expect(container.textContent).toContain('花掉');
  });

  it('names the section for assistive technology instead of showing a heading', () => {
    act(() =>
      root.render(
        <AllowanceCard state={DEFAULT_ALLOWANCE} onAdd={() => true} onSpend={() => true} />,
      ),
    );
    const section = container.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBe('花掉或加入');
    expect(section?.querySelector('h3, .eyebrow')).toBeNull();
    expect(section?.textContent).not.toContain('花掉或加入');
    expect(section?.textContent).not.toContain('（可选）');
    const note = [...container.querySelectorAll('label')].find((label) =>
      label.querySelector('input[type="text"]'),
    );
    expect(note?.textContent).toBe('备注');

    act(() => root.render(<AllowanceCard state={DEFAULT_ALLOWANCE} onSpend={() => true} />));
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe('零花钱');
  });

  it('confirms a successful manual add without spending', async () => {
    const onAdd = vi.fn(() => true);
    const onSpend = vi.fn(() => true);
    act(() =>
      root.render(
        <AllowanceCard
          state={{ ...DEFAULT_ALLOWANCE, balance: 4 }}
          onAdd={onAdd}
          onSpend={onSpend}
        />,
      ),
    );
    const amount = container.querySelector('input[type="number"]');
    const note = container.querySelector('input[type="text"]');
    await act(async () => {
      if (!(amount instanceof HTMLInputElement) || !(note instanceof HTMLInputElement)) {
        throw new Error('Expected add fields.');
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(amount, '3');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(note, 'gift');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '加入')
        ?.click();
      await Promise.resolve();
    });
    expect(onAdd).toHaveBeenCalledWith(3, 'gift');
    expect(onSpend).not.toHaveBeenCalled();
    expect(container.textContent).toContain('手动加入了 3 零花钱。gift');
    expect(
      [...container.querySelectorAll('[data-allowance-action]')].map((button) =>
        button.getAttribute('data-allowance-action'),
      ),
    ).toEqual(['spend', 'add']);
  });

  it('rejects an amount above the balance without calling onSpend', async () => {
    const onSpend = vi.fn(() => true);
    act(() =>
      root.render(<AllowanceCard state={{ ...DEFAULT_ALLOWANCE, balance: 3 }} onSpend={onSpend} />),
    );
    const amount = container.querySelector('input[type="number"]');
    await act(async () => {
      if (!(amount instanceof HTMLInputElement)) throw new Error('Expected amount input.');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(amount, '8');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    expect(onSpend).not.toHaveBeenCalled();
    expect(container.textContent).toContain('这个金额超过了当前零花钱。');
  });

  it('confirms a successful spend with a 你 line', async () => {
    const onAdd = vi.fn(() => true);
    const onSpend = vi.fn(() => true);
    act(() =>
      root.render(
        <AllowanceCard
          state={{ ...DEFAULT_ALLOWANCE, balance: 9 }}
          onAdd={onAdd}
          onSpend={onSpend}
        />,
      ),
    );
    const amount = container.querySelector('input[type="number"]');
    const note = container.querySelector('input[type="text"]');
    await act(async () => {
      if (!(amount instanceof HTMLInputElement) || !(note instanceof HTMLInputElement)) {
        throw new Error('Expected spend fields.');
      }
      const numberSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      numberSetter?.call(amount, '2');
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      numberSetter?.call(note, 'tea');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onSpend).toHaveBeenCalledWith(2, 'tea');
    expect(onAdd).not.toHaveBeenCalled();
    expect(container.textContent).toContain('花掉了 2 零花钱。tea');
  });
});
