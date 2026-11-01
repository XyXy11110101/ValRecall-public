import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extensionOutputDirectory } from './extension-output.mjs';

describe('safe staged extension output', () => {
  it('defaults to dist and allows a separate candidate under build', () => {
    expect(extensionOutputDirectory('dist')).toBe('dist');
    expect(extensionOutputDirectory('build/desktop-private')).toBe(
      resolve('build/desktop-private'),
    );
  });
  it('never empties the repo, build root or an arbitrary user path', () => {
    for (const path of ['.', '..', 'build', 'build/../src', 'C:\\elsewhere']) {
      expect(() => extensionOutputDirectory(path)).toThrow('subdirectory');
    }
  });
});
