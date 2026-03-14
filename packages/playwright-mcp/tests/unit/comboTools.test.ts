import { describe, it, expect } from 'vitest';

// Import tool arrays from compiled playwright-core
// Default exports compile to .default in CJS
import formModule from 'playwright-core/lib/tools/form';
import navigateModule from 'playwright-core/lib/tools/navigate';
import { resolveTimeout } from 'playwright-core/lib/tools/wait';

const formTools: any[] = (formModule as any).default ?? formModule;
const navigateTools: any[] = (navigateModule as any).default ?? navigateModule;

// ---------------------------------------------------------------------------
// Wave 5: Combo tools — schema verification + export validation
// ---------------------------------------------------------------------------

describe('browser_fill_form schema (Patch 1+2)', () => {
  const fillForm = formTools.find((t: any) => t.schema.name === 'browser_fill_form');

  it('exists in form tool exports', () => {
    expect(fillForm).toBeDefined();
  });

  it('has submitRef optional param in schema', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.submitRef).toBeDefined();
    expect(shape.submitRef.isOptional()).toBe(true);
  });

  it('has submitElement optional param in schema', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.submitElement).toBeDefined();
    expect(shape.submitElement.isOptional()).toBe(true);
  });

  it('retains existing fields array param', () => {
    const shape = fillForm!.schema.inputSchema.shape;
    expect(shape.fields).toBeDefined();
  });

  it('description mentions submit', () => {
    expect(fillForm!.schema.description).toContain('submit');
  });
});

describe('browser_navigate_and_wait schema (Patch 3)', () => {
  const navAndWait = navigateTools.find((t: any) => t.schema.name === 'browser_navigate_and_wait');

  it('exists in navigate tool exports', () => {
    expect(navAndWait).toBeDefined();
  });

  it('has url required param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.url).toBeDefined();
    expect(shape.url.isOptional()).toBe(false);
  });

  it('has waitForText optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForText).toBeDefined();
    expect(shape.waitForText.isOptional()).toBe(true);
  });

  it('has waitForSelector optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForSelector).toBeDefined();
    expect(shape.waitForSelector.isOptional()).toBe(true);
  });

  it('has waitForUrl optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.waitForUrl).toBeDefined();
    expect(shape.waitForUrl.isOptional()).toBe(true);
  });

  it('has timeout optional param', () => {
    const shape = navAndWait!.schema.inputSchema.shape;
    expect(shape.timeout).toBeDefined();
    expect(shape.timeout.isOptional()).toBe(true);
  });

  it('has capability core-navigation', () => {
    expect(navAndWait!.capability).toBe('core-navigation');
  });

  it('has type action', () => {
    expect(navAndWait!.schema.type).toBe('action');
  });

  it('does not duplicate browser_navigate', () => {
    const navigateTools_ = navigateTools.filter((t: any) => t.schema.name === 'browser_navigate');
    expect(navigateTools_).toHaveLength(1);
  });
});

describe('wait.ts exports (Patch 3 prerequisite)', () => {
  it('resolveTimeout is exported and callable', () => {
    expect(typeof resolveTimeout).toBe('function');
  });

  it('resolveTimeout uses default when no timeout param', () => {
    const stubTab = {
      context: {
        config: {
          performance: {
            waitDefaultTimeout: 3000,
            waitMaxTimeout: 30000,
          },
        },
      },
    } as any;
    expect(resolveTimeout(stubTab, {})).toBe(3000);
  });

  it('resolveTimeout caps at maxTimeout', () => {
    const stubTab = {
      context: {
        config: {
          performance: {
            waitDefaultTimeout: 3000,
            waitMaxTimeout: 10000,
          },
        },
      },
    } as any;
    // timeout param is in seconds, resolveTimeout converts to ms
    expect(resolveTimeout(stubTab, { timeout: 20 })).toBe(10000);
  });

  it('resolveTimeout converts seconds to ms', () => {
    const stubTab = {
      context: {
        config: {
          performance: {
            waitDefaultTimeout: 3000,
            waitMaxTimeout: 30000,
          },
        },
      },
    } as any;
    expect(resolveTimeout(stubTab, { timeout: 5 })).toBe(5000);
  });
});
