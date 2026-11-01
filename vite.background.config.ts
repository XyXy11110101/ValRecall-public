import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { isPublicRelease } from './vite.edition';

export default defineConfig(({ mode }) => ({
  // Only the private build may point notifications at the private companion icons.
  define: {
    __VALRECALL_PRIVATE_COMPANION_ASSETS__: JSON.stringify(mode === 'private'),
    __VALRECALL_PUBLIC_RELEASE__: JSON.stringify(isPublicRelease()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/background/index.ts'),
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
}));
