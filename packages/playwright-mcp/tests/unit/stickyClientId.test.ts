import { describe, it, expect } from 'vitest';

import { Response, parseResponse } from 'playwright-core/lib/tools/response';

// Minimal context stub — same pattern as snapshotControl.test.ts
function createStubContext(id: string = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') {
  return {
    id,
    config: {},
    options: { cwd: '/tmp' },
    currentTab: () => undefined,
    tabs: () => [],
  } as any;
}

describe('sticky clientId', () => {
  it('response output includes clientId line', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    response.addTextResult('Clicked button');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).toContain('- clientId: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('clientId appears in Result section even with no other results', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).toContain('### Result');
    expect(text).toContain('- clientId: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('clientId reflects context.id at construction time', async () => {
    const customId = '11111111-2222-3333-4444-555555555555';
    const ctx = createStubContext(customId);
    const response = new Response(ctx, 'browser_navigate', {});
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).toContain(`- clientId: ${customId}`);
  });

  it('parseResponse extracts clientId from result section', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    response.addTextResult('Done');
    const result = await response.serialize();
    const parsed = parseResponse(result);
    expect(parsed?.result).toContain('clientId: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});
