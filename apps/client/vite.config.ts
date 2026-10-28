import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 构建与测试共用一份配置：vite build 只读取 server/build 段，
// vitest 读取 test 段；net 层纯逻辑单测跑在 node 环境。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    // 真实后端联调：/api 走 HTTP，WS 直连 VITE_WS_URL（见 .env.example）
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
