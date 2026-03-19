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

import { extLog } from './extensionLog';

export class TabManager {
  /** sessionId → debuggee */
  private _sessions = new Map<string, chrome.debugger.Debuggee>();
  /** tabId → sessionId (reverse lookup for event routing) */
  private _tabToSession = new Map<number, string>();

  /**
   * Register a session's debugger attachment to a tab.
   * Returns the debuggee object for use with chrome.debugger APIs.
   */
  attach(sessionId: string, tabId: number): chrome.debugger.Debuggee {
    // If this sessionId was previously attached to a different tab, clean up
    const existing = this._sessions.get(sessionId);
    if (existing?.tabId != null)
      this._tabToSession.delete(existing.tabId);

    const debuggee: chrome.debugger.Debuggee = { tabId };
    this._sessions.set(sessionId, debuggee);
    this._tabToSession.set(tabId, sessionId);
    extLog('tabManager', `attach: sessionId=${sessionId} tabId=${tabId} (${this._sessions.size} sessions)`);
    return debuggee;
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

    await chrome.debugger.detach(debuggee).catch(() => {});
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
        entries.map(([, debuggee]) => chrome.debugger.detach(debuggee).catch(() => {}))
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
}
