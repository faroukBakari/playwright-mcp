import { defineConfig } from 'vitest/config';
import { builtinModules } from 'node:module';
import path from 'path';

const pwCore = path.resolve(__dirname, '../../../playwright/packages/playwright-core');

// Map bare Node built-in names to node: prefixed versions
const nodeBuiltinAliases = builtinModules
  .filter(m => !m.startsWith('_'))
  .map(m => ({ find: new RegExp(`^${m}$`), replacement: `node:${m}` }));

export default defineConfig({
  resolve: {
    alias: [
      // Bypass playwright-core's exports field — resolve to TS source
      { find: 'playwright-core/src', replacement: path.resolve(pwCore, 'src') },
      // Ensure Node built-ins resolve correctly in vitest's module evaluator
      ...nodeBuiltinAliases,
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globals: true,
    coverage: {
      include: ['../extension/src/**/*.ts'],
      exclude: ['../extension/src/__tests__/**'],
    },
  },
});
