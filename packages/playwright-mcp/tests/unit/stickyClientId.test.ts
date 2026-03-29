import { describe, it, expect } from 'vitest';

import { Response } from 'playwright-core/lib/tools/response';

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

describe('clientId removed from output', () => {
  it('response output does not include clientId line', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    response.addTextResult('Clicked button');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).not.toContain('clientId');
  });

  it('Result section contains only tool results', async () => {
    const ctx = createStubContext();
    const response = new Response(ctx, 'browser_click', {});
    response.addTextResult('Done');
    const result = await response.serialize();
    const text = (result.content[0] as any).text;
    expect(text).toContain('### Result');
    expect(text).toContain('Done');
    expect(text).not.toContain('clientId');
  });
});
