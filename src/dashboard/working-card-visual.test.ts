// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/dashboard/working-card.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

describe('working card and layout styles', () => {
  it('keeps the next step small and without a box', () => {
    expect(rule('.home-working-next')).toContain('font-size: calc(13px * var(--font-scale))');
    expect(rule('.home-working-next')).toContain('color: var(--muted)');
    const input = rule('.home-working-card .home-working-fields input.home-working-next-input');
    expect(input).toContain('font-size: calc(13px * var(--font-scale))');
    expect(input).toContain('background: transparent');
    expect(input).toContain('border: 0');
    expect(input).toContain('border-bottom: 1px solid');
  });

  it('keeps the note without a box at rest and in focus, with a line for focus', () => {
    const area = rule('.home-working-card .home-working-notes textarea');
    expect(area).toContain('background: transparent');
    expect(area).toContain('border: 0');
    expect(area).toContain('field-sizing: content');
    expect(area).toContain('resize: none');
    const focus = rule('.home-working-card .home-working-notes textarea:focus-visible');
    expect(focus).toContain('var(--accent)');
    expect(focus).not.toContain('background');
    expect(rule('.home-working-notes')).toContain('border-top: 1px solid var(--line)');
  });

  it('lifts the fixed height while working, so the card grows and the page scrolls', () => {
    const rail = rule('.home-layout[data-working] .home-tasks-rail');
    expect(rail).toContain('contain: none');
    expect(rail).toContain('min-height: 0');
    expect(rule('.home-layout[data-working] .home-tasks-card')).toContain('max-height: none');
    expect(rule('.home-layout[data-working] .home-workspaces')).toContain(
      'grid-template-columns: minmax(0, 1fr)',
    );
    expect(rule('.home-layout[data-working] .home-task-scroll')).toContain('overflow: visible');
    expect(rule('.home-layout[data-working] .home-working-slot')).toContain('max-height: none');
  });

  it('keeps one wallet on the page while working, and one line of card actions', () => {
    expect(rule('.home-layout[data-working] .home-task-counts .home-task-wallet')).toContain(
      'display: none',
    );
    expect(rule('.home-working-card .home-task-list li > .home-task-actions')).toContain(
      'flex-wrap: nowrap',
    );
  });

  it('animates only the finite fold of the last overdue row and the flip between layouts', () => {
    expect(rule('.home-task-group.is-folding')).toContain('280ms');
    const flipStart = css.indexOf('@supports (view-transition-name: none)');
    const flipEnd = css.indexOf('.home-working-rest-toggle.button.text-button {');
    const outside = css.slice(0, flipStart) + css.slice(flipEnd);
    expect(outside.match(/animation(-[a-z]+)?:/g)).toEqual(['animation:']);
    expect(css).not.toContain('infinite');
  });

  describe('the flip between layouts', () => {
    const flip = css.slice(
      css.indexOf('@supports (view-transition-name: none)'),
      css.indexOf('@keyframes working-flip-contents-out'),
    );

    it('only exists while the hook runs one, and never under reduced motion', () => {
      expect(flip).toContain('@media (prefers-reduced-motion: no-preference)');
      const rules = flip.replace(/\/\*[\s\S]*?\*\//g, '');
      const names = [...rules.matchAll(/([^{}]+)\{\s*view-transition-name:/g)].map((match) =>
        match[1]!.trim(),
      );
      expect(names.length).toBeGreaterThan(0);
      for (const selector of names) expect(selector).toMatch(/^html\[data-working-flip/);
    });

    // The browser still skips named elements when it hit-tests. The hook's own tests cover those.
    it('keeps the page itself out of the transition, and the overlay out of the way', () => {
      expect(rule('html[data-working-flip]')).toContain('view-transition-name: none');
      expect(flip).toMatch(
        /html\[data-working-flip\]::view-transition,\s*html\[data-working-flip\]::view-transition-group\(\*\) \{\s*pointer-events: none;/,
      );
    });

    it('keeps a coin in the air over the pictures, live and unfaded', () => {
      expect(rule('html[data-working-flip] .task-coin-layer')).toContain(
        'view-transition-name: working-flip-coin',
      );
      expect(rule('html[data-working-flip]::view-transition-group(working-flip-coin)')).toContain(
        'z-index: 3',
      );
      expect(rule('html[data-working-flip]::view-transition-new(working-flip-coin)')).toContain(
        'animation: none',
      );
    });

    it('takes a soft 380ms both ways, with no overshoot and no stretched text', () => {
      expect(flip).toContain('animation-duration: 380ms');
      expect(flip).not.toMatch(/cubic-bezier\([^)]*(-|1\.[1-9])/);
      expect(flip).not.toMatch(/object-fit: (cover|fill)/);
      expect(flip).toMatch(
        /::view-transition-new\(working-flip-support\) \{\s*width: auto;\s*height: auto;/,
      );
    });

    it('holds contents still with the same curve and length as the box around them', () => {
      const curve = 'cubic-bezier(0.33, 0, 0.2, 1)';
      expect(flip).toContain(`animation-timing-function: ${curve}`);
      expect(flip).toContain(`working-flip-still-old 380ms ${curve} both`);
      expect(flip).toContain(`working-flip-still-new 380ms ${curve} both`);
      expect(css).toMatch(
        /@keyframes working-flip-still-new \{\s*from \{\s*translate: calc\(var\(--working-flip-x\) \* -1\) calc\(var\(--working-flip-y\) \* -1\);/,
      );
    });

    it('keeps the sidebar on one layer, so its text does not change with the layout', () => {
      expect(css).toMatch(
        /@media \(min-width: 901px\) \{\s*html:has\(\.home-layout\) \.dashboard-sidebar \{\s*will-change: opacity;/,
      );
    });

    it('leaves route behaviour to global.css', () => {
      const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');
      expect(globalCss).not.toContain('data-working-flip');
      expect(globalCss).toMatch(
        /::view-transition-old\(root\),\s*::view-transition-new\(root\) \{\s*animation: none;/,
      );
    });
  });
});
