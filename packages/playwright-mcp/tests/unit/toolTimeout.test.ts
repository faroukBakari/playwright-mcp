import { describe, it, expect } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { BrowserServerBackend } from 'playwright-core/lib/tools/browserServerBackend';
import { toMcpTool } from 'playwright-core/lib/mcp/sdk/tool';
import navigateModule from 'playwright-core/lib/tools/navigate';

const navigateTools: any[] = (navigateModule as any).default ?? navigateModule;

// ---------------------------------------------------------------------------
// Universal tool timeout — dispatch-level enforcement
// ---------------------------------------------------------------------------

describe('BrowserServerBackend.NAVIGATE_TOOLS', () => {
  it('contains all navigation tool names', () => {
    const nav = BrowserServerBackend.NAVIGATE_TOOLS;
    expect(nav.has('browser_navigate')).toBe(true);
    expect(nav.has('browser_navigate_and_wait')).toBe(true);
    expect(nav.has('browser_navigate_back')).toBe(true);
    expect(nav.has('browser_navigate_forward')).toBe(true);
    expect(nav.has('browser_reload')).toBe(true);
  });

  it('does not contain non-navigation tools', () => {
    const nav = BrowserServerBackend.NAVIGATE_TOOLS;
    expect(nav.has('browser_snapshot')).toBe(false);
    expect(nav.has('browser_evaluate')).toBe(false);
    expect(nav.has('browser_click')).toBe(false);
  });
});

describe('_resolveTimeout (via prototype)', () => {
  // Access private method via prototype — bind to a mock with _config
  const resolve = BrowserServerBackend.prototype['_resolveTimeout'];
  const noConfig = {
    _config: {
      timeoutMatrix: {
        budget: { default: 5000, navigate: 15000, runCode: 30000 },
        playwright: { action: 5000, navigation: 60000, expect: 5000 },
        settle: { postActionDelay: 30, navigationLoad: 5000, networkRace: 3000, postSettlement: 10 },
        infrastructure: { bridgeBuffer: 5000, extensionConnect: 5000, extensionCommand: 10000, sessionGrace: 15000 },
      },
    },
  };
  const withConfig = {
    _config: {
      timeoutMatrix: {
        budget: { default: 8000, navigate: 20000, runCode: 45000 },
        playwright: { action: 5000, navigation: 60000, expect: 5000 },
        settle: { postActionDelay: 30, navigationLoad: 5000, networkRace: 3000, postSettlement: 10 },
        infrastructure: { bridgeBuffer: 5000, extensionConnect: 5000, extensionCommand: 10000, sessionGrace: 15000 },
      },
    },
  };

  it('returns explicit override in ms', () => {
    expect(resolve.call(noConfig, 'browser_evaluate', 'action', 5)).toBe(5000);
    expect(resolve.call(noConfig, 'browser_snapshot', 'readOnly', 10)).toBe(10000);
  });

  it('returns 15000 for navigate tools without override', () => {
    expect(resolve.call(noConfig, 'browser_navigate', 'action', undefined)).toBe(15000);
    expect(resolve.call(noConfig, 'browser_navigate_and_wait', 'action', undefined)).toBe(15000);
    expect(resolve.call(noConfig, 'browser_navigate_back', 'action', undefined)).toBe(15000);
  });

  it('returns 30000 for browser_run_code without override', () => {
    expect(resolve.call(noConfig, 'browser_run_code', 'action', undefined)).toBe(30000);
  });

  it('returns type-based default for regular tools', () => {
    expect(resolve.call(noConfig, 'browser_evaluate', 'action', undefined)).toBe(5000);
    expect(resolve.call(noConfig, 'browser_snapshot', 'readOnly', undefined)).toBe(5000);
    expect(resolve.call(noConfig, 'browser_click', 'input', undefined)).toBe(5000);
    expect(resolve.call(noConfig, 'browser_wait_for', 'assertion', undefined)).toBe(5000);
  });

  it('returns 5000 for unknown tool type', () => {
    expect(resolve.call(noConfig, 'unknown_tool', 'unknownType', undefined)).toBe(5000);
  });

  it('explicit override takes precedence over navigate default', () => {
    expect(resolve.call(noConfig, 'browser_navigate', 'action', 30)).toBe(30000);
  });

  it('explicit override takes precedence over run_code default', () => {
    expect(resolve.call(noConfig, 'browser_run_code', 'action', 2)).toBe(2000);
  });

  it('reads navigate timeout from timeoutMatrix.budget', () => {
    expect(resolve.call(withConfig, 'browser_navigate', 'action', undefined)).toBe(20000);
  });

  it('reads runCode timeout from timeoutMatrix.budget', () => {
    expect(resolve.call(withConfig, 'browser_run_code', 'action', undefined)).toBe(45000);
  });

  it('reads default timeout from timeoutMatrix.budget', () => {
    expect(resolve.call(withConfig, 'browser_click', 'input', undefined)).toBe(8000);
  });

  it('explicit override takes precedence over config', () => {
    expect(resolve.call(withConfig, 'browser_navigate', 'action', 5)).toBe(5000);
  });
});

describe('toMcpTool schema injection', () => {
  it('injects timeout into tool inputSchema properties', () => {
    // Use a real tool schema for realistic testing
    const navTool = navigateTools.find((t: any) => t.schema.name === 'browser_navigate');
    const mcpTool = toMcpTool(navTool.schema);
    const props = (mcpTool.inputSchema as any).properties;

    expect(props.timeout).toBeDefined();
    expect(props.timeout.type).toBe('number');
    expect(props.timeout.description).toContain('Timeout in seconds');
  });

  it('preserves existing schema properties', () => {
    const navTool = navigateTools.find((t: any) => t.schema.name === 'browser_navigate');
    const mcpTool = toMcpTool(navTool.schema);
    const props = (mcpTool.inputSchema as any).properties;

    expect(props.url).toBeDefined();
  });
});
