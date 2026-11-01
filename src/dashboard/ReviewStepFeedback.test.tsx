import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewStepFeedback, type ReviewStepReceipt } from './ReviewStepFeedback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('committed review step feedback', () => {
  let root: Root;
  let container: HTMLDivElement;
  let hidden = false;
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function show(receipt: ReviewStepReceipt | null) {
    act(() => root.render(<ReviewStepFeedback receipt={receipt} />));
  }
  it('shows only the reward confirmed by the saved receipt', () => {
    show({ id: 'paid', rewardAmount: 1 });
    expect(container.textContent).toContain('零花钱 +1 元');
    // The amount is the visual hero and is announced once, inside the receipt sentence.
    expect(container.querySelector('.review-step-earned .review-step-amount')?.textContent).toBe(
      '+1 元',
    );
    expect(container.querySelector('[data-rewarded="true"]')).not.toBeNull();
    show({ id: 'legacy', rewardAmount: 0 });
    expect(container.textContent).not.toContain('零花钱 +');
    expect(container.querySelector('.review-step-amount')).toBeNull();
    show({ id: 'preview' });
    expect(container.textContent).not.toContain('元');
  });
  it('is only the check and the amount, with no count or task wording', () => {
    for (const receipt of [{ id: 'paid', rewardAmount: 1 }, { id: 'preview' }]) {
      show(receipt);
      expect(container.querySelector('.review-step-seal svg')).not.toBeNull();
      expect(container.querySelector('.review-step-seal')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(container.querySelector('.review-step-copy')).toBeNull();
      expect(container.querySelector('.review-step-plus')).toBeNull();
      expect(container.textContent).not.toContain('完成一题');
      expect(container.textContent).not.toContain('本轮已复习');
      expect(container.textContent).not.toContain('+1 道');
    }
  });
  it('still tells a screen reader the rating saved when no money was paid', () => {
    show({ id: 'preview' });
    const region = container.querySelector('[role="status"]');
    expect(region?.querySelector('.sr-only')?.textContent).toBe('已保存');
  });
  it('is sized to cover the speech bubble alone at the two-lane width', () => {
    const css = readFileSync(resolve('src/dashboard/review.css'), 'utf8');
    const wide = css.slice(css.indexOf('@container review-canvas (min-width: 960px)'));
    const minHeight = (selector: string) =>
      Number(
        wide.match(
          new RegExp(
            `${selector} \\{[^}]*?min-height: calc\\((\\d+)px \\* var\\(--font-scale\\)\\)`,
            's',
          ),
        )?.[1],
      );
    const bubble = minHeight('\\.review-view \\.review-speech');
    const stamp = minHeight('\\.review-step-feedback');
    expect(bubble).toBeGreaterThan(0);
    // Two lines of speech run a few pixels past the bubble's minimum.
    expect(stamp).toBeGreaterThanOrEqual(bubble);
    expect(stamp).toBeLessThanOrEqual(bubble + 8);
  });
  it('keeps the latest rapid completion until its own timeout, without stealing focus', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    show({ id: 'first' });
    act(() => vi.advanceTimersByTime(900));
    show({ id: 'second' });
    act(() => vi.advanceTimersByTime(500));
    expect(container.querySelector('.review-step-feedback')?.getAttribute('data-receipt-id')).toBe(
      'second',
    );
    expect(document.activeElement).toBe(input);
    act(() => vi.advanceTimersByTime(900));
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    input.remove();
  });
  it('dismisses on backgrounding and never replays on return', () => {
    show({ id: 'first' });
    expect(container.querySelector('.review-step-feedback')).not.toBeNull();
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(container.querySelector('.review-step-feedback')).toBeNull();
  });
  it('cleans up on reset and does not show a receipt received while hidden', () => {
    show({ id: 'first' });
    show(null);
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    hidden = true;
    show({ id: 'hidden' });
    expect(container.querySelector('.review-step-feedback')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
