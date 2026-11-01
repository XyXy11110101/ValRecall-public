import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'ValRecallContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
