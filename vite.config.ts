import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  esbuild: {
    drop: ['console', 'debugger'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      // 添加 notesExport.html 为额外的多页入口
      input: {
        notesExport: resolve(__dirname, 'notesExport.html'),
        pdfPreview: resolve(__dirname, 'pdfPreview.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: {
      port: 5173,
    },
  },
});
