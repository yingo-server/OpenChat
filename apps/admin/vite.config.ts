import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// 管理后台独立部署在 /admin/ 下；开发期用 VITE_API_BASE 指向本地 chatd。
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API ?? 'http://127.0.0.1:7780',
        changeOrigin: true,
      },
      '/metrics': {
        target: process.env.VITE_DEV_API ?? 'http://127.0.0.1:7780',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
