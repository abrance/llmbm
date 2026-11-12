import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApiPlugin } from './mock/plugin.js';

const API_TARGET = process.env.LLMBM_API ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), mockApiPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
