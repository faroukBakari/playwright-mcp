/**
 * Multi-tab debugger state manager.
 *
 * Sole owner of all chrome.debugger.attach/detach calls (exception:
 * debuggerManager.ts owns reattach-on-security-detach, same tabId only).
 *
 * Every public method syncs internal state against Chrome ground truth
 * via getTargets() before operating — making the map self-healing across
 * SW restarts, missed onDetach events, and closed tabs.
 *
 * Single map: tabId → sessionId. Reverse lookup (sessionId → tabId)
 * is an O(n) scan — negligible at 1–10 concurrent sessions.
 *
 * Single-client compatibility: getDebuggee(undefined) with exactly one
 * entry returns that entry — no invented sessionIds, no dual code paths.
 */

import { extLog, extLogS } from './extensionLog';

export class TabManager {
  /** tabId → sessionId. Single source of truth. */
  private _tabToSession = new Map<number, string>();

  /** Tab IDs with a pending chrome.debugger.attach — immune to _syncTabs purge. */
  private _pendingAttach = new Set<number>();

  /** Reverse scan: sessionId → tabId. O(n), n ≤ 10. */
  private _tabForSession(sessionId: string): number | undefined {
    for (const [tabId, sid] of this._tabToSession) {
      if (sid === sessionId) return tabId;
    }
    return undefined;
  }

  /**
   * Sync internal map against Chrome ground truth.
   * Purges entries where Chrome says the debugger is no longer attached.
   * Logs if the operation takes >10ms.
   */
  private async _syncTabs(): Promise<void> {
    const start = performance.now();
    const targets = await chrome.debugger.getTargets();
    const attachedTabIds = new Set(
      targets.filter(t => t.attached && t.tabId != null).map(t => t.tabId!)
    );
    const staleTabs = [...this._tabToSession.keys()].filter(id => !attachedTabIds.has(id) && !this._pendingAttach.has(id));
    for (const tabId of staleTabs) {
      const sessionId = this._tabToSession.get(tabId)!;
      this._tabToSession.delete(tabId);
      extLog('tabManager', `_syncTabs: purged stale session=${sessionId} tab=${tabId}`);
    }
    const ms = performance.now() - start;
    if (ms > 10)
      extLog('tabManager', `_syncTabs: ${ms.toFixed(1)}ms (${this._tabToSession.size} sessions)`);
  }

  /**
   * Attach a session to a tab. Handles bump (previous owner detached) and
   * session move (same session, different tab) internally.
   *
   * Self-ownership: if sessionId already owns tabId, no-op.
   * Bump: if a different session owns tabId, it is detached first.
   * Attach failure: propagates error; map state is already consistent.
   */
  async attach(sessionId: string, tabId: number): Promise<{ debuggee: chrome.debugger.Debuggee }> {
    await this._syncTabs();

    // Self-ownership: already own this tab with this session — no-op
    const currentOwner = this._tabToSession.get(tabId);
    if (currentOwner === sessionId) {
      extLogS('tabManager', sessionId, `attach: no-op, already own tab ${tabId}`);
      return { debuggee: { tabId } };
    }

    // Clean old tab mapping if session was previously attached to a different tab
    const oldTab = this._tabForSession(sessionId);
    if (oldTab != null) {
      try {
        this._tabToSession.delete(oldTab);
        await chrome.debugger.detach({ tabId: oldTab });
      }
      catch (e: any) { extLog('tabManager', `session move: detach old tab ${oldTab} failed: ${e.message}`); }
    }

    // Bump: different session owns this tab → detach it internally
    if (currentOwner != null) {
      this._tabToSession.delete(tabId);
      await chrome.debugger.detach({ tabId });
      extLogS('tabManager', sessionId, `attach: bumped session ${currentOwner} from tab ${tabId}`);
    }

    // Attach
    const debuggee: chrome.debugger.Debuggee = { tabId };
    extLogS('tabManager', sessionId, `attach: chrome.debugger.attach tabId=${tabId}`);
    this._tabToSession.set(tabId, sessionId);
    this._pendingAttach.add(tabId);
    try {
      await chrome.debugger.attach(debuggee, '1.3');
    } catch (e) {
      this._tabToSession.delete(tabId);
      throw e;
    } finally {
      this._pendingAttach.delete(tabId);
    }
    extLog('tabManager', `attach: sessionId=${sessionId} tabId=${tabId} (${this._tabToSession.size} sessions)`);
    return { debuggee };
  }

