import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ALLOWANCE, type AllowanceState } from '../shared/allowance';
import { AllowanceLedgerView } from './AllowanceLedgerView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AllowanceLedgerView', () => {
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

  it('lists earn and spend rows newest first', async () => {
    const state: AllowanceState = {
      ...DEFAULT_ALLOWANCE,
      balance: 8,
      totalEarned: 12,
      totalSpent: 4,
      ledgerSeq: 3,
      ledger: [
        {
          id: 'al-3',
          at: '2026-08-26T12:00:00.000Z',
          date: '2026-08-26',
          kind: 'spend',
          source: 'spend',
          amount: 4,
          note: 'tea',
          balanceAfter: 8,
        },
        {
          id: 'al-2',
          at: '2026-08-26T11:00:00.000Z',
          date: '2026-08-26',
          kind: 'earn',
          source: 'check-in',
          amount: 5,
          note: '每日打卡',
          balanceAfter: 12,
        },
        {
          id: 'al-1',
          at: '2026-08-26T10:00:00.000Z',
          date: '2026-08-26',
          kind: 'earn',
          source: 'capture',
          amount: 2,
          note: '保存 Moment',
          balanceAfter: 2,
        },
      ],
    };
    await act(async () => {
      root.render(<AllowanceLedgerView allowanceLoader={async () => state} />);
      await Promise.resolve();
    });

    // One title, and it stays the page's focus target.
    const headings = [...container.querySelectorAll('h1, h2, h3, .eyebrow')];
    expect(headings.map((heading) => heading.textContent)).toEqual(['零花钱记录']);
    expect(headings[0]?.getAttribute('tabindex')).toBe('-1');
    expect(container.textContent).not.toContain('学习赚的零花钱');
    expect(container.textContent).not.toContain('花掉或加入');
    expect(container.textContent).not.toContain('（可选）');
    expect(container.textContent).not.toContain('返回首页');
    expect(container.textContent?.match(/当前余额/gu)).toHaveLength(1);
    expect(container.querySelector('.home-allowance-stats')).toBeNull();
    expect(container.textContent).toContain('累计进入');
    expect(container.textContent).toContain('累计花掉');
    expect(container.querySelector('.home-allowance-card')?.getAttribute('aria-label')).toBe(
      '花掉或加入',
    );
    expect(container.textContent).toContain('花掉');
    expect(container.textContent).toContain('加入');
    expect(
      [...container.querySelectorAll('[data-allowance-action]')].map((button) =>
        button.getAttribute('data-allowance-action'),
      ),
    ).toEqual(['spend', 'add']);
    expect(container.querySelectorAll('.allowance-ledger-row')).toHaveLength(0);
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '进出明细（3）')
        ?.click();
      await Promise.resolve();
    });
    const rows = [...container.querySelectorAll('.allowance-ledger-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute('data-allowance-kind')).toBe('spend');
    expect(rows[0]?.textContent).toContain('tea');
    expect(rows[0]?.textContent).toContain('−4');
    expect(rows[1]?.textContent).toContain('每日打卡');
    expect(rows[1]?.textContent).toContain('+5');
    expect(rows[2]?.textContent).toContain('保存 Moment');
    expect(rows[2]?.textContent).toContain('+2');
  });

  it('shows an empty record state', async () => {
    await act(async () => {
      root.render(<AllowanceLedgerView allowanceLoader={async () => DEFAULT_ALLOWANCE} />);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-allowance-ledger="empty"]')?.textContent).toContain(
      '还没有进出记录',
    );
  });

  it('does not invent a zero balance or allow writes after a load failure, and can retry', async () => {
    let resolveRetry!: (state: AllowanceState) => void;
    const loader = vi
      .fn<() => Promise<AllowanceState>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)));
    const add = vi.fn();
    const spend = vi.fn();
    await act(async () => {
      root.render(
        <AllowanceLedgerView allowanceLoader={loader} allowanceAdd={add} allowanceSpend={spend} />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法加载');
    expect(container.querySelector('.allowance-ledger-summary')).toBeNull();
    expect(container.querySelector('[data-allowance-ledger="empty"]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();

    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === '重试加载')
        ?.click();
    });
    expect(container.textContent).toContain('正在加载零花钱');
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(add).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();

    await act(async () => resolveRetry({ ...DEFAULT_ALLOWANCE, balance: 12 }));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.allowance-ledger-summary strong')?.textContent).toBe('12');
    expect(container.querySelector('form')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('重试加载');
  });

  it('ignores an old loader result after the loader changes', async () => {
    let resolveOld!: (state: AllowanceState) => void;
    const oldLoader = () => new Promise<AllowanceState>((resolve) => (resolveOld = resolve));
    await act(async () => {
      root.render(<AllowanceLedgerView allowanceLoader={oldLoader} />);
    });
    await act(async () => {
      root.render(
        <AllowanceLedgerView
          allowanceLoader={async () => ({ ...DEFAULT_ALLOWANCE, balance: 7 })}
        />,
      );
    });
    await act(async () => resolveOld({ ...DEFAULT_ALLOWANCE, balance: 99 }));
    expect(container.querySelector('.allowance-ledger-summary strong')?.textContent).toBe('7');
  });
});
