import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtractionDiagnostic } from '../models/extraction';
import {
  boundedSourceContextLines,
  Diagnostics,
  formatRedactedDiagnostics,
  Header,
  LiveStatus,
  Notice,
  SourceContextDisclosure,
  SourceContextExcerpt,
} from './components';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const diagnostics: ExtractionDiagnostic[] = [
  {
    field: 'subtitles',
    strategy: 'bilibili-selected-track-resource',
    status: 'failed',
    severity: 'warning',
    message:
      'The selected first-party subtitle resource on aisubtitle.hdslb.com could not be read safely. https://example.invalid/private?id=account',
  },
];

describe('Header', () => {
  it('shows only the product name', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<Header />));
    expect(container.querySelector('h1.brand-name')?.textContent).toBe('ValRecall');
    expect(container.textContent).toBe('ValRecall');
    act(() => root.unmount());
  });
});

describe('Diagnostics', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('copies redacted technical diagnostics through an explicit accessible action', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await act(async () => {
      root.render(<Diagnostics diagnostics={diagnostics} open />);
      await Promise.resolve();
    });

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === '复制技术详情',
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(button?.type).toBe('button');
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('bilibili-selected-track-resource'),
    );
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('[redacted URL]'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('account'));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('已复制技术详情。');
  });

  it('formats only bounded single-line diagnostic fields and messages', () => {
    const formatted = formatRedactedDiagnostics([
      {
        ...diagnostics[0]!,
        message: `First line\n${'x'.repeat(700)}`,
      },
    ]);

    expect(formatted).not.toContain('\n');
    expect(formatted.length).toBeLessThan(650);
  });
});

describe('Notice', () => {
  it('keeps decorative leading art beside the message and out of the accessible text', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <Notice tone="error" leading={<img src="face.svg" alt="" />}>
          保存失败
        </Notice>,
      ),
    );
    const notice = container.querySelector('.notice');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.classList.contains('notice-with-leading')).toBe(true);
    expect(container.querySelector('.notice-leading')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.notice-body')?.textContent).toBe('保存失败');

    act(() => root.render(<Notice tone="error">保存失败</Notice>));
    expect(container.querySelector('.notice-leading')).toBeNull();
    expect(container.querySelector('.notice')?.textContent).toBe('保存失败');
    act(() => root.unmount());
    container.remove();
  });
});

describe('LiveStatus', () => {
  it('stays mounted and hidden, and re-announces identical text with a new node', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<LiveStatus text={null} seq={0} />));
    const region = container.querySelector('p');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.className).toBe('sr-only');
    expect(region?.textContent).toBe('');

    act(() => root.render(<LiveStatus text="已完成，+5 元零花钱。" seq={1} />));
    const first = region?.firstElementChild;
    expect(first?.textContent).toBe('已完成，+5 元零花钱。');
    act(() => root.render(<LiveStatus text="已完成，+5 元零花钱。" seq={1} />));
    expect(region?.firstElementChild).toBe(first);
    act(() => root.render(<LiveStatus text="已完成，+5 元零花钱。" seq={2} />));
    expect(container.querySelector('p')).toBe(region);
    expect(region?.firstElementChild).not.toBe(first);
    expect(region?.firstElementChild?.textContent).toBe('已完成，+5 元零花钱。');

    act(() => root.render(<LiveStatus text="x" seq={3} className="mobile-hidden" />));
    expect(container.querySelector('p')?.className).toBe('mobile-hidden');
    act(() => root.unmount());
    container.remove();
  });
});

