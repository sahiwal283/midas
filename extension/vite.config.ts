import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Builds the extension into dist/ as a flat structure that Chrome/Firefox can load
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        background: resolve(__dirname, 'src/background/service-worker.ts'),
        content: resolve(__dirname, 'src/content/capture.ts'),
      },
      output: {
        entryFileNames: '[name]/[name].js',
        chunkFileNames: 'shared/[name].js',
        assetFileNames: '[name]/[name][extname]',
      },
    },
  },
});
