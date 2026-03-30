import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve through TypeScript source, not compiled lib/ — tsx handles .ts natively
      'playwright-core/lib': path.resolve(__dirname, '../../../playwright/packages/playwright-core/src'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
});
