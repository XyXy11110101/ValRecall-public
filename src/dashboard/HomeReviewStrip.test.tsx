import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { companionArtPath, outfitForDate } from '../companion/wardrobe';
import { HomeReviewStrip } from './HomeReviewStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const companionBuild = vi.hoisted(() => ({ assets: true }));
vi.mock('./Companion', () => ({
  get COMPANION_ASSETS_ENABLED() {
    return companionBuild.assets;
  },
}));

const today = '2026-10-30';

function strip(extra: Partial<Parameters<typeof HomeReviewStrip>[0]> = {}) {
  return (
    <HomeReviewStrip
      dueCount={3}
      available
      action="review"
      showHead
      dateKey={today}
      streak={4}
      balance={7}
      onStartReview={() => undefined}
      onAddQuestion={() => undefined}
      onRetry={() => undefined}
      onOpenAllowance={() => undefined}
      {...extra}
    />
  );
}

describe('HomeReviewStrip', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    companionBuild.assets = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('says what is due and offers one way in, and keeps the streak and the wallet', () => {
    act(() => root.render(strip()));
    expect(container.querySelector('.home-review-strip-due')?.textContent).toBe('今日复习3条到期');
    expect([...container.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual([
      '开始复习',
      '零花钱 7',
    ]);
    expect(container.querySelector('[data-allowance-stat="streak"]')?.textContent).toBe(
      '连续 4 天',
    );
    // The coin lands on this number, and it can grow when it lands.
    const wallet = container.querySelector('[data-wallet-target="home"]');
    expect(wallet?.textContent).toBe('7');
    expect(wallet?.classList.contains('home-wallet-target')).toBe(true);
  });

  it.each([
    ['review', '开始复习', 'onStartReview'],
    ['add', '添加回忆题', 'onAddQuestion'],
    ['retry', '重试首页摘要', 'onRetry'],
  ] as const)('runs the %s action', (action, label, handler) => {
    const handlers = {
      onStartReview: vi.fn(),
      onAddQuestion: vi.fn(),
      onRetry: vi.fn(),
    };
    act(() => root.render(strip({ action, ...handlers })));
    const button = container.querySelector<HTMLButtonElement>('.home-review-strip-action');
    expect(button?.textContent).toBe(label);
    act(() => button?.click());
    for (const [name, mock] of Object.entries(handlers))
      expect(mock).toHaveBeenCalledTimes(name === handler ? 1 : 0);
  });

  it('never guesses a count it could not load', () => {
    act(() => root.render(strip({ available: false, action: 'retry', dueCount: 0 })));
    expect(container.querySelector('.home-review-strip-due')?.textContent).toBe(
      '今日复习没加载出来',
    );
    expect(container.querySelector('.home-review-strip-due strong')).toBeNull();
  });

  it('opens the ledger from the wallet', () => {
    const onOpenAllowance = vi.fn();
    act(() => root.render(strip({ onOpenAllowance })));
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-allowance-stat="balance"]')?.click(),
    );
    expect(onOpenAllowance).toHaveBeenCalledOnce();
  });

  it('shows the still head, as decoration only', () => {
    act(() => root.render(strip()));
    const head = container.querySelector('img');
    expect(head?.getAttribute('src')).toBe(
      companionArtPath(outfitForDate(today), 'head-smile', 'static'),
    );
    expect(head?.getAttribute('alt')).toBe('');
    expect(head?.getAttribute('aria-hidden')).toBe('true');
    expect(head?.getAttribute('data-companion-motion')).toBe('static');
  });

  it('leaves no placeholder when the art is missing, and takes no head when told', () => {
    act(() => root.render(strip()));
    act(() => container.querySelector('img')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.companion-abstract')).toBeNull();
    act(() => root.render(strip({ showHead: false, dateKey: '2026-10-31' })));
    expect(container.querySelector('img')).toBeNull();
  });

  it('has no art and no art path in an ordinary build', () => {
    companionBuild.assets = false;
    const markup = renderToStaticMarkup(strip());
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('assets/companion');
    expect(markup).not.toContain('companion-abstract');
    expect(markup).toContain('开始复习');
  });
});
