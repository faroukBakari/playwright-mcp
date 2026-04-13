/**
 * Debugger auto-reattach manager.
 *
 * When Chrome drops the CDP debugger, evaluates whether to automatically
 * reattach. Calls chrome.debugger.attach() directly — NOT through
 * RelayConnection (which has a one-shot setTabId). RelayConnection is
 * unaware of reattach cycles; it sees CDP commands flowing normally
 * because the target { tabId } hasn't changed.
 *
 * Decision matrix:
 *   target_closed + tab gone   → remove from registry, terminal
 *   target_closed + tab alive  → security-induced detach (e.g., Kaspersky
 *                                injected a chrome-extension:// iframe).
 *                                Exponential backoff (3 attempts, 500ms base,
 *                                5s max). RelayConnection awaits
 *                                reattachPromise(tabId) to hold & retry commands.
 *                                After reattach, emits debuggerReattached to relay
 *                                and holds reattachPromise until contextRecoveryComplete
 *                                arrives (or CONTEXT_RECOVERY_TIMEOUT_MS elapses).
 *   canceled_by_user           → transient: reattach with backoff (Cancel only
 *                                detaches chrome.debugger, WS stays alive)
 *   replaced_with_devtools     → delayed-terminal: one-shot reattach after 1s
 *                                (recovers from antivirus/extension interference;
 *                                 falls through to terminal if reattach fails)
 *   any other                  → reattach with exponential backoff (max 3 attempts)
 *
 * Wired in background.ts. Owns the chrome.debugger.onDetach listener
 * (RelayConnection's listener is removed to prevent premature WS closure).
 */

import { extLog } from './extensionLog';
import * as tabRegistry from './tabRegistry';

type TerminalDetachCallback = (tabId: number, reason: string) => void;
type ReattachedCallback = (tabId: number) => void;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// canceled_by_user intentionally excluded — Cancel only detaches chrome.debugger,
// the WebSocket stays alive. Reattach succeeds in most cases. See docs/session-management.md.
const TERMINAL_REASONS: Set<string> = new Set([
]);

// Delayed-terminal: one-shot reattach attempt after a delay. If reattach
// succeeds, the detach was transient (e.g., Kaspersky grabbed the debugger
// briefly). If it fails, proceed with terminal teardown.
const DELAYED_TERMINAL_REASONS = new Set([
  'replaced_with_devtools',
]);

const DELAYED_REATTACH_MS = 1000;
const SECURITY_REATTACH_MAX_RETRIES = 3;
const SECURITY_REATTACH_BASE_MS = 500;
const SECURITY_REATTACH_MAX_MS = 5000;

// How long to wait for contextRecoveryComplete from the relay before
// resolving reattachPromise anyway. Prevents blocking CDP commands forever
// if the relay doesn't implement the confirmation protocol.
const CONTEXT_RECOVERY_TIMEOUT_MS = 10_000;

let _onTerminalDetach: TerminalDetachCallback | undefined;
// Called after a successful security-induced reattach — RelayConnection uses
// this to emit debuggerReattached upstream to the relay server.
let _onDebuggerReattached: ReattachedCallback | undefined;

// Per-tab reattach promises — RelayConnection awaits reattachPromise(tabId)
// to hold & retry in-flight CDP commands during security-induced detaches.
// The promise resolves only after contextRecoveryComplete is received from
// the relay (or CONTEXT_RECOVERY_TIMEOUT_MS elapses as a safety fallback).
// Note: each handleTargetClosed invocation captures its resolver locally;
// this map is only for external lookup via reattachPromise(tabId).
const _reattachPromises = new Map<number, Promise<boolean>>();

// Per-tab context-recovery resolvers — set when awaiting contextRecoveryComplete
// after a successful security-induced reattach.
const _contextRecoveryResolves = new Map<number, () => void>();

/**
 * Returns a promise that resolves to true when debugger reattach AND context
 * recovery both complete for the given tab, or false when reattach fails.
 * Returns null when no reattach is in progress for that tab.
 * RelayConnection uses this to decide whether to retry failed CDP commands.
 */
export function reattachPromise(tabId: number): Promise<boolean> | null {
  return _reattachPromises.get(tabId) ?? null;
}

