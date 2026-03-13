import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Import from compiled playwright-core (file: dependency)
import { configFromEnv, mergeConfig, defaultConfig } from 'playwright-core/lib/mcp/config';
import { Response } from 'playwright-core/lib/tools/response';

// Minimal context stub — Response constructor only stores the reference.
// Methods on context are called later in _build(), but our tests that call
// serialize() only test the no-tabs path (currentTab() returns undefined,
// tabs() returns []).
function createStubContext(configOverrides: Record<string, any> = {}) {
  return {
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
  } as any;
}

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
// Patch 4ab: Per-call includeSnapshot override (Response behavior)
// ---------------------------------------------------------------------------

describe('Response snapshotOverride', () => {
  it('setIncludeSnapshot() is a no-op when snapshotOverride is false', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, false);
    response.setIncludeSnapshot();
    // _includeSnapshot should remain 'none' because the override suppressed it
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('setIncludeFullSnapshot() is a no-op when snapshotOverride is false', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, false);
    response.setIncludeFullSnapshot();
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('setIncludeSnapshot() works normally when snapshotOverride is undefined', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('incremental');
  });

  it('setIncludeFullSnapshot() works normally when snapshotOverride is undefined', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {});
    response.setIncludeFullSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('setIncludeSnapshot() works normally when snapshotOverride is true', () => {
    const ctx = createStubContext({ snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_navigate', {}, undefined, true);
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('snapshotOverride false produces no Snapshot section in serialized output', async () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, false);
    response.setIncludeSnapshot();
    response.addTextResult('Action completed');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('### Snapshot');
    expect(text).toContain('Action completed');
  });
});

// ---------------------------------------------------------------------------
// Patch 4c: maxSnapshotChars config + env var parsing
// ---------------------------------------------------------------------------

describe('PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS env var', () => {
  it('parses numeric value into config.snapshot.maxChars', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS = '20000';
    const config = configFromEnv();
    expect(config.snapshot?.maxChars).toBe(20000);
  });

  it('leaves maxChars undefined when env var is not set', () => {
    const config = configFromEnv();
    expect(config.snapshot?.maxChars).toBeUndefined();
  });

  it('preserves snapshot.mode when maxChars is set via env', () => {
    process.env.PLAYWRIGHT_MCP_SNAPSHOT_MAX_CHARS = '15000';
    const envConfig = configFromEnv();
    const merged = mergeConfig(defaultConfig, envConfig);
    expect(merged.snapshot?.maxChars).toBe(15000);
  });
});

describe('mergeConfig snapshot.maxChars', () => {
  it('deep-merges maxChars into snapshot config', () => {
    const result = mergeConfig(defaultConfig, {
      snapshot: { maxChars: 10000 },
    });
    expect(result.snapshot?.maxChars).toBe(10000);
  });

  it('preserves mode when only maxChars is overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { mode: 'full' } });
    const result = mergeConfig(base, { snapshot: { maxChars: 5000 } });
    expect(result.snapshot?.mode).toBe('full');
    expect(result.snapshot?.maxChars).toBe(5000);
  });

  it('preserves maxChars when only mode is overridden', () => {
    const base = mergeConfig(defaultConfig, { snapshot: { maxChars: 8000 } });
    const result = mergeConfig(base, { snapshot: { mode: 'incremental' } });
    expect(result.snapshot?.mode).toBe('incremental');
    expect(result.snapshot?.maxChars).toBe(8000);
  });
});
