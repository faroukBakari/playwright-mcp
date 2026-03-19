/**
 * Unit tests for TabManager — multi-tab debugger state management.
 *
 * Tests: attach, detach, routing, single-client compat, detachAll.
 * Chrome APIs mocked via chrome-mock.ts setup file.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TabManager } from '../tabManager';

describe('TabManager', () => {
  let tm: TabManager;

  beforeEach(() => {
    tm = new TabManager();
  });

  describe('attach', () => {
    it('creates debuggee entry with correct tabId', () => {
      const debuggee = tm.attach('client-1', 42);
      expect(debuggee).toEqual({ tabId: 42 });
      expect(tm.size).toBe(1);
    });

    it('tracks multiple clients independently', () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);
      expect(tm.size).toBe(2);
      expect(tm.getDebuggee('client-1')).toEqual({ tabId: 42 });
      expect(tm.getDebuggee('client-2')).toEqual({ tabId: 77 });
    });

    it('re-attach same clientId to different tab cleans up old mapping', () => {
      tm.attach('client-1', 42);
      tm.attach('client-1', 77);
      expect(tm.size).toBe(1);
      expect(tm.getDebuggee('client-1')).toEqual({ tabId: 77 });
      // Old tab should not map to client
      expect(tm.getSessionForTab(42)).toBeUndefined();
      expect(tm.getSessionForTab(77)).toBe('client-1');
    });
  });

  describe('getDebuggee', () => {
    it('returns correct entry by clientId', () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);
      expect(tm.getDebuggee('client-1')).toEqual({ tabId: 42 });
    });

    it('returns undefined for unknown clientId', () => {
      tm.attach('client-1', 42);
      expect(tm.getDebuggee('unknown')).toBeUndefined();
    });

    it('returns single entry when clientId omitted (single-client compat)', () => {
      tm.attach('client-1', 42);
      expect(tm.getDebuggee()).toEqual({ tabId: 42 });
    });

    it('returns undefined when clientId omitted with multiple entries', () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);
      expect(tm.getDebuggee()).toBeUndefined();
    });

    it('returns undefined when clientId omitted with no entries', () => {
      expect(tm.getDebuggee()).toBeUndefined();
    });
  });

  describe('detach', () => {
    it('removes only the specified client', async () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);

      const tabId = await tm.detach('client-1');
      expect(tabId).toBe(42);
      expect(tm.size).toBe(1);
      expect(tm.getDebuggee('client-1')).toBeUndefined();
      expect(tm.getDebuggee('client-2')).toEqual({ tabId: 77 });
    });

    it('calls chrome.debugger.detach', async () => {
      tm.attach('client-1', 42);
      await tm.detach('client-1');
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    });

    it('returns null for unknown clientId', async () => {
      const result = await tm.detach('unknown');
      expect(result).toBeNull();
    });

    it('cleans up reverse mapping', async () => {
      tm.attach('client-1', 42);
      await tm.detach('client-1');
      expect(tm.getSessionForTab(42)).toBeUndefined();
    });
  });

  describe('detachAll', () => {
    it('clears all entries', async () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);

      await tm.detachAll();
      expect(tm.size).toBe(0);
      expect(tm.connectedTabIds).toEqual([]);
    });

    it('calls chrome.debugger.detach for each client', async () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);

      await tm.detachAll();
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 77 });
    });
  });

  describe('getSessionForTab', () => {
    it('returns clientId for known tabId', () => {
      tm.attach('client-1', 42);
      expect(tm.getSessionForTab(42)).toBe('client-1');
    });

    it('returns undefined for unknown tabId', () => {
      expect(tm.getSessionForTab(999)).toBeUndefined();
    });
  });

  describe('removeByTab', () => {
    it('removes client by tabId and returns clientId', () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);

      const removed = tm.removeByTab(42);
      expect(removed).toBe('client-1');
      expect(tm.size).toBe(1);
      expect(tm.getDebuggee('client-1')).toBeUndefined();
      expect(tm.getSessionForTab(42)).toBeUndefined();
    });

    it('returns undefined for unknown tabId', () => {
      expect(tm.removeByTab(999)).toBeUndefined();
    });
  });

  describe('connectedTabIds', () => {
    it('returns all connected tab IDs', () => {
      tm.attach('client-1', 42);
      tm.attach('client-2', 77);
      expect(tm.connectedTabIds.sort()).toEqual([42, 77]);
    });

    it('returns empty array when no clients', () => {
      expect(tm.connectedTabIds).toEqual([]);
    });
  });
});
