/**
 * Tab registry — persistent tab tracking via chrome.storage.local.
 *
 * Survives: service worker restart, browser restart, MCP server crash.
 * Tabs enter the registry only when the extension interacts with them
 * (debugger attach or explicit targeting). Unrelated user tabs are excluded.
 *
 * Protocol: responds to relay WS messages (registry:list, registry:focus).
 */

import { extLog } from './extensionLog';

export interface TabEntry {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  sessionId?: string;  // MCP session that owns this tab (for recovery after SW restart)
  status: 'active' | 'loading' | 'unloaded';
  debugger: {
    attached: boolean;
    lastAttached?: number;
    lastDetachReason?: string;
  };
  lastSeen: number;
}

type Registry = Record<string, TabEntry>;

const STORAGE_KEY = 'tabRegistry';

async function load(): Promise<Registry> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as Registry) || {};
}

async function save(registry: Registry): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: registry });
}

// --- Public API (called by background.ts) ---

export async function upsertOnAttach(tabId: number, windowId: number, tabInfo: { url?: string; title?: string; sessionId?: string }): Promise<void> {
  const registry = await load();
  const key = String(tabId);
  const existing = registry[key];
  registry[key] = {
    tabId,
    windowId,
    url: tabInfo.url || existing?.url || '',
    title: tabInfo.title || existing?.title || '',
    sessionId: tabInfo.sessionId || existing?.sessionId,
    status: 'active',
    debugger: {
      attached: true,
      lastAttached: Date.now(),
    },
    lastSeen: Date.now(),
  };
  await save(registry);
  extLog('registry','tabRegistry: upsert on attach', tabId);
}

export async function getBySessionId(sessionId: string): Promise<TabEntry | undefined> {
  const registry = await load();
  return Object.values(registry).find(entry => entry.sessionId === sessionId);
}

export async function getAll(): Promise<TabEntry[]> {
  const registry = await load();
  return Object.values(registry);
}

export async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId)
    await chrome.windows.update(tab.windowId, { focused: true });
}

export async function removeTab(tabId: number): Promise<void> {
  const registry = await load();
  delete registry[String(tabId)];
  await save(registry);
}

// --- Chrome event handlers (registered by background.ts) ---

export async function onTabRemoved(tabId: number): Promise<void> {
  await removeTab(tabId);
  extLog('registry','tabRegistry: removed', tabId);
}

// NOTE: Chrome fires tabs.onUpdated incrementally — url arrives before title.
// During in-tab navigation, the registry has the new URL but stale title for
// ~50-500ms until the HTML <title> is parsed. This is inherent to Chrome's
// event model and accepted as cosmetic. See titleLag.test.ts for characterization.
export async function onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo): Promise<void> {
  const registry = await load();
  const entry = registry[String(tabId)];
  if (!entry) return;
  if (changeInfo.url !== undefined) entry.url = changeInfo.url;
  if (changeInfo.title !== undefined) entry.title = changeInfo.title;
  if (changeInfo.status !== undefined) entry.status = changeInfo.status as TabEntry['status'];
  entry.lastSeen = Date.now();
  await save(registry);
}

export async function onTabActivated(tabId: number): Promise<void> {
  const registry = await load();
  const entry = registry[String(tabId)];
  if (!entry) return;
  entry.lastSeen = Date.now();
  await save(registry);
}

export async function onDebuggerDetach(tabId: number, reason: string): Promise<void> {
  const registry = await load();
  const entry = registry[String(tabId)];
  if (!entry) return;
  entry.debugger.attached = false;
  entry.debugger.lastDetachReason = reason;
  await save(registry);
  extLog('registry','tabRegistry: debugger detached', tabId, reason);
}

// --- Service worker restart reconciliation ---

export async function reconcile(): Promise<void> {
  const registry = await load();
  const liveTabs = await chrome.tabs.query({});
  const liveTabIds = new Set(liveTabs.map(t => t.id));

  let changed = false;
  for (const key of Object.keys(registry)) {
    const tabId = parseInt(key, 10);
    if (!liveTabIds.has(tabId)) {
      delete registry[key];
      changed = true;
      continue;
    }
    const liveTab = liveTabs.find(t => t.id === tabId);
    if (liveTab) {
      if (liveTab.url && liveTab.url !== registry[key].url) {
        registry[key].url = liveTab.url;
        changed = true;
      }
      if (liveTab.title && liveTab.title !== registry[key].title) {
        registry[key].title = liveTab.title;
        changed = true;
      }
    }
  }

  if (changed) {
    await save(registry);
    extLog('registry','tabRegistry: reconciled', Object.keys(registry).length, 'entries');
  }
}

// --- Relay protocol handler ---

export type RegistryMessage =
  | { type: 'registry:list' }
  | { type: 'registry:focus'; tabId: number };

export type RegistryResponse =
  | { type: 'registry:response'; tabs: TabEntry[] }
  | { type: 'registry:focusResult'; success: boolean; error?: string };

export async function handleRegistryMessage(message: RegistryMessage): Promise<RegistryResponse> {
  if (message.type === 'registry:list') {
    const tabs = await getAll();
    return { type: 'registry:response', tabs };
  }
  if (message.type === 'registry:focus') {
    try {
      await focusTab(message.tabId);
      return { type: 'registry:focusResult', success: true };
    } catch (error: any) {
      return { type: 'registry:focusResult', success: false, error: error.message };
    }
  }
  throw new Error(`Unknown registry message type: ${(message as any).type}`);
}
