// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve('src/mobile/mobile.css'), 'utf8');
const desktop = readFileSync(resolve('src/styles/global.css'), 'utf8');
const entry = readFileSync(resolve('src/mobile/main.tsx'), 'utf8');
const app = readFileSync(resolve('src/mobile/MobileApp.tsx'), 'utf8');
const companion = readFileSync(resolve('src/mobile/MobileCompanion.tsx'), 'utf8');
function declaration(source: string, name: string): string | undefined {
  return source.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'u'))?.[1];
}

describe('mobile shared visual language', () => {
  it('loads bundled MiSans with the existing Chinese fallback and displays attribution', () => {
    expect(entry).toContain("import '../assets/fonts/misans.css'");
    expect(entry).toContain("import '../assets/fonts/noto-sans-sc.css'");
    expect(css).toMatch(/--font-ui:\s*'MiSans',\s*'ValRecall Reading'/u);
    expect(css).toContain('font-family: var(--font-ui)');
    expect(css).not.toMatch(/https?:\/\//u);
    expect(app).toContain('本产品使用 MiSans 字体，由小米提供。');
  });
  it('uses the same text, action, status and surface colours as the desktop', () => {
    for (const [mobile, shared] of [
      ['mobile-text', 'ink'],
      ['mobile-muted', 'muted'],
      ['mobile-line', 'line'],
      ['mobile-ink', 'accent'],
      ['mobile-ink-pressed', 'accent-hover'],
      ['mobile-accent-soft', 'accent-soft'],
      ['mobile-canvas', 'canvas'],
      ['mobile-success', 'success'],
      ['mobile-danger', 'danger'],
    ]) {
      const colour = declaration(css, mobile!);
      expect(colour, mobile).toMatch(/^#[0-9a-f]{6}$/u);
      expect(colour, mobile).toBe(declaration(desktop, shared!));
    }
  });
  it('keeps 44px ordinary touch targets and enlarges only primary creation and save controls', () => {
    expect(css).toMatch(/button\s*\{[^}]*min-height: 44px/su);
    expect(css).toMatch(/\.mobile-add-button,\s*\.mobile-save-button\s*\{[^}]*min-height: 48px/su);
    expect(css).toContain('transform: translateY(2px)');
    expect(css).not.toMatch(/^button\s*\{[^}]*min-height: 56px/msu);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*button:not\(:disabled\):active\s*\{\s*transform: none/u,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mobile-save-button:not\(:disabled\):active\s*\{\s*transform: none/u,
    );
    expect(css).toContain('transition: none !important');
  });
  it('keeps the private companion small, gated, still under reduced motion and loop-free', () => {
    // Every use sits behind the build flag, so the public phone build drops the module.
    expect(app).toMatch(/\{__VALRECALL_PRIVATE_COMPANION_ASSETS__ && \(\s*<MobileCompanion\b/u);
    expect(app).toMatch(
      /if \(__VALRECALL_PRIVATE_COMPANION_ASSETS__ && alive\.current\)\s*setCompanionCompletion/u,
    );
    expect(app.match(/<MobileCompanion\b/gu)).toHaveLength(1);
    expect(companion).toContain('useReducedMotion()');
    expect(companion).not.toMatch(/Math\.random|chrome\.storage|localStorage/u);
    // Motion lives in the .anim.svg files: no CSS loops anywhere on the phone.
    expect(css).not.toMatch(/@keyframes|infinite/u);
    expect(css).toMatch(/\.mobile-companion-head\s*\{[^}]*width: 48px;[^}]*height: 48px;/su);
    expect(css).toMatch(
      /\.mobile-companion-cheer\s*\{[^}]*position: fixed;[^}]*pointer-events: none;/su,
    );
    // It stands above the floating line (bottom + 84px, about 42px tall).
    expect(css).toMatch(
      /\.mobile-companion-cheer\s*\{[^}]*bottom: calc\(max\(12px, env\(safe-area-inset-bottom\)\) \+ 134px\)/su,
    );
    expect(css).toMatch(
      /\.mobile-celebration-status\s*\{[^}]*bottom: calc\(max\(12px, env\(safe-area-inset-bottom\)\) \+ 84px\)/su,
    );
    expect(css).toMatch(/\.mobile-companion-cheer\.is-visible\s*\{[^}]*transition:/su);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mobile-companion-cheer\.is-visible\s*\{[^}]*transition: none/u,
    );
  });
});
