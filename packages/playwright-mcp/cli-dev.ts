#!/usr/bin/env tsx
/**
 * Entry point — runs from TypeScript source via tsx.
 * No build step required. Imports from src/ directly.
 *
 * Bundle resolution: src/XBundleImpl symlinks point to bundles/X/src/XBundleImpl.ts
 *
 * Usage: ./server.sh start
 */

// Relative paths bypass playwright-core's exports field.
// The file: dependency symlinks node_modules/playwright-core → the fork directory.
import { program } from '../../../playwright/packages/playwright-core/src/utilsBundle';
import { decorateMCPCommand } from '../../../playwright/packages/playwright-core/src/mcp/program';

const packageJSON = require('./package.json');
const p = program.version('Version ' + packageJSON.version).name('Playwright MCP');
decorateMCPCommand(p, packageJSON.version);
void program.parseAsync(process.argv);