  /**
   * Detach a session from Chrome and remove from map.
   * No-op if session not found.
   */

  async _detach(sessionId: string): Promise<void> {
    const tabId = this._tabForSession(sessionId);
    if (tabId == null) {
      extLog('tabManager', `detach: sessionId=${sessionId} not found, skipping`);
      return;
    }
    extLog('tabManager', `detach: sessionId=${sessionId} tabId=${tabId} (${this._tabToSession.size} remaining)`);
    await chrome.debugger.detach({ tabId });
    this._tabToSession.delete(tabId);
  }

  async detach(sessionId: string): Promise<void> {
    await this._syncTabs().then(() => this._detach(sessionId));
  }

  /**
   * Detach all sessions. Used on WS connection close to prevent
   * a 30s debugger lock window during the next reconnect.
   * Delegates to detach() per session. Failures are logged, not thrown.
   */
  async detachAll(): Promise<void> {
    const sessionIds = [...this._tabToSession.values()];
    extLog('tabManager', `detachAll: detaching ${sessionIds.length} sessions`);
    await Promise.allSettled(sessionIds.map(sid => this._detach(sid)));
  }

  /**
   * Look up the debuggee for a sessionId.
   * - If sessionId provided → scan for matching session.
   * - If undefined + exactly 1 entry → return that entry (single-client compat).
   * - Otherwise → undefined.
   */
  async getDebuggee(sessionId?: string): Promise<chrome.debugger.Debuggee | undefined> {
    await this._syncTabs();
    if (sessionId != null) {
      const tabId = this._tabForSession(sessionId);
      return tabId != null ? { tabId } : undefined;
    }
    if (this._tabToSession.size === 1) {
      const tabId = this._tabToSession.keys().next().value!;
      return { tabId };
    }
    return undefined;
  }

  /**
   * Reverse lookup: tabId → sessionId. Used for event routing.
   */
  async getSessionForTab(tabId: number): Promise<string | undefined> {
    await this._syncTabs();
    return this._tabToSession.get(tabId);
  }

  /**
   * Remove a session by its tabId (e.g., tab closure event).
   * State-only removal — Chrome already closed the tab.
   * Returns the sessionId that was removed, or undefined.
   */
  async removeByTab(tabId: number): Promise<string | undefined> {
    await this._syncTabs();
    const sessionId = this._tabToSession.get(tabId);
    if (sessionId == null)
      return undefined;
    this._tabToSession.delete(tabId);
    extLog('tabManager', `removeByTab: tabId=${tabId} sessionId=${sessionId} (${this._tabToSession.size} remaining)`);
    return sessionId;
  }

  /** All session→tabId mappings. Used by listTabs for enrichment. */
  async getAllSessions(): Promise<Array<{ sessionId: string; tabId: number }>> {
    await this._syncTabs();
    return [...this._tabToSession.entries()].map(([tabId, sessionId]) => ({ sessionId, tabId }));
  }

  /** Tab IDs of all connected sessions. Test-only helper. */
  async getConnectedTabIds(): Promise<number[]> {
    await this._syncTabs();
    return [...this._tabToSession.keys()];
  }

  /** Number of attached sessions. Syncs before counting. */
  async getSize(): Promise<number> {
    await this._syncTabs();
    return this._tabToSession.size;
  }
}
