import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { normalizePath, validatePaths } from 'playwright-core/lib/tools/files';

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

describe('normalizePath', () => {
  it('strips wrapping double quotes', () => {
    expect(normalizePath('"/home/user/file.pdf"')).toBe('/home/user/file.pdf');
  });

  it('strips wrapping single quotes', () => {
    expect(normalizePath("'/home/user/file.pdf'")).toBe('/home/user/file.pdf');
  });

  it('trims whitespace', () => {
    expect(normalizePath('  /home/user/file.pdf  ')).toBe('/home/user/file.pdf');
  });

  it('expands tilde to home directory', () => {
    const result = normalizePath('~/Documents/resume.pdf');
    expect(result).toBe(path.join(os.homedir(), 'Documents/resume.pdf'));
  });

  it('expands bare tilde', () => {
    const result = normalizePath('~');
    expect(result).toBe(os.homedir());
  });

  it('resolves relative path to absolute', () => {
    const result = normalizePath('./file.pdf');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('./file.pdf'));
  });

  it('resolves parent-relative path', () => {
    const result = normalizePath('../docs/file.pdf');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toBe(path.resolve('../docs/file.pdf'));
  });

  it('passes through absolute path unchanged', () => {
    expect(normalizePath('/tmp/file.pdf')).toBe('/tmp/file.pdf');
  });

  it('rejects Windows drive-letter path with wslpath hint', () => {
    expect(() => normalizePath('C:\\Users\\test\\file.pdf')).toThrow('Windows path detected');
    expect(() => normalizePath('C:\\Users\\test\\file.pdf')).toThrow('wslpath');
  });

  it('rejects forward-slash Windows path', () => {
    expect(() => normalizePath('C:/Users/test/file.pdf')).toThrow('Windows path detected');
  });

  it('rejects UNC path with wslpath hint', () => {
    expect(() => normalizePath('\\\\wsl.localhost\\Ubuntu\\home\\user\\file.pdf')).toThrow('UNC path detected');
    expect(() => normalizePath('\\\\wsl.localhost\\Ubuntu\\home\\user\\file.pdf')).toThrow('wslpath');
  });

  it('rejects forward-slash UNC path', () => {
    expect(() => normalizePath('//server/share/file.pdf')).toThrow('UNC path detected');
  });
});

// ---------------------------------------------------------------------------
// validatePaths
// ---------------------------------------------------------------------------

describe('validatePaths', () => {
  it('accepts existing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upload-test-'));
    const file = path.join(dir, 'test.txt');
    fs.writeFileSync(file, 'content');
    try {
      await expect(validatePaths([file])).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects nonexistent path', async () => {
    await expect(validatePaths(['/tmp/pw-definitely-nonexistent-file.pdf']))
      .rejects.toThrow('File not found');
  });

  it('rejects directory path', async () => {
    await expect(validatePaths(['/tmp']))
      .rejects.toThrow('Expected a file but got a directory');
  });

  it('validates multiple paths — fails on first bad one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upload-test-'));
    const good = path.join(dir, 'good.txt');
    fs.writeFileSync(good, 'ok');
    try {
      await expect(validatePaths([good, '/tmp/pw-definitely-nonexistent.pdf']))
        .rejects.toThrow('File not found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
