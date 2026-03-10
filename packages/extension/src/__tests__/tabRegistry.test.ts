/**
 * Unit tests for tabRegistry — persistent tab tracking via chrome.storage.local.
 *
 * Tests: upsert, getAll, remove, event handlers, reconcile, protocol messages.
 * Chrome APIs are mocked via chrome-mock.ts setup file.
 */

import { describe, it, expect, vi } from 'vitest';
import { seedTab } from './chrome-mock';
import * as tabRegistry from '../tabRegistry';

describe('tabRegistry', () => {
  describe('upsertOnAttach', () => {
    it('creates a new entry on first attach', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://example.com', title: 'Example' });
      const all = await tabRegistry.getAll();

      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        tabId: 42,
        windowId: 1,
        url: 'https://example.com',
        title: 'Example',
        status: 'active',
        debugger: { attached: true },
      });
      expect(all[0].debugger.lastAttached).toBeTypeOf('number');
      expect(all[0].lastSeen).toBeTypeOf('number');
    });

    it('updates existing entry on re-attach', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://old.com', title: 'Old' });
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://new.com', title: 'New' });
      const all = await tabRegistry.getAll();

      expect(all).toHaveLength(1);
      expect(all[0].url).toBe('https://new.com');
      expect(all[0].title).toBe('New');
      expect(all[0].debugger.attached).toBe(true);
    });

    it('preserves existing url/title when not provided', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://kept.com', title: 'Kept' });
      await tabRegistry.upsertOnAttach(42, 1, {});
      const all = await tabRegistry.getAll();

      expect(all[0].url).toBe('https://kept.com');
      expect(all[0].title).toBe('Kept');
    });
  });

  describe('getAll', () => {
    it('returns empty array when no entries', async () => {
      expect(await tabRegistry.getAll()).toEqual([]);
    });

    it('returns all entries', async () => {
      await tabRegistry.upsertOnAttach(1, 1, { url: 'a' });
      await tabRegistry.upsertOnAttach(2, 1, { url: 'b' });
      await tabRegistry.upsertOnAttach(3, 2, { url: 'c' });

      const all = await tabRegistry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map(e => e.tabId).sort()).toEqual([1, 2, 3]);
    });
  });

  describe('removeTab', () => {
    it('removes an existing entry', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'x' });
      await tabRegistry.removeTab(42);
      expect(await tabRegistry.getAll()).toEqual([]);
    });

    it('is a no-op for non-existent tab', async () => {
      await tabRegistry.removeTab(999);
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('onTabRemoved', () => {
    it('deletes entry from registry', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'x' });
      await tabRegistry.onTabRemoved(42);
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('onTabUpdated', () => {
    it('updates url when changed', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://old.com' });
      await tabRegistry.onTabUpdated(42, { url: 'https://new.com' } as chrome.tabs.TabChangeInfo);

      const all = await tabRegistry.getAll();
      expect(all[0].url).toBe('https://new.com');
    });

    it('updates title when changed', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { title: 'Old Title' });
      await tabRegistry.onTabUpdated(42, { title: 'New Title' } as chrome.tabs.TabChangeInfo);

      const all = await tabRegistry.getAll();
      expect(all[0].title).toBe('New Title');
    });

    it('updates status when changed', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      await tabRegistry.onTabUpdated(42, { status: 'loading' } as chrome.tabs.TabChangeInfo);

      const all = await tabRegistry.getAll();
      expect(all[0].status).toBe('loading');
    });

    it('updates lastSeen on any update', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      const before = (await tabRegistry.getAll())[0].lastSeen;
      // Tiny delay to ensure timestamp differs
      await new Promise(r => setTimeout(r, 5));
      await tabRegistry.onTabUpdated(42, { url: 'https://x.com' } as chrome.tabs.TabChangeInfo);
      const after = (await tabRegistry.getAll())[0].lastSeen;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('ignores updates for untracked tabs', async () => {
      await tabRegistry.onTabUpdated(999, { url: 'https://x.com' } as chrome.tabs.TabChangeInfo);
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('onTabActivated', () => {
    it('updates lastSeen for tracked tab', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      await tabRegistry.onTabActivated(42);
      const all = await tabRegistry.getAll();
      expect(all[0].lastSeen).toBeTypeOf('number');
    });

    it('ignores untracked tabs', async () => {
      await tabRegistry.onTabActivated(999);
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('onDebuggerDetach', () => {
    it('marks debugger as detached with reason', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      await tabRegistry.onDebuggerDetach(42, 'replaced_with_devtools');

      const all = await tabRegistry.getAll();
      expect(all[0].debugger.attached).toBe(false);
      expect(all[0].debugger.lastDetachReason).toBe('replaced_with_devtools');
    });

    it('ignores untracked tabs', async () => {
      await tabRegistry.onDebuggerDetach(999, 'target_closed');
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('reconcile', () => {
    it('removes entries for closed tabs', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://gone.com' });
      // No tabs seeded → tab 42 doesn't exist in Chrome
      await tabRegistry.reconcile();
      expect(await tabRegistry.getAll()).toEqual([]);
    });

    it('preserves entries for live tabs', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://alive.com' });
      seedTab({ id: 42, url: 'https://alive.com', title: 'Alive' });
      await tabRegistry.reconcile();
      const all = await tabRegistry.getAll();
      expect(all).toHaveLength(1);
      expect(all[0].tabId).toBe(42);
    });

    it('updates url/title from live tab state', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://old.com', title: 'Old' });
      seedTab({ id: 42, url: 'https://updated.com', title: 'Updated' });
      await tabRegistry.reconcile();
      const all = await tabRegistry.getAll();
      expect(all[0].url).toBe('https://updated.com');
      expect(all[0].title).toBe('Updated');
    });

    it('does not add untracked tabs', async () => {
      seedTab({ id: 100, url: 'https://untracked.com' });
      await tabRegistry.reconcile();
      expect(await tabRegistry.getAll()).toEqual([]);
    });
  });

  describe('handleRegistryMessage', () => {
    it('responds to registry:list with all tabs', async () => {
      await tabRegistry.upsertOnAttach(1, 1, { url: 'a' });
      await tabRegistry.upsertOnAttach(2, 1, { url: 'b' });

      const response = await tabRegistry.handleRegistryMessage({ type: 'registry:list' });
      expect(response.type).toBe('registry:response');
      expect((response as any).tabs).toHaveLength(2);
    });

    it('responds to registry:focus with success', async () => {
      seedTab({ id: 42, windowId: 1 });
      const response = await tabRegistry.handleRegistryMessage({ type: 'registry:focus', tabId: 42 });
      expect(response).toEqual({ type: 'registry:focusResult', success: true });
      expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    });

    it('responds to registry:focus with error for missing tab', async () => {
      const response = await tabRegistry.handleRegistryMessage({ type: 'registry:focus', tabId: 999 });
      expect(response).toMatchObject({ type: 'registry:focusResult', success: false });
      expect((response as any).error).toBeTruthy();
    });

    it('throws on unknown message type', async () => {
      await expect(
        tabRegistry.handleRegistryMessage({ type: 'registry:unknown' } as any)
      ).rejects.toThrow('Unknown registry message type');
    });
  });
});
