import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import provenance from '../assets/fonts/provenance.json';

const css = readFileSync(resolve('src/dashboard/review.css'), 'utf8');

describe('Review reading accessibility and offline font integrity', () => {
  it('keeps body, secondary, action and success text above 4.5:1', () => {
    const luminance = (hex: string) =>
      (hex.slice(1).match(/../g) ?? []).reduce((sum, channel, index) => {
        const value = parseInt(channel, 16) / 255;
        return (
          sum +
          (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
            [0.2126, 0.7152, 0.0722][index]!
        );
      }, 0);
    const color = (token: string) => css.match(new RegExp(`--${token}: (#[0-9a-f]{6})`))![1]!;
    for (const [a, b] of [
      ['ink', 'paper'],
      ['muted', 'canvas'],
      ['paper', 'accent'],
      ['success', 'canvas'],
    ]) {
      const [light, dark] = [luminance(color(a!)), luminance(color(b!))].sort((x, y) => y - x);
      expect((light! + 0.05) / (dark! + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('ships the licensed, byte-matched local font ranges without remote CSS requests', () => {
    const fontCss = readFileSync(resolve('src/assets/fonts/noto-sans-sc.css'), 'utf8');
    expect(fontCss).not.toMatch(/https?:|local\(/);
    expect(readFileSync(resolve('public/fonts/OFL.txt'), 'utf8')).toContain(
      'SIL OPEN FONT LICENSE',
    );
    for (const file of provenance.files) {
      const bytes = readFileSync(resolve('src/assets/fonts', file.file));
      expect(bytes.subarray(0, 4).toString()).toBe('wOF2');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      expect(fontCss).toContain(file.file);
    }
  });

  it('keeps Review on the chosen font and size, with nothing of its own to go stale', () => {
    expect(css).not.toMatch(/--font-(ui|display|numeral):/u);
    expect(css).not.toMatch(/--text-[a-z-]+:/u);
    expect(css).toContain('font-family: var(--font-ui)');
    expect(css).not.toMatch(/misans/iu);
    // Every desktop page has the reading font, because it is one of the choices.
    expect(readFileSync(resolve('src/styles/global.css'), 'utf8')).toContain(
      "@import '../assets/fonts/noto-sans-sc.css'",
    );
  });

  it('suppresses pressed and selected button offsets for both reduced-motion paths without moving portraits', () => {
    const controls = [
      '.button.primary-action:active:not(:disabled)',
      '.rating-grid .button:active:not(:disabled)',
      '.rating-grid .button.is-selected',
    ];
    const manual = css.slice(
      css.indexOf(".review-view[data-reduced-motion='true'] .button.primary-action"),
    );
    const media = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const control of controls) {
      expect(manual).toContain(`.review-view[data-reduced-motion='true'] ${control}`);
      expect(media).toContain(`.review-view ${control}`);
    }
    expect(manual.split('}')[0]).toContain('transform: none');
    expect(media.match(/\.review-view \.button\.primary-action[^}]+/s)?.[0]).toContain(
      'transform: none',
    );
    expect(manual).not.toMatch(/\.companion[^{}]*\{[^}]*transform:/s);
    // The narrow avatar keeps its head crop through offsets, so motion suppression cannot move it.
    expect(css).toMatch(
      /.review-companion-viewport .companion-stack-image {[^}]*left: -40%;[^}]*top: -11%;/s,
    );
    const broadSuppression = css.match(
      /\.review-view\[data-reduced-motion='true'\] \*[^{]*\{([^}]*)\}/s,
    )?.[1];
    expect(broadSuppression).not.toContain('transform');
  });
});