/**
 * Reset all module-level state. FOR TESTING ONLY — do not call in production.
 */
export function _resetForTesting(): void {
  _onTerminalDetach = undefined;
  _onDebuggerReattached = undefined;
  _reattachPromises.clear();
  _contextRecoveryResolves.clear();
}

/**
 * Called by RelayConnection when the relay sends contextRecoveryComplete for
 * a tab. Unblocks any pending reattachPromise for that tab.
 */
export function notifyContextRecoveryComplete(tabId: number): void {
  const resolve = _contextRecoveryResolves.get(tabId);
  if (resolve) {
    extLog('debugger', `debuggerManager: contextRecoveryComplete received for tab ${tabId} — unblocking reattachPromise`);
    _contextRecoveryResolves.delete(tabId);
    resolve();
  }
}

/**
 * Initialize the debugger manager. Must be called once from background.ts.
 * @param onTerminalDetach Called when a tab's debugger is terminally lost
 *        (target closed, user intervention, or retries exhausted).
 *        background.ts uses this to close the active RelayConnection.
 * @param onDebuggerReattached Optional. Called after a successful
 *        security-induced reattach. RelayConnection uses this to emit
 *        debuggerReattached to the relay server, triggering context recovery.
 */
export function init(onTerminalDetach: TerminalDetachCallback, onDebuggerReattached?: ReattachedCallback): void {
  _onTerminalDetach = onTerminalDetach;
  _onDebuggerReattached = onDebuggerReattached;
  chrome.debugger.onDetach.addListener(handleDetach);
}

function handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
  const tabId = source.tabId;
  if (!tabId)
    return;

  extLog('debugger', `debuggerManager: detach event for tab ${tabId}, reason: ${reason}`);

  // Always update registry first
  tabRegistry.onDebuggerDetach(tabId, reason);

  if (reason === 'target_closed') {
    // Check if the tab is actually gone, or if a security product (e.g.,
    // Kaspersky) caused Chrome to detach by injecting a chrome-extension://
    // iframe. Chrome reports this as target_closed even though the tab is alive.
    void handleTargetClosed(tabId);
    return;
  }

  if (TERMINAL_REASONS.has(reason)) {
    // User intentionally opened DevTools — respect their intent
    _onTerminalDetach?.(tabId, reason);
    return;
  }

  if (DELAYED_TERMINAL_REASONS.has(reason)) {
    // Could be DevTools (terminal) or antivirus/extension interference (transient).
    // One-shot delayed reattach: if the interfering extension releases the debugger,
    // reattach succeeds and we recover silently. If not, fall through to terminal.
    void attemptDelayedReattach(tabId, reason);
    return;
  }

  // Transient detach — attempt reattach with backoff
  void attemptReattach(tabId, 0);
}

