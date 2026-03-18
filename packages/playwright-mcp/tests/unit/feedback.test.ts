import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { browserTools } from 'playwright-core/lib/tools/tools';

// ---------------------------------------------------------------------------
// browser_feedback tool — registration and file I/O
// ---------------------------------------------------------------------------

describe('browser_feedback tool registration', () => {
  const tool = browserTools.find(t => t.schema.name === 'browser_feedback');

  it('is registered in browserTools', () => {
    expect(tool).toBeDefined();
  });

  it('has correct schema name', () => {
    expect(tool!.schema.name).toBe('browser_feedback');
  });

  it('is an action tool', () => {
    expect(tool!.schema.type).toBe('action');
  });

  it('has core capability', () => {
    expect(tool!.capability).toBe('core');
  });

  it('schema has required fields: sessionId, category, description, toolName', () => {
    const shape = (tool!.schema.inputSchema as any).shape;
    expect(shape.sessionId.isOptional()).toBe(false);
    expect(shape.category.isOptional()).toBe(false);
    expect(shape.description.isOptional()).toBe(false);
    expect(shape.toolName.isOptional()).toBe(false);
  });

  it('schema has optional fields: expectedBehavior, stepsToReproduce, workaround', () => {
    const shape = (tool!.schema.inputSchema as any).shape;
    expect(shape.expectedBehavior.isOptional()).toBe(true);
    expect(shape.stepsToReproduce.isOptional()).toBe(true);
    expect(shape.workaround.isOptional()).toBe(true);
  });
});

describe('browser_feedback handler', () => {
  const tool = browserTools.find(t => t.schema.name === 'browser_feedback')!;
  let tmpDir: string;
  let savedWAR: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
    // Isolate from host env — WEB_AUTOMATION_ROOT would override cwd
    savedWAR = process.env.WEB_AUTOMATION_ROOT;
    delete process.env.WEB_AUTOMATION_ROOT;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedWAR !== undefined)
      process.env.WEB_AUTOMATION_ROOT = savedWAR;
    else
      delete process.env.WEB_AUTOMATION_ROOT;
  });

  function createStubContext(tabOverride?: any) {
    return {
      id: 'test-context',
      config: {},
      options: { cwd: tmpDir },
      currentTab: () => tabOverride || undefined,
      tabs: () => tabOverride ? [tabOverride] : [],
      ensureTab: async () => tabOverride,
    } as any;
  }

  function createStubResponse() {
    const results: string[] = [];
    return {
      addTextResult: (text: string) => results.push(text),
      addError: (text: string) => results.push(`ERROR: ${text}`),
      results,
    } as any;
  }

  it('writes valid JSONL entry with all mandatory fields', async () => {
    const ctx = createStubContext();
    const response = createStubResponse();
    const params = {
      sessionId: 'sess-123',
      category: 'tool-behavior' as const,
      description: 'Tool returned unexpected result',
      toolName: 'browser_snapshot',
      severity: 'medium' as const,
    };

    await tool.handle(ctx, params, response);

    const feedbackFile = path.join(tmpDir, 'docs', 'feedback', 'entries.jsonl');
    expect(fs.existsSync(feedbackFile)).toBe(true);

    const content = fs.readFileSync(feedbackFile, 'utf-8').trim();
    const entry = JSON.parse(content);

    expect(entry.sessionId).toBe('sess-123');
    expect(entry.category).toBe('tool-behavior');
    expect(entry.description).toBe('Tool returned unexpected result');
    expect(entry.toolName).toBe('browser_snapshot');
    expect(entry.severity).toBe('medium');
  });

  it('auto-generates id and timestamp', async () => {
    const ctx = createStubContext();
    const response = createStubResponse();
    const params = {
      sessionId: 'sess-456',
      category: 'other' as const,
      description: 'Test feedback',
      toolName: 'browser_evaluate',
      severity: 'low' as const,
    };

    await tool.handle(ctx, params, response);

    const feedbackFile = path.join(tmpDir, 'docs', 'feedback', 'entries.jsonl');
    const entry = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8').trim());

    expect(entry.id).toMatch(/^fb-[a-f0-9]{8}$/);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates directory if missing', async () => {
    const feedbackDir = path.join(tmpDir, 'docs', 'feedback');
    expect(fs.existsSync(feedbackDir)).toBe(false);

    const ctx = createStubContext();
    const response = createStubResponse();
    await tool.handle(ctx, {
      sessionId: 's', category: 'other' as const,
      description: 'd', toolName: 't', severity: 'low' as const,
    }, response);

    expect(fs.existsSync(feedbackDir)).toBe(true);
  });

  it('captures URL and title when tab exists', async () => {
    const mockTab = {
      page: {
        url: () => 'https://example.com/test',
        title: async () => 'Test Page',
      },
    };
    const ctx = createStubContext(mockTab);
    const response = createStubResponse();

    await tool.handle(ctx, {
      sessionId: 's', category: 'other' as const,
      description: 'd', toolName: 't', severity: 'low' as const,
    }, response);

    const feedbackFile = path.join(tmpDir, 'docs', 'feedback', 'entries.jsonl');
    const entry = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8').trim());

    expect(entry.url).toBe('https://example.com/test');
    expect(entry.pageTitle).toBe('Test Page');
  });

  it('omits URL and title when no tab exists', async () => {
    const ctx = createStubContext();
    const response = createStubResponse();

    await tool.handle(ctx, {
      sessionId: 's', category: 'other' as const,
      description: 'd', toolName: 't', severity: 'low' as const,
    }, response);

    const feedbackFile = path.join(tmpDir, 'docs', 'feedback', 'entries.jsonl');
    const entry = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8').trim());

    expect(entry.url).toBeUndefined();
    expect(entry.pageTitle).toBeUndefined();
  });

  it('serializes concurrent writes without interleaving', async () => {
    const ctx = createStubContext();

    // Fire 5 concurrent writes
    const promises = Array.from({ length: 5 }, (_, i) => {
      const response = createStubResponse();
      return tool.handle(ctx, {
        sessionId: `concurrent-${i}`,
        category: 'other' as const,
        description: `Entry ${i}`,
        toolName: 'browser_snapshot',
        severity: 'low' as const,
      }, response);
    });

    await Promise.all(promises);

    const feedbackFile = path.join(tmpDir, 'docs', 'feedback', 'entries.jsonl');
    const lines = fs.readFileSync(feedbackFile, 'utf-8').trim().split('\n');

    expect(lines).toHaveLength(5);

    // Each line should be valid JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.id).toMatch(/^fb-/);
      expect(entry.sessionId).toMatch(/^concurrent-\d$/);
    }
  });

  it('returns confirmation message with id, category, severity', async () => {
    const ctx = createStubContext();
    const response = createStubResponse();

    await tool.handle(ctx, {
      sessionId: 's', category: 'performance' as const,
      description: 'd', toolName: 't', severity: 'high' as const,
    }, response);

    expect(response.results[0]).toContain('Feedback recorded: fb-');
    expect(response.results[0]).toContain('Category: performance');
    expect(response.results[0]).toContain('Severity: high');
    expect(response.results[0]).toContain('docs/feedback/entries.jsonl');
  });
});
