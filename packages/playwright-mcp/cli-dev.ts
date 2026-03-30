#!/usr/bin/env tsx
/**
 * Dev-mode entry point — runs from TypeScript source via tsx.
 * No build step required. Imports from src/ instead of lib/.
 *
 * Pre-built bundles (utilsBundleImpl, mcpBundleImpl) must exist in lib/.
 * Run `npm run build` once or `./install.sh` to populate them.
 *
 * Usage: FF_WEB_AUTOMATION_DEV=true ./server.sh start
 */

// Relative paths bypass playwright-core's exports field, which only allows lib/*.
// The file: dependency symlinks node_modules/playwright-core → the fork directory.
import { program } from '../../../playwright/packages/playwright-core/src/utilsBundle';
import { decorateMCPCommand } from '../../../playwright/packages/playwright-core/src/mcp/program';

const packageJSON = require('./package.json');
const p = program.version('Version ' + packageJSON.version).name('Playwright MCP');
decorateMCPCommand(p, packageJSON.version);
void program.parseAsync(process.argv);
