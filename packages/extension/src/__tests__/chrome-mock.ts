/**
 * Chrome API mock for vitest unit tests.
 *
 * Provides in-memory implementations of chrome.storage.local,
 * chrome.tabs, chrome.windows, chrome.debugger, chrome.action,
 * and chrome.runtime. Resets between tests via beforeEach.
 */

import { vi, beforeEach } from 'vitest';

// --- In-memory storage ---

let storageData: Record<string, any> = {};

const storageLocal = {
  get: vi.fn(async (keys: string | string[]) => {
    if (typeof keys === 'string') keys = [keys];
    const result: Record<string, any> = {};
    for (const k of keys) {
      if (k in storageData) result[k] = storageData[k];
    }
    return result;
  }),
  set: vi.fn(async (items: Record<string, any>) => {
    Object.assign(storageData, items);
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    if (typeof keys === 'string') keys = [keys];
    for (const k of keys) delete storageData[k];
  }),
  clear: vi.fn(async () => { storageData = {}; }),
};

// --- Tabs ---

let tabStore: Map<number, chrome.tabs.Tab> = new Map();

export function seedTab(tab: Partial<chrome.tabs.Tab> & { id: number }): void {
  tabStore.set(tab.id, {
    index: tab.index ?? 0,
    pinned: tab.pinned ?? false,
    highlighted: tab.highlighted ?? false,
    windowId: tab.windowId ?? 1,
    active: tab.active ?? false,
    incognito: tab.incognito ?? false,
    selected: tab.selected ?? false,
    discarded: tab.discarded ?? false,
    autoDiscardable: tab.autoDiscardable ?? true,
    groupId: tab.groupId ?? -1,
    url: tab.url ?? 'about:blank',
    title: tab.title ?? '',
    ...tab,
  } as chrome.tabs.Tab);
}

const tabs = {
  query: vi.fn(async (_queryInfo: chrome.tabs.QueryInfo) => {
    return Array.from(tabStore.values());
  }),
  get: vi.fn(async (tabId: number) => {
    const tab = tabStore.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }),
  update: vi.fn(async (tabId: number, _props: chrome.tabs.UpdateProperties) => {
    const tab = tabStore.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }),
  create: vi.fn(async (_props: chrome.tabs.CreateProperties) => {
    return { id: 9999 } as chrome.tabs.Tab;
  }),
  onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
  onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
};

// --- Windows ---

const windows = {
  update: vi.fn(async (_windowId: number, _updateInfo: chrome.windows.UpdateInfo) => {}),
};

// --- Debugger ---

let attachedDebuggees: Set<number> = new Set();

const debuggerApi = {
  attach: vi.fn(async (target: chrome.debugger.Debuggee, _version: string) => {
    if (target.tabId != null) attachedDebuggees.add(target.tabId);
  }),
  detach: vi.fn(async (target: chrome.debugger.Debuggee) => {
    if (target.tabId != null) attachedDebuggees.delete(target.tabId);
  }),
  sendCommand: vi.fn(async (_target: chrome.debugger.Debuggee, _method: string, _params?: any) => {
    return { targetInfo: { type: 'page', targetId: 'mock-target' } };
  }),
  // Returns DebuggerInfo for all currently attached tabs.
  // Default implementation derives from attachedDebuggees so _syncTabs()
  // is transparent in tests that don't explicitly override getTargets.
  getTargets: vi.fn(async (): Promise<chrome.debugger.TargetInfo[]> => {
    return [...attachedDebuggees].map(tabId => ({
      attached: true,
      tabId,
      id: `target-${tabId}`,
      type: 'page' as chrome.debugger.TargetInfoType,
      title: '',
      url: '',
      faviconUrl: '',
    }));
  }),
  onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
  onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
};

// --- Action ---

const action = {
  setBadgeText: vi.fn(async () => {}),
  setBadgeBackgroundColor: vi.fn(async () => {}),
  setTitle: vi.fn(async () => {}),
  onClicked: { addListener: vi.fn() },
};

// --- Runtime ---

const runtime = {
  onMessage: { addListener: vi.fn() },
  getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
};

// --- Wire into global ---

(globalThis as any).chrome = {
  storage: { local: storageLocal },
  tabs,
  windows,
  debugger: debuggerApi,
  action,
  runtime,
};

// --- Reset between tests ---

beforeEach(() => {
  storageData = {};
  tabStore = new Map();
  attachedDebuggees = new Set();
  vi.clearAllMocks();

  // Re-wire mock implementations after clearAllMocks
  storageLocal.get.mockImplementation(async (keys: string | string[]) => {
    if (typeof keys === 'string') keys = [keys];
    const result: Record<string, any> = {};
    for (const k of keys) {
      if (k in storageData) result[k] = storageData[k];
    }
    return result;
  });
  storageLocal.set.mockImplementation(async (items: Record<string, any>) => {
    Object.assign(storageData, items);
  });
  storageLocal.remove.mockImplementation(async (keys: string | string[]) => {
    if (typeof keys === 'string') keys = [keys];
    for (const k of keys) delete storageData[k];
  });
  storageLocal.clear.mockImplementation(async () => { storageData = {}; });

  tabs.query.mockImplementation(async () => Array.from(tabStore.values()));
  tabs.get.mockImplementation(async (tabId: number) => {
    const tab = tabStore.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  });
  tabs.update.mockImplementation(async (tabId: number) => {
    const tab = tabStore.get(tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  });

  debuggerApi.attach.mockImplementation(async (target: chrome.debugger.Debuggee) => {
    if (target.tabId != null) attachedDebuggees.add(target.tabId);
  });
  debuggerApi.detach.mockImplementation(async (target: chrome.debugger.Debuggee) => {
    if (target.tabId != null) attachedDebuggees.delete(target.tabId);
  });
  debuggerApi.getTargets.mockImplementation(async (): Promise<chrome.debugger.TargetInfo[]> => {
    return [...attachedDebuggees].map(tabId => ({
      attached: true,
      tabId,
      id: `target-${tabId}`,
      type: 'page' as chrome.debugger.TargetInfoType,
      title: '',
      url: '',
      faviconUrl: '',
    }));
  });
});

export { storageData, tabStore, attachedDebuggees };