async function handleTargetClosed(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    // Tab is genuinely gone — terminal
    extLog('debugger', `debuggerManager: tab ${tabId} confirmed closed — terminal`);
    tabRegistry.removeTab(tabId);
    _onTerminalDetach?.(tabId, 'target_closed');
    return;
  }

  // Tab is alive — security-induced detach (Kaspersky iframe injection, etc.)
  // Create a per-tab promise so RelayConnection can hold & retry in-flight commands.
  // Capture the resolver locally — never look it up from the map after creation,
  // which prevents a concurrent invocation from receiving the wrong resolution.
  extLog('debugger', `debuggerManager: tab ${tabId} still alive — security-induced detach, attempting recovery`);
  let localResolve!: (success: boolean) => void;
  const promise = new Promise<boolean>(resolve => { localResolve = resolve; });
  // Expose via map so RelayConnection's reattachPromise(tabId) can find it.
  // We set the map before any await so the caller can observe it immediately.
  _reattachPromises.set(tabId, promise);

  let succeeded = false;
  for (let attempt = 0; attempt < SECURITY_REATTACH_MAX_RETRIES; attempt++) {
    const delay = Math.min(
      SECURITY_REATTACH_BASE_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5),
      SECURITY_REATTACH_MAX_MS
    );
    extLog('debugger', `debuggerManager: security reattach attempt ${attempt + 1}/${SECURITY_REATTACH_MAX_RETRIES} in ${Math.round(delay)}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      extLog('debugger', `debuggerManager: security reattach succeeded for tab ${tabId}`);
      const freshTab = await chrome.tabs.get(tabId).catch(() => null);
      await tabRegistry.upsertOnAttach(tabId, freshTab?.windowId ?? 0, {
        url: freshTab?.url,
        title: freshTab?.title,
      });
      succeeded = true;
      break;
    } catch (error: any) {
      extLog('debugger', `debuggerManager: security reattach attempt ${attempt + 1} failed: ${error.message}`);
    }
  }

  if (!succeeded) {
    _reattachPromises.delete(tabId);
    localResolve(false);
    extLog('debugger', `debuggerManager: security reattach exhausted for tab ${tabId} — terminal`);
    tabRegistry.removeTab(tabId);
    _onTerminalDetach?.(tabId, 'target_closed');
    return;
  }

  // Emit debuggerReattached signal to relay. The relay will initiate context
  // recovery on the server side and respond with contextRecoveryComplete.
  // Hold reattachPromise until confirmation arrives (or timeout elapses),
  // so in-flight CDP commands don't retry before contexts are ready.
  _onDebuggerReattached?.(tabId);

  await _waitForContextRecovery(tabId);

  // Clean up map after resolution — the promise must remain findable during
  // the context recovery wait so RelayConnection can still observe it.
  _reattachPromises.delete(tabId);
  localResolve(true);
}

/**
 * Wait for contextRecoveryComplete from relay, with a timeout safety net.
 * Populates _contextRecoveryResolves[tabId] while pending so that
 * notifyContextRecoveryComplete() can unblock it early.
 */
async function _waitForContextRecovery(tabId: number): Promise<void> {
  await new Promise<void>(resolve => {
    let settled = false;
    const done = () => {
      if (settled)
        return;
      settled = true;
      _contextRecoveryResolves.delete(tabId);
      resolve();
    };

    _contextRecoveryResolves.set(tabId, done);

    // Safety timeout — resolve anyway if relay never responds
    setTimeout(() => {
      if (!settled) {
        extLog('debugger', `debuggerManager: contextRecoveryComplete timeout for tab ${tabId} — resolving reattachPromise anyway`);
        done();
      }
    }, CONTEXT_RECOVERY_TIMEOUT_MS);
  });
}

async function attemptReattach(tabId: number, attempt: number): Promise<void> {
  if (attempt >= MAX_RETRIES) {
    extLog('debugger', `debuggerManager: reattach failed after ${MAX_RETRIES} attempts for tab ${tabId}`);
    _onTerminalDetach?.(tabId, 'reattach_exhausted');
    return;
  }

  // Exponential backoff with jitter: base * 2^attempt * [0.5, 1.0)
  const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
  extLog('debugger', `debuggerManager: reattach attempt ${attempt + 1}/${MAX_RETRIES} for tab ${tabId} in ${Math.round(delay)}ms`);

  await new Promise(resolve => setTimeout(resolve, delay));

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    extLog('debugger', `debuggerManager: reattached to tab ${tabId}`);
    // Update registry with fresh tab info
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await tabRegistry.upsertOnAttach(tabId, tab?.windowId ?? 0, {
      url: tab?.url,
      title: tab?.title,
    });
  } catch (error: any) {
    extLog('debugger', `debuggerManager: reattach attempt ${attempt + 1} failed: ${error.message}`);
    await attemptReattach(tabId, attempt + 1);
  }
}

async function attemptDelayedReattach(tabId: number, originalReason: string): Promise<void> {
  extLog('debugger', `debuggerManager: delayed reattach for tab ${tabId} (reason: ${originalReason}) in ${DELAYED_REATTACH_MS}ms`);
  await new Promise(resolve => setTimeout(resolve, DELAYED_REATTACH_MS));

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    extLog('debugger', `debuggerManager: delayed reattach succeeded for tab ${tabId} — recovered from transient ${originalReason}`);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await tabRegistry.upsertOnAttach(tabId, tab?.windowId ?? 0, {
      url: tab?.url,
      title: tab?.title,
    });
  } catch (error: any) {
    extLog('debugger', `debuggerManager: delayed reattach failed for tab ${tabId}: ${error.message} — treating as terminal`);
    _onTerminalDetach?.(tabId, originalReason);
  }
}
