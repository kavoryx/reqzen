import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve('app/renderer'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
