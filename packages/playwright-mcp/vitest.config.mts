import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Bypass playwright-core's exports field to reach internal modules
      'playwright-core/lib': path.resolve(__dirname, '../../../playwright/packages/playwright-core/lib'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
  },
});