describe('SourceContextDisclosure', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps nearby source evidence collapsed and separate from the answer by default', () => {
    act(() => {
      root.render(
        <SourceContextDisclosure
          before={['Earlier line']}
          current={['Current line']}
          after={['Later line']}
          summary="Captured from Bilibili · 02:03"
        />,
      );
    });

    const disclosure = container.querySelector('details');
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector('summary')?.textContent).toContain(
      'Captured from Bilibili · 02:03',
    );
    expect(disclosure?.querySelector('summary')?.getAttribute('aria-label')).toBe(
      '来源上下文：Captured from Bilibili · 02:03',
    );
    expect(disclosure?.textContent).not.toContain('随回忆题保存的来源材料');
  });

  it.each([
    ['current only', [], ['Current visible cue'], [], ['Current visible cue']],
    [
      'previous and current',
      ['Nearest previous cue'],
      ['Current visible cue'],
      [],
      ['Nearest previous cue', 'Current visible cue'],
    ],
    [
      'current and next',
      [],
      ['Current visible cue'],
      ['Nearest next cue'],
      ['Current visible cue', 'Nearest next cue'],
    ],
  ])(
    'renders partial %s source context without requiring a complete cue window',
    (_case, before, current, after, expected) => {
      act(() => {
        root.render(
          <SourceContextDisclosure before={before} current={current} after={after} open>
            <div data-source-metadata>Source metadata</div>
          </SourceContextDisclosure>,
        );
      });

      const disclosure = container.querySelector('details');
      const lines = [...container.querySelectorAll('.source-context-lines p')].map(
        (line) => line.textContent,
      );
      expect(lines).toEqual(expected);
      expect(disclosure?.querySelector('.source-context-lines')).not.toBeNull();
      expect(
        disclosure?.querySelector('.source-context-lines + [data-source-metadata]'),
      ).not.toBeNull();
    },
  );

  it('omits the subtitle section and empty placeholder when no reliable cue exists', () => {
    act(() => {
      root.render(
        <SourceContextDisclosure open>
          <div data-source-metadata>Source metadata remains available</div>
        </SourceContextDisclosure>,
      );
    });

    expect(container.querySelector('.source-context-lines')).toBeNull();
    expect(container.textContent).toContain('Source metadata remains available');
    expect(container.textContent).not.toContain('No nearby caption context');
  });

  it('renders a directly visible bounded excerpt only when subtitle cues exist', () => {
    act(() => {
      root.render(
        <SourceContextExcerpt
          before={['Repeated cue']}
          current={['Repeated cue']}
          after={['Next cue']}
          className="review-subtitle-context"
        />,
      );
    });

    const excerpt = container.querySelector('.review-subtitle-context');
    expect(excerpt?.closest('details')).toBeNull();
    expect(excerpt?.getAttribute('aria-label')).toBe('来源摘录');
    expect(excerpt?.querySelector('.eyebrow')?.textContent).toBe('来源摘录');
    expect(
      [...(excerpt?.querySelectorAll('.source-context-lines p') ?? [])].map(
        (line) => line.textContent,
      ),
    ).toEqual(['Repeated cue', 'Next cue']);

    act(() => root.render(<SourceContextExcerpt />));
    expect(container.querySelector('.source-context-excerpt')).toBeNull();
  });

  it('bounds, trims and deduplicates nearby caption lines', () => {
    const veryLongLine = 'x'.repeat(500);
    expect(
      boundedSourceContextLines(
        ['discarded', ' Earlier ', 'same'],
        [' SAME '],
        ['Later', veryLongLine, 'discarded'],
      ),
    ).toEqual([
      { kind: 'current', text: 'SAME' },
      { kind: 'after', text: 'Later' },
    ]);
  });

  it('keeps only the nearest previous, current and next cue', () => {
    expect(
      boundedSourceContextLines(
        ['Older line', 'Nearest previous'],
        ['Current line', 'Unused current'],
        ['Nearest next', 'Later line'],
      ),
    ).toEqual([
      { kind: 'before', text: 'Nearest previous' },
      { kind: 'current', text: 'Current line' },
      { kind: 'after', text: 'Nearest next' },
    ]);
  });

  it('bounds each retained cue without expanding the saved source window', () => {
    const veryLongLine = 'x'.repeat(500);

    expect(boundedSourceContextLines([], [veryLongLine], [])).toEqual([
      { kind: 'current', text: 'x'.repeat(320) },
    ]);
    expect(boundedSourceContextLines([veryLongLine], [veryLongLine], [])).toEqual([
      { kind: 'current', text: 'x'.repeat(320) },
    ]);
  });
});
