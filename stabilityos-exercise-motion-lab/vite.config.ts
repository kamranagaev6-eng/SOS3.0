import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Numerical tests run in Node; browser behaviour is covered separately by Playwright (e2e/).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
