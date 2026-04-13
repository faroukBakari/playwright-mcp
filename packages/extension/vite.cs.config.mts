/**
 * Vite config for the content script (removeExtensionIframes).
 *
 * Content scripts cannot be ES modules — Chrome MV3 content_scripts
 * don't support type: "module". IIFE wraps the entire script in an
 * immediately-invoked function.
 */

import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/removeExtensionIframes.ts'),
      name: 'removeExtensionIframes',
      fileName: 'lib/removeExtensionIframes',
      formats: ['iife'],
    },
    outDir: 'dist',
    emptyOutDir: false,
    minify: false,
  },
});
