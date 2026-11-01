import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Staged builds keep the installed extension unchanged until its data is backed up. */
export function extensionOutputDirectory(value = process.env.VALRECALL_BUILD_OUT_DIR) {
  if (!value || value === 'dist') return 'dist';
  const target = resolve(value);
  const withinBuild = relative(resolve('build'), target);
  if (
    !withinBuild ||
    withinBuild === '..' ||
    withinBuild.startsWith(`..${sep}`) ||
    isAbsolute(withinBuild)
  ) {
    throw new Error('A staged extension output must be a subdirectory of build/.');
  }
  return target;
}
