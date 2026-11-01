import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DraftRecovery } from '../shared/DraftRecovery';
import type { DurableDraftController, DurableDraftStatus } from '../shared/use-durable-draft';

const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');
const hiddenSelector = globalCss.match(/(\.draft-recovery\s+>[^{]*?)\s*\{\s*display: none;/u)?.[1];

function render(status: DurableDraftStatus, overrides: Partial<DurableDraftController> = {}) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <DraftRecovery
      draft={
        {
          status,
          error: null,
          available: [],
          retry: vi.fn(),
          restore: vi.fn(),
          discard: vi.fn(),
          later: vi.fn(),
          ...overrides,
        } as unknown as DurableDraftController
      }
    />,
  );
  return {
    section: host.querySelector<HTMLElement>('.draft-recovery')!,
    line: host.querySelector<HTMLElement>('[data-draft-status]')!,
  };
}

/**
 * Runs the rule's real selectors against the component's real output. jsdom cannot parse an
 * attribute inside :has(), so that one step is walked by hand.
 */
function isHidden(element: HTMLElement) {
  return (hiddenSelector ?? '').split(',').some((raw) => {
    const selector = raw.trim();
    const has = selector.match(/^(.+):has\(>\s*(.+)\)$/u);
    if (!has) return element.matches(selector);
    return (
      element.matches(has[1]!) && [...element.children].some((child) => child.matches(has[2]!))
    );
  });
}

describe('desktop draft status line', () => {
  it.each(['pending', 'saving', 'saved'] as const)(
    'hides %s and the section it would leave blank',
    (status) => {
      const { section, line } = render(status);
      expect(line.getAttribute('data-draft-status')).toBe(status);
      expect(isHidden(line)).toBe(true);
      expect(isHidden(section)).toBe(true);
    },
  );

  it('keeps the failure line, its alert and the retry button visible', () => {
    const { section, line } = render('error', { error: '存草稿失败，请重试。' });
    expect(isHidden(line)).toBe(false);
    expect(isHidden(section)).toBe(false);
    expect(section.querySelector('[role=alert] button')?.textContent).toBe('重试草稿');
  });

  it('keeps a recovery offer visible while its saved line stays hidden', () => {
    const { section, line } = render('saved', {
      available: [
        { id: 'a', summary: '上次的草稿', updatedAt: '2026-10-30T12:00:00.000Z' },
      ] as unknown as DurableDraftController['available'],
    });
    expect(isHidden(line)).toBe(true);
    expect(isHidden(section)).toBe(false);
    expect(section.textContent).toContain('发现以前未完成的草稿');
  });

  it('keeps an error that arrives while the line reads saved', () => {
    const { section, line } = render('saved', { error: '无法恢复这份草稿。' });
    expect(isHidden(line)).toBe(true);
    expect(isHidden(section)).toBe(false);
  });
});
