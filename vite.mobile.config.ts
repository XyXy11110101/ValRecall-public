import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { isPublicRelease } from './vite.edition';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    {
      name: 'offline-font-license',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'fonts/OFL.txt',
          source: readFileSync(resolve(__dirname, 'src/assets/fonts/OFL.txt'), 'utf8'),
        });
        // The public tree carries no MiSans, so it has no MiSans licence to ship either.
        if (isPublicRelease()) return;
        for (const name of ['MiSans-LICENSE.pdf', 'MiSans-SOURCE.json']) {
          this.emitFile({
            type: 'asset',
            fileName: `fonts/${name}`,
            source: readFileSync(resolve(__dirname, 'public/fonts', name)),
          });
        }
      },
    },
  ],
  server: {
    watch: {
      ignored: [
        '**/native/**/bin/**',
        '**/native/**/obj/**',
        '**/native/**/build/**',
        '**/native/**/.gradle/**',
      ],
    },
  },
  base: './',
  publicDir: false,
  // Only the private mode (build-mobile.mjs --private) turns the phone companion art on.
  // The art is not in this repository.
  define: {
    __VALRECALL_PRIVATE_COMPANION_ASSETS__: JSON.stringify(mode === 'private'),
    __VALRECALL_PUBLIC_RELEASE__: JSON.stringify(isPublicRelease()),
  },
  build: {
    outDir: 'build/mobile-web',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: resolve(__dirname, 'mobile.html') },
  },
}));
