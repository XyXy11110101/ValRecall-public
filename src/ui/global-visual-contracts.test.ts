import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const globalCss = readFileSync(resolve('src/styles/global.css'), 'utf8');

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = globalCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'su'));
  expect(match, `Expected a CSS rule for ${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('global editorial visual contracts', () => {
  it('keeps a bounded visible Capture cue and wrapping Library previews', () => {
    const capture = cssRule('.capture-cue > .capture-screenshot');
    expect(capture).toContain('max-height: min(28vh, 16rem)');
    expect(capture).toContain('object-fit: contain');
    expect(cssRule('.library-row-copy')).toContain('overflow-wrap: anywhere');
    expect(cssRule('.library-row-excerpt')).toContain('-webkit-line-clamp: 3');
    expect(cssRule('.home-summary-aside')).toContain('repeat(3, minmax(max-content, 1fr))');
    expect(globalCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.nav-tabs\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s,
    );
  });

  it('maintains at least 4.5:1 contrast for body, secondary, action and status text', () => {
    const root = cssRule(':root');
    const color = (name: string) => {
      const hex = root.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, 'u'))?.[1];
      expect(hex).toBeDefined();
      const channels = (hex ?? '#000000').slice(1).match(/../gu) ?? [];
      return channels
        .map((channel) => {
          const value = parseInt(channel, 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    };
    for (const [foreground, background] of [
      ['ink', 'paper'],
      ['muted', 'paper'],
      ['muted', 'canvas'],
      ['paper', 'accent'],
      ['danger', 'danger-soft'],
      ['success', 'surface-status-success'],
    ]) {
      const values = [color(foreground!), color(background!)].sort((a, b) => b - a);
      expect((values[0]! + 0.05) / (values[1]! + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps ordinary sections flat and success feedback distinct', () => {
    expect(globalCss).toContain('--surface-card: var(--paper);');
    expect(globalCss).toContain('--surface-status-success: #e4f1e9;');
    expect(globalCss).toContain('--radius-card: 0.75rem;');
    expect(globalCss).toContain('--shadow-card: none;');

    const card = cssRule('.card');
    expect(card).toContain('background: transparent');
    expect(card).toContain('border-radius: 0');
    expect(card).toContain('box-shadow: none');
    expect(card).not.toMatch(/(?:linear|radial)-gradient|url\(/u);

    expect(cssRule('.notice.success')).toContain('background: var(--surface-status-success)');
    expect(cssRule('.button.amber:hover:not(:disabled)')).toContain(
      'background: var(--accent-hover)',
    );
    expect(cssRule('.button.danger:hover:not(:disabled)')).toContain(
      'background: var(--danger-soft)',
    );
  });

  it.each(['idle', 'due', 'reviewing', 'success'] as const)(
    'lets the %s Companion hero tint its existing ambient wash',
    (state) => {
      expect(globalCss).toContain(`--ambient-${state}:`);
      expect(cssRule(`.companion-hero-${state}`)).toContain(`var(--ambient-${state})`);
    },
  );

  it('keeps Home companion-first in one column instead of restoring a 22rem rail', () => {
    const homeLayout = cssRule('.home-layout');
    expect(homeLayout).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(homeLayout).not.toMatch(/22rem|fit-content/u);

    const companionStage = cssRule('.home-companion-stage');
    expect(companionStage).toContain('min-width: 0');
    expect(companionStage).not.toMatch(/position:\s*(?:fixed|absolute)|width:\s*22rem/u);
    expect(globalCss).toContain('@container home-layout (max-width: 36em)');
    expect(globalCss).toContain('@container home-layout (max-width: 42em)');
    // Home shows the complete illustrated figure standing on the stage floor, not a zoomed crop.
    const homeFigure = cssRule('.home-companion-stage .companion-image');
    expect(homeFigure).toContain('height: 100%');
    expect(homeFigure).toContain('bottom: 0');
    expect(homeFigure).toContain('object-fit: contain');
    expect(homeFigure).not.toMatch(/width: \d+%/u);
    expect(globalCss).not.toContain('width: 185%');

    // The illustrated states share one registered canvas: no per-state trims remain.
    expect(globalCss).not.toContain('--companion-asset-inline-trim');
    expect(globalCss).not.toContain('--companion-asset-top-trim');
    expect(cssRule('.companion-stack-image')).toContain('transform: none');
  });

  it('lets Library density follow the actual dashboard content width', () => {
    expect(cssRule('.dashboard-main')).toContain('container: dashboard-main / inline-size');
    expect(globalCss).toMatch(
      /@container dashboard-main \(max-width: 60em\)[\s\S]*?\.library-workspace\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*?\.category-desktop-navigation\s*\{[^}]*display: none[\s\S]*?\.category-mobile-picker\s*\{[^}]*display: grid/,
    );
    expect(globalCss).not.toContain('@media (max-width: 1100px)');
  });

  it('keeps Review-specific layout rules out of the shared stylesheet', () => {
    expect(globalCss).not.toMatch(/\.review-(?:entry-card|cue-row|companion-viewport)\s*\{/);
    const reviewCss = readFileSync(resolve('src/dashboard/review.css'), 'utf8');
    expect(reviewCss).toContain('container: review-canvas / inline-size');
  });

  it('keeps major and compact empty-state surfaces additive and asset-free', () => {
    const major = cssRule('.empty-state-major');
    expect(major).toContain('background: transparent');
    expect(major).toContain('border-top: 1px solid var(--line)');

    const compact = cssRule('.empty-state-compact');
    expect(compact).toContain('background: transparent');
    expect(compact).toContain('var(--space-4)');

    for (const surface of [major, compact]) {
      expect(surface).not.toMatch(/url\(|position:\s*fixed|filter:|animation:/u);
    }
  });

  it('adds one bounded White REST presence only to genuine Library empty scopes', () => {
    const companion = cssRule('.companion-empty');
    expect(companion).toContain('min-height: 10rem');
    expect(companion).toContain('background: transparent');
    expect(cssRule('.companion')).toContain('pointer-events: none');
    expect(companion).not.toMatch(/position:\s*(?:fixed|absolute)|animation:/u);

    const emptyLayout = cssRule('.library-empty-state-with-companion');
    expect(emptyLayout).toContain('grid-template-columns: minmax(0, 1fr) minmax(8.5rem, 24%)');
    expect(globalCss).toMatch(
      /@container dashboard-main \(max-width: 36em\)[\s\S]*?\.library-empty-state-with-companion\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(6\.5rem, 32%\)[\s\S]*?\.companion-empty\s*\{[^}]*height: 8rem/s,
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.companion:not\(\.companion-empty\)\s*\{[^}]*min-height: 20rem/s,
    );
    expect(globalCss).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.companion:not\(\.companion-empty\)\s*\{[^}]*min-height: 18rem/s,
    );
    expect(globalCss).not.toMatch(
      /@media \(max-width: (?:900|760)px\)[\s\S]*?\.companion\s*\{[^}]*min-height: (?:20|18)rem/s,
    );
  });

  it('keeps Home pocket money as compact completed-stat tiles with a stacked spend row', () => {
    const card = cssRule('.home-allowance-card');
    expect(card).toContain('background: transparent');

    const stats = cssRule('.home-allowance-stats');
    expect(stats).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');

    const tile = cssRule('.home-allowance-stat');
    expect(tile).toContain('background: transparent');
    expect(cssRule('.home-allowance-stat strong')).toContain('font-size: var(--text-title)');
    expect(cssRule('.home-due-count strong')).toContain(
      'font-size: calc(3.5rem * var(--font-scale))',
    );
    expect(cssRule('.button.primary-action')).toContain('min-height: 56px');

    const spend = cssRule('.home-allowance-spend');
    expect(spend).toContain('grid-template-columns: minmax(6.5rem, 8rem) minmax(0, 1fr) auto');
    expect(spend).toContain('border-top: 1px solid var(--line)');
    expect(globalCss).toMatch(
      /@container home-layout \(max-width: 36em\)[\s\S]*?\.home-allowance-stats,\s*\n\s*\.home-allowance-spend\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/s,
    );
  });

  it('defaults to offline LXGW WenKai with reading fallbacks and keeps Home still for reduced motion', () => {
    expect(globalCss).toContain("@import '../assets/fonts/lxgw/lxgw.css'");
    expect(cssRule(':root')).toMatch(
      /--font-stack-wenkai:\s*'LXGW WenKai Screen',\s*'ValRecall Reading',/u,
    );
    expect(cssRule(':root')).toContain('--font-ui: var(--font-stack-wenkai)');
    expect(globalCss).toContain("'Noto Sans SC'");
    expect(globalCss).toContain("'Microsoft YaHei UI'");
    expect(globalCss).toContain("'PingFang SC'");
    expect(globalCss).toContain("'Noto Sans CJK SC'");
    // Edge injects its own body font and a 75% size into every extension page. That beats
    // inheriting from :root, so body has to name both, or most text is YaHei at 12px.
    expect(cssRule('body')).toContain('font-family: var(--font-ui)');
    expect(cssRule('body')).toContain('font-size: var(--text-body)');
    // LXGW ships one weight, so its headings get their weight this way. See typography-contract.
    expect(globalCss).toMatch(
      /h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*-webkit-text-stroke: var\(--heading-stroke\) currentColor;/s,
    );
    expect(globalCss).toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-family: var\(--font-display\)[^}]*letter-spacing: normal/s,
    );
    expect(globalCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.home-view\[data-initial-entry='true'\] \.home-entry-region\s*\{[^}]*transform: none[^}]*animation: none/s,
    );
  });

  it('declares Chinese for the desktop dashboard and capture surface', () => {
    for (const path of ['dashboard.html', 'sidepanel.html']) {
      expect(readFileSync(resolve(path), 'utf8')).toMatch(/<html\s+lang="zh-CN">/);
    }
  });

  it('lets the whole Library directory scroll when expanded tools exceed its viewport bound', () => {
    const workspace = readFileSync(resolve('src/dashboard/library-workspace.css'), 'utf8');
    const directory = workspace.match(/\.library-view \.library-directory\s*\{([^}]*)\}/s)?.[1];
    expect(directory).toContain('max-height: calc(100dvh - 7rem)');
    expect(directory).toContain('overflow-y: auto');
    expect(directory).toContain('scrollbar-gutter: stable');
    expect(workspace).toMatch(
      /@container library-workspace \(width < 52em\)[\s\S]*?\.library-view \.library-directory\s*\{[^}]*max-height: none[^}]*overflow: visible/s,
    );
  });

  it.each([
    ['src/authoring/authoring.css', '.manual-save-area', 'src/authoring/ManualQuestionForm.tsx'],
    ['src/sidepanel/capture-workspace.css', '.capture-save-bar', 'src/sidepanel/SidePanelApp.tsx'],
    [
      'src/dashboard/library-workspace.css',
      '.library-editor-actions',
      'src/dashboard/MomentEditor.tsx',
    ],
  ])(
    'bounds the sticky action region and keeps focus clear of it in %s',
    (path, actionSelector, component) => {
      const sheet = readFileSync(resolve(path), 'utf8');
      const escaped = (selector: string) => selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const action = sheet.match(
        new RegExp(`${escaped(actionSelector)}\\s*\\{([^}]*)\\}`, 's'),
      )?.[1];
      expect(sheet).toContain('--editor-actions-clearance: min(20rem, 45dvh)');
      expect(action).toContain('max-height: var(--editor-actions-clearance)');
      expect(action).toContain('overflow-y: auto');
      expect(action).toContain('position: sticky');
      // A field's scroll margin does nothing for Tab or typing: the browser reveals the caret.
      expect(sheet).not.toContain('scroll-margin-block-end');
      expect(readFileSync(resolve(component), 'utf8')).toMatch(
        new RegExp(`ref=\\{stickyBarClearance\\}\\s+className="[^"]*${actionSelector.slice(1)}`),
      );
    },
  );

  it('lets the sidebar scroll by itself on a short window, but not where it stops sticking', () => {
    const sidebar = cssRule('.dashboard-sidebar');
    expect(sidebar).toContain('position: sticky');
    expect(sidebar).toContain('max-height: calc(100vh - 2rem + 5px)');
    expect(sidebar).toContain('overflow: hidden auto');
    expect(sidebar).toContain('scrollbar-width: none');
    expect(globalCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.dashboard-sidebar\s*\{[^}]*position: static;[^}]*max-height: none;[^}]*overflow: visible/s,
    );
  });

  it('stops a long label squeezing the value of a metadata list', () => {
    expect(cssRule('.metadata')).toContain(
      'grid-template-columns: fit-content(45%) minmax(0, 1fr)',
    );
  });

  it('gives a date in a narrow task form the whole width', () => {
    expect(globalCss).toMatch(/\.task-form \{\s*container: task-form \/ inline-size;/s);
    expect(globalCss).toMatch(
      /@container task-form \(max-width: 18em\) \{\s*\.task-form \.field-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/s,
    );
  });

  it('keeps the question the same weight in the Add preview as in Review and capture', () => {
    const authoring = readFileSync(resolve('src/authoring/authoring.css'), 'utf8');
    expect(authoring).toMatch(/\.manual-preview \.reading-question \{[^}]*font-weight: 500;/s);
  });

  it('lets the 工作中 title wrap and keeps 返回目录 on one line', () => {
    const working = readFileSync(resolve('src/dashboard/working-card.css'), 'utf8');
    expect(working).toMatch(
      /\.home-layout\[data-working\] \.home-working-card \{[^}]*overflow-wrap: anywhere;/s,
    );
    const library = readFileSync(resolve('src/dashboard/library-workspace.css'), 'utf8');
    expect(library).toMatch(
      /\.library-return-directory \{\s*display: inline-flex;\s*flex-shrink: 0;\s*white-space: nowrap;/s,
    );
  });

  it('keeps the em query of the recent list live at 小', () => {
    expect(globalCss).toMatch(
      /@container home-learning \(max-width: 30em\) \{[\s\S]*?\.home-list-item \{\s*--home-list-narrow: 1;/s,
    );
  });

  it('scales the Intake category select with its text', () => {
    const intake = readFileSync(resolve('src/intake/intake-workspace.css'), 'utf8');
    expect(intake).toContain('auto calc(8rem * var(--font-scale))');
    expect(intake).toContain('width: calc(10rem * var(--font-scale))');
  });
});
