import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { defaultConfig, mergeConfig, configFromEnv } from 'playwright-core/lib/mcp/config';

const WAIT_ENV_KEYS = [
  'PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_INTERVAL',
  'PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_RETRIES',
  'PLAYWRIGHT_MCP_PERF_WAIT_DEFAULT_TIMEOUT',
  'PLAYWRIGHT_MCP_PERF_WAIT_MAX_TIMEOUT',
];

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
  // Clean up any env vars set by tests
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('PLAYWRIGHT_MCP_'))
      delete process.env[key];
  }
  // Restore original env
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined)
      process.env[key] = value;
  }
});

describe('defaultConfig.performance wait knobs', () => {
  it('has correct default values for all 4 wait fields', () => {
    expect(defaultConfig.performance.waitFastPollInterval).toBe(200);
    expect(defaultConfig.performance.waitFastPollRetries).toBe(5);
    expect(defaultConfig.performance.waitDefaultTimeout).toBe(3000);
    expect(defaultConfig.performance.waitMaxTimeout).toBe(30000);
  });

  it('coexists with existing performance defaults', () => {
    // Ensure adding wait fields didn't break existing ones
    expect(defaultConfig.performance.postActionDelay).toBe(100);
    expect(defaultConfig.performance.postSettlementDelay).toBe(10);
    expect(defaultConfig.performance.networkRaceTimeout).toBe(3000);
  });
});

describe('mergeConfig wait knobs', () => {
  it('deep-merges partial wait overrides', () => {
    const result = mergeConfig(defaultConfig, {
      performance: { waitDefaultTimeout: 5000, waitMaxTimeout: 15000 },
    });
    expect(result.performance.waitDefaultTimeout).toBe(5000);
    expect(result.performance.waitMaxTimeout).toBe(15000);
    // Unchanged wait fields preserved
    expect(result.performance.waitFastPollInterval).toBe(200);
    expect(result.performance.waitFastPollRetries).toBe(5);
  });

  it('preserves wait defaults when override is empty', () => {
    const result = mergeConfig(defaultConfig, { performance: {} });
    expect(result.performance.waitFastPollInterval).toBe(200);
    expect(result.performance.waitFastPollRetries).toBe(5);
    expect(result.performance.waitDefaultTimeout).toBe(3000);
    expect(result.performance.waitMaxTimeout).toBe(30000);
  });

  it('preserves existing perf fields when only wait fields change', () => {
    const result = mergeConfig(defaultConfig, {
      performance: { waitFastPollInterval: 100 },
    });
    expect(result.performance.postActionDelay).toBe(100);
    expect(result.performance.networkRaceTimeout).toBe(3000);
    expect(result.performance.waitFastPollInterval).toBe(100);
  });
});

describe('configFromEnv wait knobs', () => {
  it('reads PLAYWRIGHT_MCP_PERF_WAIT_* env vars', () => {
    process.env.PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_INTERVAL = '100';
    process.env.PLAYWRIGHT_MCP_PERF_WAIT_FAST_POLL_RETRIES = '10';
    process.env.PLAYWRIGHT_MCP_PERF_WAIT_DEFAULT_TIMEOUT = '5000';
    process.env.PLAYWRIGHT_MCP_PERF_WAIT_MAX_TIMEOUT = '15000';

    const config = configFromEnv();
    expect(config.performance?.waitFastPollInterval).toBe(100);
    expect(config.performance?.waitFastPollRetries).toBe(10);
    expect(config.performance?.waitDefaultTimeout).toBe(5000);
    expect(config.performance?.waitMaxTimeout).toBe(15000);
  });

  it('reads individual wait env vars without affecting others', () => {
    process.env.PLAYWRIGHT_MCP_PERF_WAIT_DEFAULT_TIMEOUT = '8000';

    const config = configFromEnv();
    expect(config.performance?.waitDefaultTimeout).toBe(8000);
    // Other wait fields not set — should be undefined in the override
    expect(config.performance?.waitFastPollInterval).toBeUndefined();
    expect(config.performance?.waitMaxTimeout).toBeUndefined();
  });

  it('returns no performance overrides when no perf env vars are set', () => {
    const config = configFromEnv();
    expect(config.performance).toBeUndefined();
  });
});
