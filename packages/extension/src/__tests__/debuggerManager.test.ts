/**
 * Unit tests for debuggerManager — auto-reattach on CDP detach.
 *
 * Tests: terminal reasons (target_closed, canceled_by_user, replaced_with_devtools),
 * transient reasons (reattach with backoff), exhaustion after MAX_RETRIES.
 * Chrome APIs are mocked via chrome-mock.ts setup file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedTab } from './chrome-mock';
import * as tabRegistry from '../tabRegistry';
import * as debuggerManager from '../debuggerManager';

// Extract the detach handler registered via chrome.debugger.onDetach.addListener
function getDetachHandler(): (source: chrome.debugger.Debuggee, reason: string) => void {
  const calls = (chrome.debugger.onDetach.addListener as any).mock.calls;
  if (calls.length === 0) throw new Error('debuggerManager.init() was not called');
  return calls[calls.length - 1][0];
}

describe('debuggerManager', () => {
  let terminalCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    terminalCallback = vi.fn();
    debuggerManager.init(terminalCallback as unknown as (tabId: number, reason: string) => void);
  });

  describe('terminal detach reasons', () => {
    it('target_closed: removes from registry + fires terminal callback', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'target_closed');
      // Allow async operations to complete
      await vi.waitFor(async () => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'target_closed');
      });

      // Tab should be removed from registry
      expect(await tabRegistry.getAll()).toEqual([]);
    });

    it('canceled_by_user: fires terminal callback, no reattach', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'canceled_by_user');
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'canceled_by_user');
      });

      // Debugger should not be called for reattach
      expect(chrome.debugger.attach).not.toHaveBeenCalled();
    });

    it('replaced_with_devtools: fires terminal callback, no reattach', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'replaced_with_devtools');
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'replaced_with_devtools');
      });

      expect(chrome.debugger.attach).not.toHaveBeenCalled();
    });
  });

  describe('transient detach (reattach)', () => {
    it('attempts reattach on unknown reason', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test' });
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'some_transient_reason');

      // Reattach fires asynchronously with backoff — wait for it
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 2000 });

      // Terminal callback should NOT have been called
      expect(terminalCallback).not.toHaveBeenCalled();
    });

    it('fires terminal callback after MAX_RETRIES exhaustion', { timeout: 20000 }, async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      seedTab({ id: 42, url: 'https://x.com' });

      // Make attach always fail
      (chrome.debugger.attach as any).mockRejectedValue(new Error('attach failed'));

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'transient_reason');

      // After 3 failed attempts (with backoff), terminal callback fires
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'reattach_exhausted');
      }, { timeout: 15000 });

      // Should have attempted 3 times
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(3);
    });
  });

  describe('edge cases', () => {
    it('ignores detach with no tabId', () => {
      const handler = getDetachHandler();
      handler({}, 'target_closed');
      expect(terminalCallback).not.toHaveBeenCalled();
    });

    it('updates registry on successful reattach', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://old.com' });
      seedTab({ id: 42, url: 'https://new.com', title: 'New', windowId: 2 });
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'navigation');

      await vi.waitFor(async () => {
        const all = await tabRegistry.getAll();
        expect(all[0]?.debugger.attached).toBe(true);
        expect(all[0]?.url).toBe('https://new.com');
      }, { timeout: 2000 });
    });
  });
});
