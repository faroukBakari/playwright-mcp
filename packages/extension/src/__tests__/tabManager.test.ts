/**
 * Unit tests for TabManager v2 — sole debugger lifecycle owner.
 *
 * Tests: _syncTabs purge, attach (fresh/no-op/bump/error), detach,
 * detachAll, getDebuggee, getSessionForTab, removeByTab, getAllSessions,
 * and an encapsulation check that no source file outside tabManager.ts
 * calls chrome.debugger.attach/detach directly.
 *
 * Chrome APIs mocked via chrome-mock.ts setup file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TabManager } from '../tabManager';

describe('TabManager', () => {
  let tm: TabManager;

  beforeEach(() => {
    tm = new TabManager();
  });

  // ── _syncTabs (exercised via any public method) ────────────────────────────

  describe('_syncTabs purge', () => {
    it('purges stale entries when getTargets returns fewer targets', async () => {
      await tm.attach('sess-1', 10);
      await tm.attach('sess-2', 20);
      expect(await tm.getSize()).toBe(2);

      // Make getTargets report only tab 20 as still attached
      chrome.debugger.getTargets.mockResolvedValueOnce([
        { attached: true, tabId: 20, id: 'target-20', type: 'page', title: '', url: '', faviconUrl: '' },
      ]);

      const size = await tm.getSize();
      expect(size).toBe(1);
      expect(await tm.getDebuggee('sess-1')).toBeUndefined();
      expect(await tm.getDebuggee('sess-2')).toEqual({ tabId: 20 });
    });

    it('no-ops when getTargets confirms all current entries', async () => {
      await tm.attach('sess-1', 42);
      // Default mock returns attachedDebuggees which includes tab 42
      const size = await tm.getSize();
      expect(size).toBe(1);
      expect(await tm.getDebuggee('sess-1')).toEqual({ tabId: 42 });
    });
  });

  // ── attach ─────────────────────────────────────────────────────────────────

  describe('attach', () => {
    it('calls getTargets then chrome.debugger.attach, updates maps', async () => {
      const result = await tm.attach('client-1', 42);

      expect(chrome.debugger.getTargets).toHaveBeenCalled();
      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      expect(result.debuggee).toEqual({ tabId: 42 });
      expect(await tm.getSize()).toBe(1);
    });

    it('tracks multiple sessions independently', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      expect(await tm.getSize()).toBe(2);
      expect(await tm.getDebuggee('client-1')).toEqual({ tabId: 42 });
      expect(await tm.getDebuggee('client-2')).toEqual({ tabId: 77 });
    });

    it('self-ownership: same session + same tab → no-op, no extra chrome calls', async () => {
      await tm.attach('client-1', 42);

      vi.clearAllMocks();
      // Re-wire after clearAllMocks: tab 42 is still attached
      chrome.debugger.getTargets.mockResolvedValue([
        { attached: true, tabId: 42, id: 't', type: 'page', title: '', url: '', faviconUrl: '' },
      ]);

      const result = await tm.attach('client-1', 42);

      expect(chrome.debugger.attach).not.toHaveBeenCalled();
      expect(chrome.debugger.detach).not.toHaveBeenCalled();
      expect(result.debuggee).toEqual({ tabId: 42 });
    });

    it('session move: re-attach same session to different tab cleans old mapping', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-1', 77);

      expect(await tm.getSize()).toBe(1);
      expect(await tm.getDebuggee('client-1')).toEqual({ tabId: 77 });
      expect(await tm.getSessionForTab(42)).toBeUndefined();
      expect(await tm.getSessionForTab(77)).toBe('client-1');
    });

    it('bump: different session owns tab → internal detach + attach', async () => {
      await tm.attach('client-1', 42);

      vi.clearAllMocks();
      chrome.debugger.getTargets.mockResolvedValue([
        { attached: true, tabId: 42, id: 't', type: 'page', title: '', url: '', faviconUrl: '' },
      ]);
      chrome.debugger.detach.mockResolvedValue(undefined);
      chrome.debugger.attach.mockResolvedValue(undefined);

      await tm.attach('client-2', 42);

      // Bump detach called for old owner, then attach for new owner
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');

      expect(await tm.getDebuggee('client-1')).toBeUndefined();
      expect(await tm.getDebuggee('client-2')).toEqual({ tabId: 42 });
    });

    it('attach error propagates, maps stay consistent (no stale entry)', async () => {
      chrome.debugger.attach.mockRejectedValueOnce(new Error('DevTools already attached'));

      await expect(tm.attach('client-1', 42)).rejects.toThrow('DevTools already attached');

      // Sync ran before the attempt — maps stay clean
      expect(await tm.getDebuggee('client-1')).toBeUndefined();
      expect(await tm.getSessionForTab(42)).toBeUndefined();
    });

    it('bump detach failure propagates (tab already closed)', async () => {
      await tm.attach('client-1', 42);

      vi.clearAllMocks();
      chrome.debugger.getTargets.mockResolvedValue([
        { attached: true, tabId: 42, id: 't', type: 'page', title: '', url: '', faviconUrl: '' },
      ]);
      chrome.debugger.detach.mockRejectedValueOnce(new Error('No tab with given id'));
      chrome.debugger.attach.mockResolvedValue(undefined);

      // Bump detach failure propagates — caller sees the real problem
      await expect(tm.attach('client-2', 42)).rejects.toThrow('No tab with given id');
    });
  });

  // ── detach ────────────────────────────────────────────────────────────────

  describe('detach', () => {
    it('calls chrome.debugger.detach and removes maps', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      await tm.detach('client-1');

      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
      expect(await tm.getSize()).toBe(1);
      expect(await tm.getDebuggee('client-1')).toBeUndefined();
      expect(await tm.getDebuggee('client-2')).toEqual({ tabId: 77 });
    });

    it('cleans reverse mapping on detach', async () => {
      await tm.attach('client-1', 42);
      await tm.detach('client-1');
      expect(await tm.getSessionForTab(42)).toBeUndefined();
    });

    it('no-op for unknown sessionId (no throw, no detach)', async () => {
      await expect(tm.detach('unknown')).resolves.not.toThrow();
      expect(chrome.debugger.detach).not.toHaveBeenCalled();
    });

    it('detach failure propagates, maps still cleared', async () => {
      await tm.attach('client-1', 42);
      chrome.debugger.detach.mockRejectedValueOnce(new Error('No tab with given id'));

      await expect(tm.detach('client-1')).rejects.toThrow('No tab with given id');
      // Maps cleared even when detach throws (delete happens before chrome call)
      expect(await tm.getDebuggee('client-1')).toBeUndefined();
    });
  });

  // ── detachAll ─────────────────────────────────────────────────────────────

  describe('detachAll', () => {
    it('calls chrome.debugger.detach for each session', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      await tm.detachAll();

      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 77 });
    });

    it('clears all maps', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      await tm.detachAll();

      expect(await tm.getSize()).toBe(0);
      expect(await tm.getConnectedTabIds()).toEqual([]);
    });

    it('no-op when no sessions (no throw, no detach)', async () => {
      await expect(tm.detachAll()).resolves.not.toThrow();
      expect(chrome.debugger.detach).not.toHaveBeenCalled();
    });

    it('detaches in-memory entries even when getTargets would return empty', async () => {
      await tm.attach('client-1', 42);

      // detachAll does NOT call _syncTabs — detaches regardless of Chrome state
      chrome.debugger.getTargets.mockResolvedValue([]);

      await tm.detachAll();

      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    });
  });

  // ── getDebuggee ────────────────────────────────────────────────────────────

  describe('getDebuggee', () => {
    it('returns correct entry by sessionId', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);
      expect(await tm.getDebuggee('client-1')).toEqual({ tabId: 42 });
    });

    it('returns undefined for unknown sessionId', async () => {
      await tm.attach('client-1', 42);
      expect(await tm.getDebuggee('unknown')).toBeUndefined();
    });

    it('returns single entry when sessionId omitted (single-client compat)', async () => {
      await tm.attach('client-1', 42);
      expect(await tm.getDebuggee()).toEqual({ tabId: 42 });
    });

    it('returns undefined when sessionId omitted with multiple entries', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);
      expect(await tm.getDebuggee()).toBeUndefined();
    });

    it('returns undefined when sessionId omitted with no entries', async () => {
      expect(await tm.getDebuggee()).toBeUndefined();
    });

    it('syncs before returning — purges stale entry', async () => {
      await tm.attach('client-1', 42);
      // Simulate Chrome detaching tab 42 without firing onDetach
      chrome.debugger.getTargets.mockResolvedValueOnce([]);
      expect(await tm.getDebuggee('client-1')).toBeUndefined();
    });
  });

  // ── getSessionForTab ───────────────────────────────────────────────────────

  describe('getSessionForTab', () => {
    it('returns sessionId for known tabId', async () => {
      await tm.attach('client-1', 42);
      expect(await tm.getSessionForTab(42)).toBe('client-1');
    });

    it('returns undefined for unknown tabId', async () => {
      expect(await tm.getSessionForTab(999)).toBeUndefined();
    });

    it('syncs before returning — purges stale entry', async () => {
      await tm.attach('client-1', 42);
      chrome.debugger.getTargets.mockResolvedValueOnce([]);
      expect(await tm.getSessionForTab(42)).toBeUndefined();
    });
  });

  // ── removeByTab ────────────────────────────────────────────────────────────

  describe('removeByTab', () => {
    it('removes session by tabId and returns sessionId', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      const removed = await tm.removeByTab(42);
      expect(removed).toBe('client-1');
      expect(await tm.getSize()).toBe(1);
      expect(await tm.getDebuggee('client-1')).toBeUndefined();
      expect(await tm.getSessionForTab(42)).toBeUndefined();
    });

    it('returns undefined for unknown tabId', async () => {
      expect(await tm.removeByTab(999)).toBeUndefined();
    });
  });

  // ── getAllSessions ─────────────────────────────────────────────────────────

  describe('getAllSessions', () => {
    it('returns all session→tabId pairs', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);

      const sessions = await tm.getAllSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions).toEqual(expect.arrayContaining([
        { sessionId: 'client-1', tabId: 42 },
        { sessionId: 'client-2', tabId: 77 },
      ]));
    });

    it('returns empty array when no sessions', async () => {
      expect(await tm.getAllSessions()).toEqual([]);
    });
  });

  // ── getSize ────────────────────────────────────────────────────────────────

  describe('getSize', () => {
    it('returns correct count after attaches', async () => {
      expect(await tm.getSize()).toBe(0);
      await tm.attach('client-1', 42);
      expect(await tm.getSize()).toBe(1);
      await tm.attach('client-2', 77);
      expect(await tm.getSize()).toBe(2);
    });
  });

  // ── getConnectedTabIds ─────────────────────────────────────────────────────

  describe('getConnectedTabIds', () => {
    it('returns all connected tab IDs', async () => {
      await tm.attach('client-1', 42);
      await tm.attach('client-2', 77);
      expect((await tm.getConnectedTabIds()).sort((a, b) => a - b)).toEqual([42, 77]);
    });

    it('returns empty array when no sessions', async () => {
      expect(await tm.getConnectedTabIds()).toEqual([]);
    });
  });

  // ── Encapsulation enforcement ──────────────────────────────────────────────

  describe('encapsulation', () => {
    it('no source file outside tabManager.ts calls chrome.debugger.attach or detach', () => {
      const srcDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
      const pattern = /chrome\.debugger\.(attach|detach)\(/;
      // debuggerManager.ts is a documented exception: owns reattach-on-security-detach
      const exemptions = new Set(['tabManager.ts', 'debuggerManager.ts']);

      const violations: string[] = [];

      for (const filename of fs.readdirSync(srcDir)) {
        if (!filename.endsWith('.ts')) continue;
        if (exemptions.has(filename)) continue;

        const filePath = path.join(srcDir, filename);
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            violations.push(`${filename}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }

      if (violations.length > 0) {
        throw new Error(
          `chrome.debugger.attach/detach found outside tabManager.ts (with exception for debuggerManager.ts):\n` +
          violations.map(v => `  ${v}`).join('\n')
        );
      }
    });
  });
});
