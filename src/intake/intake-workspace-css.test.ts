// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/intake/intake-workspace.css'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('intake workspace layout contract', () => {
  it('keeps the save action one width while its count or busy state changes', () => {
    const action = rule('.intake-selection-bar .button.primary-action');
    expect(action).toMatch(/min-inline-size:\s*11em/u);
    expect(action).toMatch(/font-variant-numeric:\s*tabular-nums/u);
    // The two-pane layout restores the full-size action with its own fixed width.
    expect(css.slice(css.indexOf('@container intake (min-width: 52em)'))).toMatch(
      /\.intake-selection-bar \.button\.primary-action \{\s*min-inline-size:\s*13em/u,
    );
  });

  it('keeps the settled look during a quick check and lets a press reach the slot', () => {
    // Every quiet variant hides the shared spinner and passes the pointer through.
    expect(rule('.intake-selection-bar .primary-action[data-check]')).toMatch(
      /pointer-events:\s*none/u,
    );
    expect(rule('.intake-selection-bar .primary-action[data-check]::after')).toMatch(
      /content:\s*none/u,
    );
    expect(rule(".intake-selection-bar .primary-action[data-check='quiet']:disabled")).toMatch(
      /opacity:\s*1/u,
    );
    // A result that could not be saved keeps the plain disabled look, never the busy one.
    expect(rule(".intake-selection-bar .primary-action[data-check='quiet-off']:disabled")).toMatch(
      /opacity:\s*0\.48/u,
    );
  });

  it('reserves fixed lines for status text instead of collapsing them', () => {
    expect(rule('.intake-selection-hint')).toMatch(/min-block-size:\s*1\.6em/u);
    expect(rule('.intake-selection-hint')).toMatch(/white-space:\s*nowrap/u);
    const slot = rule('.intake-detail .intake-detail-status');
    expect(slot).toMatch(/min-block-size:\s*3\.2em/u);
    // One font size and line height for every tone, so the reserved height is fixed.
    expect(slot).toMatch(/font-size:\s*var\(--text-small\)/u);
    expect(slot).toMatch(/line-height:\s*1\.6/u);
    expect(rule('.intake-override-note,\n.intake-category-note')).toMatch(
      /min-block-size:\s*1\.5rem/u,
    );
    expect(css).toMatch(
      /@container intake \(max-width: 36em\) \{\s*\.intake-check-note \{\s*min-block-size:\s*3\.2em/u,
    );
    expect(rule('.intake-directory-title,\n.intake-directory-status')).toMatch(
      /text-overflow:\s*ellipsis/u,
    );
  });

  it('drives every sticky edge from the measured bar height and hides the heading ring', () => {
    expect(rule('.intake-packet')).toMatch(
      /--intake-sticky-top:\s*var\(--intake-cover, var\(--intake-sticky-offset\)\)/u,
    );
    expect(css.match(/top:\s*var\(--intake-sticky-top\)/gu)).toHaveLength(2);
    expect(css).toMatch(/min-block-size:\s*var\(--intake-sticky-offset\)/u);
    expect(css).toMatch(/scroll-margin-top:\s*calc\(var\(--intake-sticky-top\) \+ 1rem\)/u);
    expect(css).not.toMatch(/top:\s*6rem/u);
    expect(rule('.intake-embedded-heading:focus')).toMatch(/outline:\s*none/u);
  });

  it('gives every row select one width and moves it to its own line in a narrow list', () => {
    expect(rule('.intake-directory-meta')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) auto calc\(8rem \* var\(--font-scale\)\)/u,
    );
    expect(css).toMatch(/@container intake-directory \(max-width: 22em\)/u);
  });

  it('mutes a kept result while it is stale, without changing its size', () => {
    const stale = rule(".intake-check-summary.notice[data-stale='true']");
    expect(stale).toMatch(/color:\s*var\(--muted\)/u);
    expect(stale).not.toMatch(/height|margin|padding|display|font-size/u);
  });

  it('keeps the stale summary static: no animation or transition in this stylesheet', () => {
    expect(css).not.toMatch(/@keyframes|animation|transition|infinite/u);
  });
});
