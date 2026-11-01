import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { isPublicRelease } from './vite.edition';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
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
  define: {
    __VALRECALL_PRIVATE_COMPANION_ASSETS__: JSON.stringify(mode === 'private' || mode === 'test'),
    // Tests read a global instead (src/testing/setup.ts), so a test can switch the edition.
    ...(mode === 'test' ? {} : { __VALRECALL_PUBLIC_RELEASE__: JSON.stringify(isPublicRelease()) }),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    environment: 'jsdom',
    setupFiles: ['./src/testing/setup.ts'],
    coverage: { reporter: ['text', 'html'] },
  },
}));
