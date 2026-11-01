// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FONT_CHOICES, TEXT_SIZES } from './typography';

const SRC = resolve('src');
/** The phone has its own stylesheet and must not change. Font files only declare faces. */
const NOT_DESKTOP = ['mobile', join('assets', 'fonts')];

function files(extension: RegExp, directory = SRC): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return NOT_DESKTOP.includes(relative(SRC, path)) ? [] : files(extension, path);
    return extension.test(name) ? [path] : [];
  });
}

const stylesheets = files(/\.css$/u).map((path) => ({
  name: relative(SRC, path).replace(/\\/gu, '/'),
  css: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, ''),
}));
const global = readFileSync(resolve('src/styles/global.css'), 'utf8');

function declarations(property: string) {
  return stylesheets.flatMap(({ name, css }) =>
    [...css.matchAll(new RegExp(`(^|[;{\\s])${property}:\\s*([^;}]+)`, 'gu'))].map((match) => ({
      name,
      value: (match[2] ?? '').trim(),
      selector: css.slice(0, match.index).split('{').at(-2)?.split(/[;}]/u).pop()?.trim() ?? '',
    })),
  );
}

function rule(selector: string): string {
  const start = global.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No rule for ${selector}`);
  return global.slice(start, global.indexOf('}', start));
}

describe('text size contract', () => {
  /** rem has to stay 16px, or spacing, images and the page frame would follow the setting. */
  const UNSCALED_ON_PURPOSE = [{ name: 'styles/global.css', selector: ':root', value: '16px' }];
  /** A size that follows: a token, the scale, its parent, or nothing to show at all. */
  const FOLLOWS_THE_SCALE =
    /^(var\(--text-[a-z-]+\)|calc\(.+ \* var\(--font-scale\)\)|min\(var\(--text-[a-z-]+\), [\d.]+rem\)|[\d.]+em|inherit|0)$/u;

  it('finds the desktop stylesheets, and not the phone', () => {
    const names = stylesheets.map(({ name }) => name);
    expect(names).toContain('styles/global.css');
    expect(names).toContain('dashboard/review.css');
    expect(names.some((name) => name.startsWith('mobile/'))).toBe(false);
    expect(declarations('font-size').length).toBeGreaterThan(150);
  });

  it('sends every desktop font-size through the scale', () => {
    const unscaled = declarations('font-size').filter(
      ({ name, selector, value }) =>
        !FOLLOWS_THE_SCALE.test(value) &&
        !UNSCALED_ON_PURPOSE.some(
          (allowed) =>
            allowed.name === name && allowed.selector === selector && allowed.value === value,
        ),
    );
    expect(unscaled).toEqual([]);
  });

  it('keeps rem at 16px, so only text follows the setting', () => {
    expect(rule(':root')).toMatch(/\n {2}font-size: 16px;/u);
    expect(global).not.toMatch(/html\[[^\]]*\] \{[^}]*\n {2}font-size:/u);
  });

  it('never fixes a line height in length units, because a box of text has to grow', () => {
    const fixed = declarations('line-height').filter(({ value }) => /\d(px|rem|em)\b/u.test(value));
    expect(fixed).toEqual([]);
  });

  it('never fixes a font-size in components', () => {
    const components = files(/\.tsx$/u).filter(
      (path) => !/\.test\.tsx$|[\\/]testing[\\/]/u.test(path),
    );
    expect(components.length).toBeGreaterThan(20);
    for (const path of components)
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/fontSize|font-size|<text\b/u);
  });

  it("builds all the size tokens on the scale, at exactly today's sizes", () => {
    const root = rule(':root');
    for (const [token, size] of [
      ['small', 14],
      ['label', 16],
      ['body', 16],
      ['title', 20],
      ['heading', 28],
      ['page-heading', 32],
    ])
      expect(root).toContain(`--text-${token}: calc(${size}px * var(--font-scale));`);
    expect(
      stylesheets.filter(
        ({ css, name }) => name !== 'styles/global.css' && /--text-[a-z-]+:/u.test(css),
      ),
    ).toEqual([]);
  });

  it('has the agreed scale for each size, with 标准 as the default', () => {
    expect(rule(':root')).toContain('--font-scale: 1.125;');
    expect(rule("html[data-text-size='small']")).toContain('--font-scale: 1;');
    expect(rule("html[data-text-size='large']")).toContain('--font-scale: 1.25;');
    expect(rule("html[data-text-size='xlarge']")).toContain('--font-scale: 1.4;');
    expect(TEXT_SIZES.map(({ id }) => id)).toEqual(['small', 'standard', 'large', 'xlarge']);
    expect(global).not.toContain("html[data-text-size='standard']");
  });

  it('keeps the two lines Edge makes necessary on body', () => {
    const body = rule('body');
    expect(body).toContain('font-family: var(--font-ui)');
    expect(body).toContain('font-size: var(--text-body)');
  });

  it('turns text-driven container widths into em, so a wider text collapses sooner', () => {
    const withRem = stylesheets.flatMap(({ name, css }) =>
      [...css.matchAll(/@container [^{]*\{/gu)]
        .map(([query]) => `${name}: ${query}`)
        .filter((query) => /\drem/u.test(query)),
    );
    // Only the wardrobe's rows of pictures, which keep their size.
    expect(withRem.filter((query) => !query.startsWith('dashboard/wardrobe.css'))).toEqual([]);
  });

  it('lets the boxes that hold text grow', () => {
    const shortcut = readFileSync(resolve('src/dashboard/review.css'), 'utf8');
    expect(shortcut).toMatch(/\.rating-shortcut \{[^}]*min-height: 22px/u);
    expect(shortcut).not.toMatch(/\.rating-shortcut \{[^}]*[^-]height: 22px/u);
    expect(rule('.companion-hero')).not.toContain('max-height');
    expect(global).toMatch(
      /\.home-tasks-rail \{\s*contain: size;\s*min-height: calc\(32rem \* var\(--font-scale\)\)/u,
    );
    const feedback = readFileSync(resolve('src/dashboard/task-feedback.css'), 'utf8');
    expect(feedback).toMatch(/\.task-coin-face \{[^}]*width: calc\(34px \* var\(--font-scale\)\)/u);
    expect(feedback).toMatch(/\.task-celebration-seal \{[^}]*width: 1\.8em;\s*height: 1\.8em/u);
  });
});

describe('font choice contract', () => {
  const stacks = {
    wenkai: /--font-stack-wenkai:\s*'LXGW WenKai Screen',/u,
    misans: /--font-stack-misans:\s*'MiSans',/u,
    noto: /--font-stack-noto:\s*'ValRecall Reading',/u,
    yahei: /--font-stack-yahei:\s*'Microsoft YaHei UI', 'Microsoft YaHei',/u,
  } as const;

  it('gives every choice its stack, its attribute and its sample', () => {
    const settings = readFileSync(resolve('src/dashboard/typography-settings.css'), 'utf8');
    expect(FONT_CHOICES.map(({ id }) => id)).toEqual(['wenkai', 'misans', 'noto', 'yahei']);
    for (const { id } of FONT_CHOICES) {
      expect(global).toMatch(stacks[id]);
      expect(settings).toContain(
        `[data-font-sample='${id}'] {\n  font-family: var(--font-stack-${id});`,
      );
      if (id !== 'wenkai')
        expect(rule(`html[data-font='${id}']`)).toContain(`--font-ui: var(--font-stack-${id});`);
    }
    expect(rule(':root')).toContain('--font-ui: var(--font-stack-wenkai);');
  });

  it('defines the font variables once, so no page keeps a stack of its own', () => {
    for (const property of ['--font-display', '--font-numeral', '--font-ui']) {
      const scopes = declarations(property).map(({ selector }) => selector);
      expect(scopes.every((selector) => selector === ':root' || selector.startsWith('html['))).toBe(
        true,
      );
    }
    expect(
      declarations('font-family').filter(({ value }) => !/^var\(--font-/u.test(value)),
    ).toEqual([]);
  });

  it('declares each bundled family on every desktop page', () => {
    expect(global).toContain("@import '../assets/fonts/lxgw/lxgw.css'");
    expect(global).toContain("@import '../assets/fonts/noto-sans-sc.css'");
    expect(global).toContain("@import '../assets/fonts/misans.css'");
  });

  it('never reads MiSans unless it is chosen or its sample is on screen', () => {
    const named = stylesheets.filter(({ css }) => /\bMiSans\b|font-stack-misans/u.test(css));
    expect(named.map(({ name }) => name).sort()).toEqual([
      'dashboard/typography-settings.css',
      'styles/global.css',
    ]);
    expect(rule(':root')).not.toMatch(/--font-ui:[^;]*(MiSans|misans)/u);
    expect(rule(':root')).not.toMatch(/--font-stack-(wenkai|noto|yahei):[^;]*MiSans/u);
    // The settings card appears only on its tab: the panels of other tabs stay hidden.
    const settings = readFileSync(resolve('src/dashboard/SettingsView.tsx'), 'utf8');
    expect(settings).toContain("{category === 'general' && <TypographySettings />}");
  });

  it('keeps synthesis off, and strokes headings only in the font without a bold', () => {
    expect(rule(':root')).toContain('font-synthesis: none');
    expect(rule(':root')).toContain('--heading-stroke: 0.25px;');
    expect(rule(':root')).toContain('--heading-stroke-small: 0.2px;');
    const others = rule("html:is([data-font='misans'], [data-font='noto'], [data-font='yahei'])");
    expect(others).toContain('--heading-stroke: 0px;');
    expect(others).toContain('--heading-stroke-small: 0px;');
    const strokes = declarations('-webkit-text-stroke').map(({ value }) => value);
    expect(strokes.length).toBeGreaterThan(0);
    for (const stroke of strokes)
      expect(stroke).toMatch(/^(0|var\(--heading-stroke(-small)?\) currentColor)$/u);
  });
});

describe('boot order', () => {
  it.each(['src/dashboard/main.tsx', 'src/sidepanel/main.tsx'])(
    '%s reads the choice before its first render',
    (entry) => {
      const source = readFileSync(resolve(entry), 'utf8');
      expect(source).toContain("import { startTypography } from '../ui/typography'");
      expect(source.indexOf('startTypography()')).toBeGreaterThan(-1);
      expect(source.indexOf('startTypography()')).toBeLessThan(source.indexOf('createRoot(root)'));
      expect(source).toMatch(/startTypography\(\)\.then\(\(\) => \{\s*createRoot\(root\)\.render/u);
    },
  );
});

describe('phone', () => {
  it('reaches none of this', () => {
    const mobile = resolve('src/mobile');
    const sources = readdirSync(mobile).filter((name) => !/\.test\./u.test(name));
    expect(sources).toContain('main.tsx');
    for (const name of sources) {
      const source = readFileSync(join(mobile, name), 'utf8');
      expect(source, name).not.toMatch(/typography|global\.css|--font-scale|data-text-size/u);
    }
  });
});
