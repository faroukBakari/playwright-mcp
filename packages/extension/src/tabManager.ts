/**
 * Multi-tab debugger state manager.
 *
 * Owns the mapping between relay-provided sessionIds and chrome.debugger
 * attachments (one per tab). No WS awareness, no protocol knowledge —
 * pure state management.
 *
 * Single-client compatibility: getDebuggee(undefined) with exactly one
 * entry returns that entry — no invented sessionIds, no dual code paths.
 */

import { extLog, extLogS, extError, extErrorS } from './extensionLog';

export class TabManager {
  /** sessionId → debuggee */
  private _sessions = new Map<string, chrome.debugger.Debuggee>();
  /** tabId → sessionId (reverse lookup for event routing) */
  private _tabToSession = new Map<number, string>();

  /**
   * Register a session's debugger attachment to a tab.
   * If another session already owns this tab, bumps it first.
   * Returns the debuggee object for use with chrome.debugger APIs.
   */
  attach(sessionId: string, tabId: number): { debuggee: chrome.debugger.Debuggee; bumpedSessionId?: string; bumpedDebuggee?: chrome.debugger.Debuggee } {
    // If this sessionId was previously attached to a different tab, clean up
    const existing = this._sessions.get(sessionId);
    if (existing?.tabId != null)
      this._tabToSession.delete(existing.tabId);

    // Bump: if another session owns this tab, evict it.
    // Capture the debuggee BEFORE deleting so the caller can call
    // chrome.debugger.detach(bumpedDebuggee) directly — detach(sessionId)
    // would find nothing after the delete.
    let bumpedSessionId: string | undefined;
    let bumpedDebuggee: chrome.debugger.Debuggee | undefined;
    const previousOwner = this._tabToSession.get(tabId);
    if (previousOwner != null && previousOwner !== sessionId) {
      bumpedSessionId = previousOwner;
      bumpedDebuggee = this._sessions.get(previousOwner);
      this._sessions.delete(previousOwner);
      extLogS('tabManager', sessionId, `bumped session ${previousOwner} from tab ${tabId}`);
    }

    const debuggee: chrome.debugger.Debuggee = { tabId };
    this._sessions.set(sessionId, debuggee);
    this._tabToSession.set(tabId, sessionId);
    extLog('tabManager', `attach: sessionId=${sessionId} tabId=${tabId} (${this._sessions.size} sessions)`);
    return { debuggee, bumpedSessionId, bumpedDebuggee };
  }

  /**
   * Detach a session by sessionId. Calls chrome.debugger.detach.
   * Returns the tabId that was detached, or null if not found.
   */
  async detach(sessionId: string): Promise<number | null> {
    const debuggee = this._sessions.get(sessionId);
    if (!debuggee || debuggee.tabId == null)
      return null;

    const tabId = debuggee.tabId;
    this._sessions.delete(sessionId);
    this._tabToSession.delete(tabId);
    extLog('tabManager', `detach: sessionId=${sessionId} tabId=${tabId} (${this._sessions.size} remaining)`);

    try {
      await chrome.debugger.detach(debuggee);
      extLogS('tabManager', sessionId, `chrome.debugger.detach success tabId=${tabId}`);
    } catch (e: any) {
      extErrorS('tabManager', sessionId, `chrome.debugger.detach failed tabId=${tabId}: ${e.message}`);
    }
    return tabId;
  }

  /**
   * Detach all sessions. Used on connection close.
   */
  async detachAll(): Promise<void> {
    const entries = [...this._sessions.entries()];
    this._sessions.clear();
    this._tabToSession.clear();
    extLog('tabManager', `detachAll: detaching ${entries.length} sessions`);
    await Promise.all(
        entries.map(([sessionId, debuggee]) =>
          chrome.debugger.detach(debuggee)
            .then(() => extLogS('tabManager', sessionId, `chrome.debugger.detach success tabId=${debuggee.tabId}`))
            .catch((e: any) => extErrorS('tabManager', sessionId, `chrome.debugger.detach failed tabId=${debuggee.tabId}: ${e.message}`))
        )
    );
  }

  /**
   * Look up the debuggee for a sessionId.
   * - If sessionId provided → direct lookup.
   * - If undefined + exactly 1 entry → return that entry (single-client compat).
   * - Otherwise → undefined.
   */
  getDebuggee(sessionId?: string): chrome.debugger.Debuggee | undefined {
    if (sessionId != null)
      return this._sessions.get(sessionId);
    if (this._sessions.size === 1)
      return this._sessions.values().next().value;
    return undefined;
  }

  /**
   * Reverse lookup: tabId → sessionId. Used for event routing.
   */
  getSessionForTab(tabId: number): string | undefined {
    return this._tabToSession.get(tabId);
  }

  /**
   * Remove a session by its tabId (e.g., tab closure).
   * Returns the sessionId that was removed, or undefined.
   */
  removeByTab(tabId: number): string | undefined {
    const sessionId = this._tabToSession.get(tabId);
    if (sessionId == null)
      return undefined;
    this._tabToSession.delete(tabId);
    this._sessions.delete(sessionId);
    extLog('tabManager', `removeByTab: tabId=${tabId} sessionId=${sessionId} (${this._sessions.size} remaining)`);
    return sessionId;
  }

  /** Tab IDs of all connected sessions. */
  get connectedTabIds(): number[] {
    return [...this._tabToSession.keys()];
  }

  /** Number of attached sessions. */
  get size(): number {
    return this._sessions.size;
  }

  /** All session→tabId mappings. Used by listTabs for enrichment. */
  getAllSessions(): Array<{ sessionId: string; tabId: number }> {
    return [...this._sessions.entries()]
      .filter(([, d]) => d.tabId != null)
      .map(([sessionId, d]) => ({ sessionId, tabId: d.tabId! }));
  }
}
