import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@midas/shared': path.resolve(__dirname, '../../packages/shared/src/types/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_URL ?? 'http://localhost:4000', changeOrigin: true },
    },
  },
});
