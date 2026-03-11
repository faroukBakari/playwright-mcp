import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { defaultConfig, mergeConfig, configFromEnv } from 'playwright-core/lib/mcp/config';

const PERF_ENV_KEYS = [
  'PLAYWRIGHT_MCP_PERF_POST_ACTION_DELAY',
  'PLAYWRIGHT_MCP_PERF_POST_SETTLEMENT_DELAY',
  'PLAYWRIGHT_MCP_PERF_NETWORK_RACE_TIMEOUT',
  'PLAYWRIGHT_MCP_PERF_NAV_LOAD_STATE',
  'PLAYWRIGHT_MCP_PERF_NAV_LOAD_TIMEOUT',
  'PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_STATE',
  'PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_TIMEOUT',
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

describe('defaultConfig.performance', () => {
  it('has all 11 fields with correct default values', () => {
    expect(defaultConfig.performance).toEqual({
      postActionDelay: 100,
      postSettlementDelay: 10,
      networkRaceTimeout: 3000,
      navigationLoadState: 'domcontentloaded',
      navigationLoadTimeout: 5000,
      postNavigateLoadState: 'domcontentloaded',
      postNavigateLoadTimeout: 3000,
      waitFastPollInterval: 200,
      waitFastPollRetries: 5,
      waitDefaultTimeout: 3000,
      waitMaxTimeout: 30000,
    });
  });
});

describe('mergeConfig performance', () => {
  it('deep-merges partial performance overrides', () => {
    const result = mergeConfig(defaultConfig, {
      performance: { postActionDelay: 200, networkRaceTimeout: 5000 },
    });
    expect(result.performance).toEqual({
      postActionDelay: 200,
      postSettlementDelay: 10,
      networkRaceTimeout: 5000,
      navigationLoadState: 'domcontentloaded',
      navigationLoadTimeout: 5000,
      postNavigateLoadState: 'domcontentloaded',
      postNavigateLoadTimeout: 3000,
      waitFastPollInterval: 200,
      waitFastPollRetries: 5,
      waitDefaultTimeout: 3000,
      waitMaxTimeout: 30000,
    });
  });

  it('preserves all defaults when override performance is empty', () => {
    const result = mergeConfig(defaultConfig, { performance: {} });
    expect(result.performance).toEqual(defaultConfig.performance);
  });
});

describe('configFromEnv performance', () => {
  it('reads PLAYWRIGHT_MCP_PERF_* env vars', () => {
    process.env.PLAYWRIGHT_MCP_PERF_POST_ACTION_DELAY = '250';
    process.env.PLAYWRIGHT_MCP_PERF_NAV_LOAD_STATE = 'load';
    process.env.PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_TIMEOUT = '8000';

    const config = configFromEnv();
    expect(config.performance?.postActionDelay).toBe(250);
    expect(config.performance?.navigationLoadState).toBe('load');
    expect(config.performance?.postNavigateLoadTimeout).toBe(8000);
  });

  it('ignores invalid load state values', () => {
    process.env.PLAYWRIGHT_MCP_PERF_NAV_LOAD_STATE = 'networkidle';
    process.env.PLAYWRIGHT_MCP_PERF_POST_NAV_LOAD_STATE = 'complete';

    const config = configFromEnv();
    // Invalid values are silently ignored — performance object may not exist
    // or may not have the load state fields
    expect(config.performance?.navigationLoadState).toBeUndefined();
    expect(config.performance?.postNavigateLoadState).toBeUndefined();
  });

  it('returns no performance overrides when no perf env vars are set', () => {
    const config = configFromEnv();
    // configFromEnv returns a Config (not FullConfig) — performance is undefined
    // when no perf env vars are set (the overrides object is empty, so it's not applied)
    expect(config.performance).toBeUndefined();
  });
});
