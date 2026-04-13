/**
 * Unit tests for debuggerManager — auto-reattach on CDP detach.
 *
 * Tests: terminal reasons (target_closed with tab gone), delayed-terminal
 * (replaced_with_devtools), transient auto-reattach (canceled_by_user, unknown),
 * exhaustion after MAX_RETRIES, per-tab reattach promise isolation,
 * context recovery signal (debuggerReattached + contextRecoveryComplete protocol).
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
    // Reset module-level state (maps + callbacks) so timer callbacks from
    // previous tests can't interfere with the current test's state.
    debuggerManager._resetForTesting();
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

    it('canceled_by_user: reattaches automatically (user accidentally clicked Cancel)', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });
      const handler = getDetachHandler();

      handler({ tabId: 42 }, 'canceled_by_user');

      // Reattach fires asynchronously with backoff
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 2000 });

      // Terminal callback should NOT have been called — this is transient
      expect(terminalCallback).not.toHaveBeenCalled();
    });

    it('replaced_with_devtools: attempts delayed reattach before terminal', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      seedTab({ id: 42, url: 'https://x.com', title: 'Test' });

      // Make reattach fail (simulates real DevTools open)
      (chrome.debugger.attach as any).mockRejectedValue(new Error('Another debugger is attached'));

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'replaced_with_devtools');

      // Should NOT fire terminal callback immediately
      expect(terminalCallback).not.toHaveBeenCalled();

      // After delayed reattach fails (~1s), terminal callback fires
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'replaced_with_devtools');
      }, { timeout: 3000 });

      // Should have attempted exactly one reattach
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    });

    it('replaced_with_devtools: recovers if reattach succeeds (antivirus interference)', async () => {
      await tabRegistry.upsertOnAttach(42, 1, {});
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'replaced_with_devtools');

      // Reattach succeeds (default mock behavior) — Kaspersky released the debugger
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 3000 });

      // Terminal callback should NOT have been called — recovered
      expect(terminalCallback).not.toHaveBeenCalled();
    });
  });

  describe('security-induced detach (target_closed + tab alive)', () => {
    it('reattaches when tab is still alive after target_closed', async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // Should NOT fire terminal callback — tab is alive
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 2000 });

      expect(terminalCallback).not.toHaveBeenCalled();

      // Registry should show tab as re-attached
      const all = await tabRegistry.getAll();
      expect(all[0]?.debugger.attached).toBe(true);
    });

    it('falls through to terminal when all security reattach retries fail', { timeout: 15000 }, async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test' });

      // Reattach fails on every attempt (Kaspersky holds the debugger)
      (chrome.debugger.attach as any).mockRejectedValue(new Error('Cannot attach'));

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // 3 retries with exponential backoff: ~500ms + ~1s + ~2s ≈ 3.5s worst case
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(42, 'target_closed');
      }, { timeout: 8000 });

      // Should have attempted all 3 retries
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(3);
    });

    it('exposes reattachPromise(tabId) during security-induced reattach', { timeout: 15000 }, async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      // No reattach in progress yet
      expect(debuggerManager.reattachPromise(42)).toBeNull();

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // Promise should be available during the retry window
      // (allow a tick for the async handleTargetClosed to start)
      await vi.waitFor(() => {
        expect(debuggerManager.reattachPromise(42)).not.toBeNull();
      }, { timeout: 100 });

      // Simulate relay sending contextRecoveryComplete after reattach succeeds
      // (in production, the server does Runtime.enable + createIsolatedWorld first)
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalled();
      }, { timeout: 2000 });
      // Small delay to let the reattach callback fire before sending confirmation
      await new Promise(r => setTimeout(r, 100));
      debuggerManager.notifyContextRecoveryComplete(42);

      // Promise resolves to true after context recovery confirmation
      const result = await debuggerManager.reattachPromise(42)!;
      expect(result).toBe(true);

      // After resolution, promise should be cleared
      expect(debuggerManager.reattachPromise(42)).toBeNull();
    });
  });

  describe('per-tab reattach isolation', () => {
    it('reattachPromise for tab A is independent of tab B', { timeout: 15000 }, async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://a.com' });
      await tabRegistry.upsertOnAttach(77, 1, { url: 'https://b.com' });
      seedTab({ id: 42, url: 'https://a.com', title: 'Tab A', windowId: 1 });
      seedTab({ id: 77, url: 'https://b.com', title: 'Tab B', windowId: 1 });

      const handler = getDetachHandler();

      // Trigger security-induced detach on tab 42 only
      handler({ tabId: 42 }, 'target_closed');

      await vi.waitFor(() => {
        expect(debuggerManager.reattachPromise(42)).not.toBeNull();
      }, { timeout: 100 });

      // Tab 77 should have no reattach promise
      expect(debuggerManager.reattachPromise(77)).toBeNull();

      // Simulate relay confirmation for tab 42
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalled();
      }, { timeout: 2000 });
      await new Promise(r => setTimeout(r, 100));
      debuggerManager.notifyContextRecoveryComplete(42);

      // Wait for tab 42 to complete
      const result = await debuggerManager.reattachPromise(42)!;
      expect(result).toBe(true);
    });

    it('security-detach for tab A does not block tab B operations', { timeout: 10000 }, async () => {
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://a.com' });
      await tabRegistry.upsertOnAttach(77, 1, { url: 'https://b.com' });
      seedTab({ id: 42, url: 'https://a.com', title: 'Tab A', windowId: 1 });
      seedTab({ id: 77, url: 'https://b.com', title: 'Tab B', windowId: 1 });

      // Make tab 42 reattach slow (fail then succeed) while tab 77 is untouched
      let attachCallCount = 0;
      (chrome.debugger.attach as any).mockImplementation(async (target: chrome.debugger.Debuggee) => {
        attachCallCount++;
        if (target.tabId === 42 && attachCallCount === 1) {
          // First attempt for tab 42 fails
          throw new Error('Temporarily unavailable');
        }
        // All other calls succeed
      });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      await vi.waitFor(() => {
        expect(debuggerManager.reattachPromise(42)).not.toBeNull();
      }, { timeout: 100 });

      // Tab 77 has no reattach pending — its commands should proceed normally
      expect(debuggerManager.reattachPromise(77)).toBeNull();
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
      await tabRegistry.upsertOnAttach(99, 1, {});
      seedTab({ id: 99, url: 'https://x.com' });

      // Track attach calls specifically for tab 99
      const tab99AttachCalls: number[] = [];
      (chrome.debugger.attach as any).mockImplementation(async (target: chrome.debugger.Debuggee) => {
        if (target.tabId === 99)
          tab99AttachCalls.push(target.tabId);
        throw new Error('attach failed');
      });

      const handler = getDetachHandler();
      handler({ tabId: 99 }, 'transient_reason');

      // After 3 failed attempts (with backoff), terminal callback fires
      await vi.waitFor(() => {
        expect(terminalCallback).toHaveBeenCalledWith(99, 'reattach_exhausted');
      }, { timeout: 15000 });

      // Should have attempted 3 times for this specific tab
      expect(tab99AttachCalls).toHaveLength(3);
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

  describe('context recovery signal (debuggerReattached + contextRecoveryComplete)', () => {
    it('emits debuggerReattached after successful security-induced reattach', { timeout: 10000 }, async () => {
      const reattachedCallback = vi.fn();
      debuggerManager.init(terminalCallback as any, reattachedCallback);

      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // Wait for reattach to succeed
      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 2000 });

      // reattachedCallback should fire after successful reattach
      await vi.waitFor(() => {
        expect(reattachedCallback).toHaveBeenCalledWith(42);
      }, { timeout: 2000 });
    });

    it('does NOT emit debuggerReattached on initial attach or transient (non-security) reattach', { timeout: 10000 }, async () => {
      const reattachedCallback = vi.fn();
      debuggerManager.init(terminalCallback as any, reattachedCallback);

      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      // canceled_by_user uses attemptReattach path, not handleTargetClosed
      handler({ tabId: 42 }, 'canceled_by_user');

      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      }, { timeout: 2000 });

      // reattachedCallback must NOT fire for transient paths
      expect(reattachedCallback).not.toHaveBeenCalled();
    });

    it('reattachPromise stays pending until contextRecoveryComplete arrives', { timeout: 10000 }, async () => {
      const reattachedCallback = vi.fn();
      debuggerManager.init(terminalCallback as any, reattachedCallback);

      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // Wait until reattach succeeded and promise is in pending-for-recovery state
      await vi.waitFor(() => {
        expect(reattachedCallback).toHaveBeenCalledWith(42);
      }, { timeout: 2000 });

      // Promise must still be pending (waiting for contextRecoveryComplete)
      const promise = debuggerManager.reattachPromise(42);
      expect(promise).not.toBeNull();

      let resolved = false;
      promise!.then(() => { resolved = true; });

      // Give one tick — promise should NOT have resolved yet
      await Promise.resolve();
      expect(resolved).toBe(false);

      // Now send contextRecoveryComplete — promise should resolve
      debuggerManager.notifyContextRecoveryComplete(42);

      const result = await promise!;
      expect(result).toBe(true);

      // Promise cleared after resolution
      expect(debuggerManager.reattachPromise(42)).toBeNull();
    });

    it('reattachPromise resolves via timeout if contextRecoveryComplete never arrives', { timeout: 30000 }, async () => {
      vi.useFakeTimers();
      try {
        const reattachedCallback = vi.fn();
        // Re-init with reattachedCallback (beforeEach called init without it)
        debuggerManager._resetForTesting();
        debuggerManager.init(terminalCallback as any, reattachedCallback);

        await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
        seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

        const handler = getDetachHandler();
        handler({ tabId: 42 }, 'target_closed');

        // Advance past the first reattach backoff delay (~500ms) and async tab check
        // This gets us to the point where handleTargetClosed has the reattachPromise
        // set but is waiting for the backoff delay before attaching.
        await vi.advanceTimersByTimeAsync(600);

        // Reattach should have been attempted by now
        await vi.waitFor(() => {
          expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
        }, { timeout: 500 });

        // After reattach, promise should be alive (waiting for context recovery)
        await vi.waitFor(() => {
          expect(reattachedCallback).toHaveBeenCalledWith(42);
        }, { timeout: 500 });

        const promise = debuggerManager.reattachPromise(42);
        expect(promise).not.toBeNull();

        // Advance past CONTEXT_RECOVERY_TIMEOUT_MS (10s) — promise resolves anyway
        await vi.advanceTimersByTimeAsync(11_000);

        const result = await promise!;
        expect(result).toBe(true);
        expect(debuggerManager.reattachPromise(42)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('contextRecoveryComplete for wrong tab does not unblock correct tab', { timeout: 10000 }, async () => {
      const reattachedCallback = vi.fn();
      debuggerManager.init(terminalCallback as any, reattachedCallback);

      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      await vi.waitFor(() => {
        expect(reattachedCallback).toHaveBeenCalledWith(42);
      }, { timeout: 2000 });

      const promise = debuggerManager.reattachPromise(42);
      expect(promise).not.toBeNull();

      // Send completion for a different tab — must not affect tab 42
      debuggerManager.notifyContextRecoveryComplete(99);

      let resolved = false;
      promise!.then(() => { resolved = true; });
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(debuggerManager.reattachPromise(42)).not.toBeNull();

      // Cleanup: send correct completion to avoid leaking promises
      debuggerManager.notifyContextRecoveryComplete(42);
      await promise!;
    });

    it('reattachPromise resolves false (no context signal) when security reattach exhausted', { timeout: 20000 }, async () => {
      const reattachedCallback = vi.fn();
      debuggerManager.init(terminalCallback as any, reattachedCallback);

      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://x.com' });
      seedTab({ id: 42, url: 'https://x.com', title: 'Test', windowId: 1 });

      // All reattach attempts fail
      (chrome.debugger.attach as any).mockRejectedValue(new Error('Cannot attach'));

      const handler = getDetachHandler();
      handler({ tabId: 42 }, 'target_closed');

      // Promise is set during security-induced path
      await vi.waitFor(() => {
        expect(debuggerManager.reattachPromise(42)).not.toBeNull();
      }, { timeout: 100 });

      const result = await debuggerManager.reattachPromise(42)!;
      expect(result).toBe(false);

      // reattachedCallback must NOT fire when reattach failed
      expect(reattachedCallback).not.toHaveBeenCalled();
      expect(terminalCallback).toHaveBeenCalledWith(42, 'target_closed');
    });
  });
});
