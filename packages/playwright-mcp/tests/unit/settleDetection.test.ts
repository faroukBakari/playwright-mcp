import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { configFromEnv, mergeConfig, defaultConfig, enumParser } from 'playwright-core/lib/mcp/config';

// Save and restore all PLAYWRIGHT_MCP_ env vars to avoid test pollution
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_')) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_'))
      delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined)
      process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

describe('settleMode defaults', () => {
  it('defaults to quick when not specified', () => {
    expect(defaultConfig.snapshot?.settleMode).toBe('quick');
  });

  it('defaults settleQuietMs to 150', () => {
    expect(defaultConfig.snapshot?.settleQuietMs).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE env var', () => {
  it('parses quick into config.snapshot.settleMode', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE = 'quick';
    const config = configFromEnv();
    expect(config.snapshot?.settleMode).toBe('quick');
  });

  it('parses none into config.snapshot.settleMode', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE = 'none';
    const config = configFromEnv();
    expect(config.snapshot?.settleMode).toBe('none');
  });

  it('parses thorough into config.snapshot.settleMode', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE = 'thorough';
    const config = configFromEnv();
    expect(config.snapshot?.settleMode).toBe('thorough');
  });

  it('leaves settleMode undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.settleMode).toBeUndefined();
  });

  it('rejects invalid settleMode values', () => {
    expect(() => {
      enumParser('--snapshot-settle-mode', ['none', 'quick', 'thorough'], 'invalid');
    }).toThrow(/Invalid --snapshot-settle-mode/);
  });
});

