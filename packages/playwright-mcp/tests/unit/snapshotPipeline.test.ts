import { describe, it, expect, vi } from 'vitest';

import { Response } from 'playwright-core/lib/tools/response';

// Minimal context stub with id for clientId derivation
function createStubContext(configOverrides: Record<string, any> = {}) {
  return {
    id: 'test-client-42',
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
  } as any;
}

function createMockTab() {
  return {
    captureSnapshot: vi.fn().mockResolvedValue({
      ariaSnapshot: '- heading "Hello"',
      ariaSnapshotDiff: '- heading "Hello" [changed]',
      modalStates: [],
      events: [],
    }),
    headerSnapshot: vi.fn().mockResolvedValue({
      title: 'Test', url: 'https://example.com', current: true,
      console: { total: 0, warnings: 0, errors: 0 }, changed: false,
    }),
  };
}

function createContextWithTab(mockTab: ReturnType<typeof createMockTab>, configOverrides: Record<string, any> = {}) {
  return {
    id: 'test-client-42',
    config: { ...configOverrides },
    options: { cwd: '/tmp' },
    currentTab: () => mockTab,
    currentTabOrDie: () => mockTab,
    tabs: () => [mockTab],
  } as any;
}

// ---------------------------------------------------------------------------
// A. Mode resolution
// ---------------------------------------------------------------------------

describe('setIncludeSnapshot mode resolution', () => {
  it('no args resolves config incremental to diff', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('explicit full overrides config', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('full');
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('explicit diff overrides config', () => {
    const ctx = createStubContext({ snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('diff');
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('explicit none sets none', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('none');
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('no args with config mode none resolves to none', () => {
    const ctx = createStubContext({ snapshot: { mode: 'none' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('no args with config mode full resolves to full', () => {
    const ctx = createStubContext({ snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('full with fileName sets _includeSnapshotFileName', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {});
    response.setIncludeSnapshot('full', undefined, 'snap.yml');
    expect((response as any)._includeSnapshot).toBe('full');
    expect((response as any)._includeSnapshotFileName).toBe('snap.yml');
  });
});

// ---------------------------------------------------------------------------
// B. snapshotMode suppression hierarchy
// ---------------------------------------------------------------------------

describe('snapshotMode suppression hierarchy', () => {
  it('snapshotMode none suppresses explicit full', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot('full');
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('snapshotMode none suppresses no-arg call', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('no snapshotMode allows explicit diff', () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('diff');
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('no snapshotMode uses tool mode from config', () => {
    const ctx = createStubContext({ snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// C. clientId scoping
// ---------------------------------------------------------------------------

describe('clientId scoping', () => {
  it('passes clientId to captureSnapshot options', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot();
    response.addTextResult('Clicked');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledWith('/tmp', {
      rootSelector: undefined,
      clientId: 'test-client-42',
    });
  });

  it('clientId matches context.id', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab);
    ctx.id = 'custom-session-99';
    const response = new Response(ctx, 'browser_snapshot', {});
    response.setIncludeSnapshot('full');
    await response.serialize();
    const callArgs = tab.captureSnapshot.mock.calls[0];
    expect(callArgs[1].clientId).toBe('custom-session-99');
  });

  it('selector flows through to captureSnapshot', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, '.main');
    response.setIncludeSnapshot('diff');
    response.addTextResult('Clicked');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledWith('/tmp', {
      rootSelector: '.main',
      clientId: 'test-client-42',
    });
  });
});

// ---------------------------------------------------------------------------
// D. Selector × mode combinations
// ---------------------------------------------------------------------------

describe('selector × mode combinations', () => {
  it('full + selector calls captureSnapshot with rootSelector', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('full', '.main');
    response.addTextResult('Done');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledOnce();
    expect(tab.captureSnapshot).toHaveBeenCalledWith('/tmp', {
      rootSelector: '.main',
      clientId: 'test-client-42',
    });
  });

  it('diff + selector calls captureSnapshot with rootSelector', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab, { snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('diff', '.sidebar');
    response.addTextResult('Done');
    await response.serialize();
    expect(tab.captureSnapshot).toHaveBeenCalledWith('/tmp', {
      rootSelector: '.sidebar',
      clientId: 'test-client-42',
    });
  });

  it('none + selector does NOT call captureSnapshot', async () => {
    const tab = createMockTab();
    const ctx = createContextWithTab(tab);
    const response = new Response(ctx, 'browser_click', {});
    response.setIncludeSnapshot('none', '.main');
    response.addTextResult('Done');
    await response.serialize();
    expect(tab.captureSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// E. MCP param snapshotMode (6th constructor arg)
// ---------------------------------------------------------------------------

describe('MCP param snapshotMode', () => {
  it('snapshotMode full overrides config incremental', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'full');
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('full');
  });

  it('snapshotMode diff overrides config full', () => {
    const ctx = createStubContext({ snapshot: { mode: 'full' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'diff');
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('diff');
  });

  it('snapshotMode none suppresses snapshot', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_click', {}, undefined, undefined, 'none');
    response.setIncludeSnapshot();
    expect((response as any)._includeSnapshot).toBe('none');
  });

  it('handler explicit mode overrides snapshotMode', () => {
    const ctx = createStubContext({ snapshot: { mode: 'incremental' } });
    const response = new Response(ctx, 'browser_snapshot', {}, undefined, undefined, 'diff');
    response.setIncludeSnapshot('full');
    expect((response as any)._includeSnapshot).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// F. Schema validation (snapshotOptionsSchema shape — pure enum)
// ---------------------------------------------------------------------------

import { z } from 'zod';

// Reproduce the schema shape — pure enum, no booleans
const snapshotOptionsSchema = z.object({
  includeSnapshot: z.enum(['none', 'diff', 'full']).optional(),
  snapshotSelector: z.string().optional(),
});

describe('snapshotOptionsSchema validation', () => {
  it('parses includeSnapshot: "diff"', () => {
    const result = snapshotOptionsSchema.parse({ includeSnapshot: 'diff' });
    expect(result.includeSnapshot).toBe('diff');
  });

  it('parses includeSnapshot: "full"', () => {
    const result = snapshotOptionsSchema.parse({ includeSnapshot: 'full' });
    expect(result.includeSnapshot).toBe('full');
  });

  it('parses includeSnapshot: "none"', () => {
    const result = snapshotOptionsSchema.parse({ includeSnapshot: 'none' });
    expect(result.includeSnapshot).toBe('none');
  });

  it('rejects includeSnapshot: false (boolean not accepted)', () => {
    expect(() => snapshotOptionsSchema.parse({ includeSnapshot: false })).toThrow();
  });

  it('rejects includeSnapshot: true (boolean not accepted)', () => {
    expect(() => snapshotOptionsSchema.parse({ includeSnapshot: true })).toThrow();
  });

  it('rejects includeSnapshot: "invalid"', () => {
    expect(() => snapshotOptionsSchema.parse({ includeSnapshot: 'invalid' })).toThrow();
  });

  it('rejects includeSnapshot: 42', () => {
    expect(() => snapshotOptionsSchema.parse({ includeSnapshot: 42 })).toThrow();
  });
});
