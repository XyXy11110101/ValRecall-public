import { build } from 'vite';
import { extensionOutputDirectory } from './extension-output.mjs';

/**
 * Runs every extension entry-point build. Only the private build mode enables the
 * companion art: the dashboard companion and the background notification icons. The
 * content bundle never receives that flag.
 */
export async function buildExtension({ privateCompanionAssets = false } = {}) {
  const outDir = extensionOutputDirectory();
  const mode = privateCompanionAssets ? 'private' : 'production';
  await build({ configFile: 'vite.config.ts', mode, build: { outDir } });
  await build({ configFile: 'vite.background.config.ts', mode, build: { outDir } });
  await build({ configFile: 'vite.content.config.ts', build: { outDir } });
}