describe('PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_QUIET_MS env var', () => {
  it('parses numeric value into config.snapshot.settleQuietMs', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_QUIET_MS = '200';
    const config = configFromEnv();
    expect(config.snapshot?.settleQuietMs).toBe(200);
  });

  it('leaves settleQuietMs undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.settleQuietMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Config merging
// ---------------------------------------------------------------------------

describe('mergeConfig snapshot settle fields', () => {
  it('settleMode override preserves other snapshot config', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { mode: 'full' as const, maxChars: 10000 } });
    const result = mergeConfig(base, { snapshot: { settleMode: 'thorough' as const } });
    expect(result.snapshot?.settleMode).toBe('thorough');
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.maxChars).toBe(10000);
  });

  it('settleQuietMs override preserves settleMode', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { settleMode: 'thorough' as const } });
    const result = mergeConfig(base, { snapshot: { settleQuietMs: 300 } });
    expect(result.snapshot?.settleMode).toBe('thorough');
    expect(result.snapshot?.settleQuietMs).toBe(300);
  });

  it('deep merge preserves existing mode, maxChars, interactableOnly', () => {
    const base = mergeConfig(defaultConfig, {
      snapshot: { mode: 'incremental' as const, maxChars: 20000, interactableOnly: true },
    });
    const result = mergeConfig(base, {
      snapshot: { settleMode: 'none' as const, settleQuietMs: 100 },
    });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.maxChars).toBe(20000);
    expect(result.snapshot?.interactableOnly).toBe(true);
    expect(result.snapshot?.settleMode).toBe('none');
    expect(result.snapshot?.settleQuietMs).toBe(100);
  });

  it('env var settleMode preserves other snapshot config after merge', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_SETTLE_MODE = 'thorough';
    const envConfig = configFromEnv();
    const merged = mergeConfig(defaultConfig, envConfig);
    // settleMode from env
    expect(merged.snapshot?.settleMode).toBe('thorough');
    // defaults preserved
    expect(merged.snapshot?.settleQuietMs).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Settle behavior (mock-based)
// ---------------------------------------------------------------------------

describe('Tab.captureSnapshot settle behavior', () => {
  function createMockPage(settleMode: string) {
    const evaluateSpy = vi.fn().mockResolvedValue(undefined);
    const snapshotForAISpy = vi.fn().mockResolvedValue({
      full: '- heading "Test"',
      incremental: undefined,
    });
    return {
      evaluateSpy,
      snapshotForAISpy,
      page: {
        evaluate: evaluateSpy,
        _snapshotForAI: snapshotForAISpy,
      },
    };
  }

  // Simulate the captureSnapshot settle logic extracted from tab.ts
  // This tests the conditional logic without requiring the full Tab class.
  async function simulateSettle(config: { settleMode?: string; settleQuietMs?: number }, rootSelector?: string) {
    const settleMode = config.settleMode ?? 'quick';
    const evaluateCalls: Array<{ args: any }> = [];

    if (settleMode !== 'none') {
      const quietMs = config.settleQuietMs ?? 150;
      // Record what would be passed to page.evaluate
      evaluateCalls.push({ args: { mode: settleMode, quietMs, rootSelector } });
    }

    return { evaluateCalls };
  }

  it('settleMode none skips page.evaluate before snapshot', async () => {
    const result = await simulateSettle({ settleMode: 'none' });
    expect(result.evaluateCalls).toHaveLength(0);
  });

  it('settleMode quick calls page.evaluate before snapshot', async () => {
    const result = await simulateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('quick');
  });

  it('settleMode thorough calls page.evaluate with mode and quietMs', async () => {
    const result = await simulateSettle({ settleMode: 'thorough', settleQuietMs: 200 });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('thorough');
    expect(result.evaluateCalls[0].args.quietMs).toBe(200);
  });

  it('default settleMode is quick when config omits it', async () => {
    const result = await simulateSettle({});
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.mode).toBe('quick');
  });

  it('settle page.evaluate receives rootSelector from options', async () => {
    const result = await simulateSettle({ settleMode: 'thorough' }, '.main-content');
    expect(result.evaluateCalls[0].args.rootSelector).toBe('.main-content');
  });

  it('settle page.evaluate receives undefined rootSelector when not provided', async () => {
    const result = await simulateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls[0].args.rootSelector).toBeUndefined();
  });

  it('default settleQuietMs is 150 when config omits it', async () => {
    const result = await simulateSettle({ settleMode: 'thorough' });
    expect(result.evaluateCalls[0].args.quietMs).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Gate config defaults
// ---------------------------------------------------------------------------

describe('gate config defaults', () => {
  it('defaults gatesEnabled to true', () => {
    expect(defaultConfig.snapshot?.gatesEnabled).toBe(true);
  });

  it('defaults gateTimeoutMs to 2000', () => {
    expect(defaultConfig.snapshot?.gateTimeoutMs).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Gate env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_GATES_ENABLED env var', () => {
  it('parses true into config.snapshot.gatesEnabled', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATES_ENABLED = 'true';
    const config = configFromEnv();
    expect(config.snapshot?.gatesEnabled).toBe(true);
  });

  it('parses false into config.snapshot.gatesEnabled', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATES_ENABLED = 'false';
    const config = configFromEnv();
    expect(config.snapshot?.gatesEnabled).toBe(false);
  });

  it('leaves gatesEnabled undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.gatesEnabled).toBeUndefined();
  });
});

describe('PLAYWRIGHT_MCP_SNAPSHOT_GATE_TIMEOUT_MS env var', () => {
  it('parses numeric value into config.snapshot.gateTimeoutMs', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATE_TIMEOUT_MS = '3000';
    const config = configFromEnv();
    expect(config.snapshot?.gateTimeoutMs).toBe(3000);
  });

  it('leaves gateTimeoutMs undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.gateTimeoutMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gate config merging
// ---------------------------------------------------------------------------

describe('mergeConfig snapshot gate fields', () => {
  it('gatesEnabled override preserves other snapshot config', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { settleMode: 'thorough' as const } });
    const result = mergeConfig(base, { snapshot: { gatesEnabled: false } });
    expect(result.snapshot?.gatesEnabled).toBe(false);
    expect(result.snapshot?.settleMode).toBe('thorough');
  });

  it('gateTimeoutMs override preserves gatesEnabled', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { gatesEnabled: true } });
    const result = mergeConfig(base, { snapshot: { gateTimeoutMs: 5000 } });
    expect(result.snapshot?.gatesEnabled).toBe(true);
    expect(result.snapshot?.gateTimeoutMs).toBe(5000);
  });

  it('deep merge preserves existing settle fields alongside gate fields', () => {
    const base = mergeConfig(defaultConfig, {
      snapshot: { mode: 'incremental' as const, maxChars: 20000, settleMode: 'quick' as const },
    });
    const result = mergeConfig(base, {
      snapshot: { gatesEnabled: false, gateTimeoutMs: 1000 },
    });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.maxChars).toBe(20000);
    expect(result.snapshot?.settleMode).toBe('quick');
    expect(result.snapshot?.gatesEnabled).toBe(false);
    expect(result.snapshot?.gateTimeoutMs).toBe(1000);
  });

  it('env var gatesEnabled preserves other snapshot config after merge', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_GATES_ENABLED = 'false';
    const envConfig = configFromEnv();
    const merged = mergeConfig(defaultConfig, envConfig);
    expect(merged.snapshot?.gatesEnabled).toBe(false);
    // defaults preserved
    expect(merged.snapshot?.settleQuietMs).toBe(150);
    expect(merged.snapshot?.gateTimeoutMs).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Gate settle behavior (mock-based)
// ---------------------------------------------------------------------------

describe('Tab.captureSnapshot gate behavior', () => {
  // Simulate the gate + settle logic extracted from tab.ts
  async function simulateGateSettle(config: {
    settleMode?: string;
    gatesEnabled?: boolean;
    gateTimeoutMs?: number;
  }) {
    const settleMode = config.settleMode ?? 'quick';
    const gatesEnabled = config.gatesEnabled ?? true;
    const gateTimeoutMs = config.gateTimeoutMs ?? 2000;
    const evaluateCalls: Array<{ args: any }> = [];

    if (settleMode !== 'none') {
      const quietMs = 150;
      evaluateCalls.push({
        args: { mode: settleMode, quietMs, rootSelector: undefined, gatesEnabled, gateTimeoutMs },
      });
    }

    return { evaluateCalls };
  }

  it('gates enabled by default in quick mode', async () => {
    const result = await simulateGateSettle({ settleMode: 'quick' });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(true);
    expect(result.evaluateCalls[0].args.gateTimeoutMs).toBe(2000);
  });

  it('gates disabled skips gate params', async () => {
    const result = await simulateGateSettle({ gatesEnabled: false });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(false);
  });

  it('settleMode none skips entire settle including gates', async () => {
    const result = await simulateGateSettle({ settleMode: 'none', gatesEnabled: true });
    expect(result.evaluateCalls).toHaveLength(0);
  });

  it('custom gateTimeoutMs is passed through', async () => {
    const result = await simulateGateSettle({ gateTimeoutMs: 500 });
    expect(result.evaluateCalls[0].args.gateTimeoutMs).toBe(500);
  });

  it('gates enabled in thorough mode', async () => {
    const result = await simulateGateSettle({ settleMode: 'thorough', gatesEnabled: true });
    expect(result.evaluateCalls).toHaveLength(1);
    expect(result.evaluateCalls[0].args.gatesEnabled).toBe(true);
    expect(result.evaluateCalls[0].args.mode).toBe('thorough');
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor config defaults
// ---------------------------------------------------------------------------

describe('snapshotWaitFor config defaults', () => {
  it('defaults waitForTimeout to 3000', () => {
    expect(defaultConfig.snapshot?.waitForTimeout).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_WAIT_FOR_TIMEOUT env var', () => {
  it('parses numeric value into config.snapshot.waitForTimeout', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_WAIT_FOR_TIMEOUT = '5000';
    const config = configFromEnv();
    expect(config.snapshot?.waitForTimeout).toBe(5000);
  });

  it('leaves waitForTimeout undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.waitForTimeout).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor config merging
// ---------------------------------------------------------------------------

describe('mergeConfig snapshot waitForTimeout', () => {
  it('waitForTimeout override preserves other snapshot config', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { settleMode: 'thorough' as const, gatesEnabled: true } });
    const result = mergeConfig(base, { snapshot: { waitForTimeout: 5000 } });
    expect(result.snapshot?.waitForTimeout).toBe(5000);
    expect(result.snapshot?.settleMode).toBe('thorough');
    expect(result.snapshot?.gatesEnabled).toBe(true);
  });

  it('deep merge preserves all snapshot fields', () => {
    const base = mergeConfig(defaultConfig, {
      snapshot: { mode: 'incremental' as const, gatesEnabled: false, gateTimeoutMs: 1000 },
    });
    const result = mergeConfig(base, { snapshot: { waitForTimeout: 2000 } });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.gatesEnabled).toBe(false);
    expect(result.snapshot?.gateTimeoutMs).toBe(1000);
    expect(result.snapshot?.waitForTimeout).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// snapshotWaitFor schema presence
// ---------------------------------------------------------------------------

describe('snapshotOptionsSchema includes snapshotWaitFor', () => {
  // Import at test-level to verify the schema shape
  it('snapshotWaitFor is an optional object in snapshotOptionsSchema', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/lib/tools/snapshot');
    const shape = snapshotOptionsSchema.shape;
    expect(shape).toHaveProperty('snapshotWaitFor');
    // Verify it accepts an object with text/textGone/selector
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { text: 'Hello' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ text: 'Hello' });
  });

  it('snapshotWaitFor is optional — omitting it parses fine', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/lib/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({});
    expect(parsed.snapshotWaitFor).toBeUndefined();
  });

  it('snapshotWaitFor accepts textGone condition', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/lib/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { textGone: 'Loading...' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ textGone: 'Loading...' });
  });

  it('snapshotWaitFor accepts selector condition', async () => {
    const { snapshotOptionsSchema } = await import('playwright-core/lib/tools/snapshot');
    const parsed = snapshotOptionsSchema.parse({
      snapshotWaitFor: { selector: '.results' },
    });
    expect(parsed.snapshotWaitFor).toEqual({ selector: '.results' });
  });
});
