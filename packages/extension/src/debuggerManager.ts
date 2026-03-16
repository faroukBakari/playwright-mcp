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
 *   target_closed           → remove from registry, terminal
 *   canceled_by_user        → mark detached, terminal (user opened DevTools)
 *   replaced_with_devtools  → delayed-terminal: one-shot reattach after 1s
 *                             (recovers from antivirus/extension interference;
 *                              falls through to terminal if reattach fails)
 *   any other               → reattach with exponential backoff (max 3 attempts)
 *
 * Wired in background.ts. Owns the chrome.debugger.onDetach listener
 * (RelayConnection's listener is removed to prevent premature WS closure).
 */

import { debugLog } from './relayConnection';
import * as tabRegistry from './tabRegistry';

type TerminalDetachCallback = (tabId: number, reason: string) => void;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

const TERMINAL_REASONS = new Set([
  'canceled_by_user',
]);

// Delayed-terminal: one-shot reattach attempt after a delay. If reattach
// succeeds, the detach was transient (e.g., Kaspersky grabbed the debugger
// briefly). If it fails, proceed with terminal teardown.
const DELAYED_TERMINAL_REASONS = new Set([
  'replaced_with_devtools',
]);

const DELAYED_REATTACH_MS = 1000;

let _onTerminalDetach: TerminalDetachCallback | undefined;

/**
 * Initialize the debugger manager. Must be called once from background.ts.
 * @param onTerminalDetach Called when a tab's debugger is terminally lost
 *        (target closed, user intervention, or retries exhausted).
 *        background.ts uses this to close the active RelayConnection.
 */
export function init(onTerminalDetach: TerminalDetachCallback): void {
  _onTerminalDetach = onTerminalDetach;
  chrome.debugger.onDetach.addListener(handleDetach);
}

function handleDetach(source: chrome.debugger.Debuggee, reason: string): void {
  const tabId = source.tabId;
  if (!tabId)
    return;

  debugLog(`debuggerManager: detach event for tab ${tabId}, reason: ${reason}`);

  // Always update registry first
  tabRegistry.onDebuggerDetach(tabId, reason);

  if (reason === 'target_closed') {
    // Tab is gone — nothing to reattach to
    tabRegistry.removeTab(tabId);
    _onTerminalDetach?.(tabId, reason);
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

async function attemptReattach(tabId: number, attempt: number): Promise<void> {
  if (attempt >= MAX_RETRIES) {
    debugLog(`debuggerManager: reattach failed after ${MAX_RETRIES} attempts for tab ${tabId}`);
    _onTerminalDetach?.(tabId, 'reattach_exhausted');
    return;
  }

  // Exponential backoff with jitter: base * 2^attempt * [0.5, 1.0)
  const delay = BASE_DELAY_MS * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
  debugLog(`debuggerManager: reattach attempt ${attempt + 1}/${MAX_RETRIES} for tab ${tabId} in ${Math.round(delay)}ms`);

  await new Promise(resolve => setTimeout(resolve, delay));

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debugLog(`debuggerManager: reattached to tab ${tabId}`);
    // Update registry with fresh tab info
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await tabRegistry.upsertOnAttach(tabId, tab?.windowId ?? 0, {
      url: tab?.url,
      title: tab?.title,
    });
  } catch (error: any) {
    debugLog(`debuggerManager: reattach attempt ${attempt + 1} failed: ${error.message}`);
    await attemptReattach(tabId, attempt + 1);
  }
}

async function attemptDelayedReattach(tabId: number, originalReason: string): Promise<void> {
  debugLog(`debuggerManager: delayed reattach for tab ${tabId} (reason: ${originalReason}) in ${DELAYED_REATTACH_MS}ms`);
  await new Promise(resolve => setTimeout(resolve, DELAYED_REATTACH_MS));

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    debugLog(`debuggerManager: delayed reattach succeeded for tab ${tabId} — recovered from transient ${originalReason}`);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    await tabRegistry.upsertOnAttach(tabId, tab?.windowId ?? 0, {
      url: tab?.url,
      title: tab?.title,
    });
  } catch (error: any) {
    debugLog(`debuggerManager: delayed reattach failed for tab ${tabId}: ${error.message} — treating as terminal`);
    _onTerminalDetach?.(tabId, originalReason);
  }
}
