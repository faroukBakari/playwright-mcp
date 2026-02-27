/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function debugLog(...args: unknown[]): void {
  const enabled = true;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

// Extensions that hijack chrome.debugger (e.g. Kaspersky Safe Money).
// Disabled while our debugger session is active, re-enabled on disconnect.
const INTERFERING_EXTENSIONS = [
  'ahkjpbeeocnddjkakilopmfdlnjdpcdm', // Kaspersky Protection
];

export async function setInterferingExtensions(enabled: boolean): Promise<void> {
  for (const id of INTERFERING_EXTENSIONS) {
    try {
      await chrome.management.setEnabled(id, enabled);
      debugLog(`${enabled ? 'Re-enabled' : 'Disabled'} interfering extension ${id}`);
    } catch (e: any) {
      debugLog(`Could not ${enabled ? 'enable' : 'disable'} extension ${id}:`, e.message);
    }
  }
}

type TabRegistryEntry = {
  tabId: number;
  url: string;
  title: string;
  timestamp: number;
};

export async function updateTabRegistry(tab: chrome.tabs.Tab): Promise<void> {
  const stored = await chrome.storage.local.get('tabRegistry');
  let entries: TabRegistryEntry[] = stored['tabRegistry'] || [];
  entries = entries.filter(e => e.tabId !== tab.id);
  entries.push({
    tabId: tab.id!,
    url: tab.url || '',
    title: tab.title || '',
    timestamp: Date.now(),
  });
  if (entries.length > 20)
    entries = entries.slice(-20);
  await chrome.storage.local.set({ tabRegistry: entries });
}

type ProtocolCommand = {
  id: number;
  method: string;
  params?: any;
};

type ProtocolResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

export class RelayConnection {
  private _debuggee: chrome.debugger.Debuggee;
  private _ws: WebSocket;
  private _eventListener: (source: chrome.debugger.DebuggerSession, method: string, params: any) => void;
  private _detachListener: (source: chrome.debugger.Debuggee, reason: string) => void;
  private _tabPromise: Promise<void>;
  private _tabPromiseResolve!: () => void;
  private _closed = false;
  private _reattaching = false;
  private _degraded = false;
  private _backgroundRetryTimer: ReturnType<typeof setTimeout> | null = null;

  onclose?: () => void;

  constructor(ws: WebSocket) {
    this._debuggee = { };
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    // Store listeners for cleanup
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);
  }

  // Either setTabId or close is called after creating the connection.
  setTabId(tabId: number): void {
    this._debuggee = { tabId };
    this._tabPromiseResolve();
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    if (this._backgroundRetryTimer) {
      clearTimeout(this._backgroundRetryTimer);
      this._backgroundRetryTimer = null;
    }
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {});
    this.onclose?.();
  }

  private _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    if (source.tabId !== this._debuggee.tabId)
      return;
    // Drop events during debugger instability — they may carry incomplete data
    // (e.g. Page.frameNavigated without url) that crashes Playwright.
    if (this._degraded || this._reattaching) {
      debugLog('Dropping CDP event (degraded/reattaching):', method);
      return;
    }
    debugLog('Forwarding CDP event:', method, params);
    const sessionId = source.sessionId;
    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        sessionId,
        method,
        params,
      },
    });
  }

  private _onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (source.tabId !== this._debuggee.tabId)
      return;
    // Non-recoverable: tab is gone
    if (reason === 'target_closed') {
      debugLog('Debugger detached (non-recoverable):', reason);
      this.close(`Debugger detached: ${reason}`);
      this._debuggee = { };
      return;
    }
    // Prevent re-entrance during retry loop
    if (this._reattaching)
      return;
    debugLog('Debugger detached, attempting re-attach. Reason:', reason);
    void this._tryReattach(source.tabId!, reason);
  }

  private async _tryReattach(tabId: number, reason: string): Promise<void> {
    this._reattaching = true;
    this._degraded = true;
    this._sendMessage({
      method: 'extensionEvent',
      params: { type: 'debugger_degraded', reason, tabId, ts: Date.now() },
    });
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (this._closed)
          return;
        await new Promise<void>(r => setTimeout(r, 500 * attempt));
        if (this._closed)
          return;
        try {
          await chrome.debugger.attach({ tabId }, '1.3');
          debugLog(`Re-attached debugger on attempt ${attempt}`);
          this._degraded = false;
          this._sendMessage({
            method: 'extensionEvent',
            params: { type: 'debugger_reattached', reason, attempt, tabId, ts: Date.now() },
          });
          return;
        } catch (e: any) {
          debugLog(`Re-attach attempt ${attempt} failed:`, e.message);
        }
      }
      // Fast retries exhausted — try reload recovery before background retry.
      // Kaspersky's debugger block is password-field-interaction-specific;
      // reloading the tab clears that context.
      debugLog('Fast re-attach failed, trying reload recovery');
      try {
        await this._reloadAndReattach(tabId);
        return;
      } catch (e: any) {
        debugLog('Reload recovery failed:', e.message, '— falling back to background retry');
      }
      this._startBackgroundRetry(tabId, reason);
    } finally {
      this._reattaching = false;
    }
  }

  private _startBackgroundRetry(tabId: number, reason: string): void {
    if (this._backgroundRetryTimer)
      return;
    let attempts = 0;
    const retry = async () => {
      if (this._closed || !this._degraded) {
        this._backgroundRetryTimer = null;
        return;
      }
      attempts++;
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
        debugLog('Background re-attach succeeded');
        this._degraded = false;
        this._backgroundRetryTimer = null;
        this._sendMessage({
          method: 'extensionEvent',
          params: { type: 'debugger_reattached', reason: 'background_retry', tabId, ts: Date.now() },
        });
        return;
      } catch (e: any) {
        debugLog(`Background re-attach attempt ${attempts} failed:`, e.message);
      }
      // Schedule next retry
      if (!this._closed && this._degraded)
        this._backgroundRetryTimer = setTimeout(retry, 5000);
      else
        this._backgroundRetryTimer = null;
    };
    this._backgroundRetryTimer = setTimeout(retry, 5000);
  }

  private async _reloadAndReattach(tabId: number): Promise<void> {
    debugLog('Reloading tab to escape antivirus protection zone');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Tab reload timeout'));
      }, 10000);
      function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
      void chrome.tabs.reload(tabId);
    });
    // Brief pause for page to stabilize after load
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    await chrome.debugger.attach({ tabId }, '1.3');
    debugLog('Reattach after tab reload succeeded');
    this._degraded = false;
    if (this._backgroundRetryTimer) {
      clearTimeout(this._backgroundRetryTimer);
      this._backgroundRetryTimer = null;
    }
    this._sendMessage({
      method: 'extensionEvent',
      params: { type: 'debugger_reattached', reason: 'reload_recovery', tabId, ts: Date.now() },
    });
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    let message: ProtocolCommand;
    try {
      message = JSON.parse(event.data);
    } catch (error: any) {
      debugLog('Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    debugLog('Received message:', message);

    try {
      const result = await this._handleCommand(message);
      // Only send response for messages with an id (request/response pattern)
      if (message.id !== undefined)
        this._sendMessage({ id: message.id, result });
    } catch (error: any) {
      debugLog('Error handling command:', error);
      if (message.id !== undefined)
        this._sendMessage({ id: message.id, error: error.message });
    }
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
    // Relay keepalive — just ACK it
    if (message.method === 'keepalive')
      return {};
    if (message.method === 'selectAndAttach') {
      const { strategy, url, title, tabId: targetTabId } = message.params || {};
      debugLog('selectAndAttach: strategy=' + strategy);
      let tab: chrome.tabs.Tab;
      switch (strategy) {
        case 'new':
          tab = await chrome.tabs.create({ active: true, url: 'about:blank' });
          break;
        case 'active': {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab || activeTab.url?.startsWith('chrome://'))
            tab = await chrome.tabs.create({ active: true, url: 'about:blank' });
          else
            tab = activeTab;
          break;
        }
        case 'url_match': {
          const tabs = await chrome.tabs.query({});
          tab = tabs.find(t => t.url && t.url.includes(url))!;
          if (!tab) throw new Error(`No tab matching URL: ${url}`);
          break;
        }
        case 'title_match': {
          const tabs = await chrome.tabs.query({});
          tab = tabs.find(t => t.title && t.title.includes(title))!;
          if (!tab) throw new Error(`No tab matching title: ${title}`);
          break;
        }
        case 'tab_id':
          tab = await chrome.tabs.get(targetTabId);
          break;
        case 'last': {
          const stored = await chrome.storage.local.get('tabRegistry');
          const entries: Array<{ tabId: number }> = (stored['tabRegistry'] || []).slice().reverse();
          let found: chrome.tabs.Tab | undefined;
          for (const entry of entries) {
            try {
              found = await chrome.tabs.get(entry.tabId);
              break;
            } catch { /* tab closed, try next */ }
          }
          if (!found) throw new Error('No recent tab found in registry');
          tab = found;
          break;
        }
        default:
          throw new Error(`Unknown selectAndAttach strategy: ${strategy}`);
      }
      const previousTabId = this._debuggee?.tabId;
      this._debuggee = { tabId: tab.id };
      this._tabPromiseResolve();
      await setInterferingExtensions(false);
      if (previousTabId === tab.id) {
        // Same tab — debugger already attached, skip reattach
        debugLog('selectAndAttach: same tab ' + tab.id + ', skipping reattach');
      } else {
        if (previousTabId)
          await chrome.debugger.detach({ tabId: previousTabId }).catch(() => {});
        try {
          await chrome.debugger.attach(this._debuggee, '1.3');
        } catch (e: any) {
          if (!e.message?.toLowerCase().includes('already attached')) throw e;
          debugLog('selectAndAttach: debugger already attached (ignored)');
        }
      }
      const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Target.getTargetInfo');
      await updateTabRegistry(tab);
      return {
        tabId: tab.id,
        targetInfo: result?.targetInfo,
      };
    }
    if (message.method === 'detachDebugger') {
      debugLog('detachDebugger: detaching from tab', this._debuggee.tabId);
      if (this._debuggee.tabId) {
        await chrome.debugger.detach(this._debuggee).catch(() => {});
        await setInterferingExtensions(true);
      }
      this._debuggee = { };
      this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
      return {};
    }
    if (message.method === 'listTabs') {
      const tabs = await chrome.tabs.query({});
      const filtered = tabs.filter(tab =>
        tab.url && !['chrome:', 'edge:', 'devtools:'].some(s => tab.url!.startsWith(s))
      );
      const currentTabId = this._debuggee.tabId || null;
      return {
        tabs: filtered.map(t => ({
          tabId: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          isCurrentTarget: t.id === currentTabId,
        })),
      };
    }
    if (message.method === 'attachToTab') {
      await this._tabPromise;
      debugLog('Attaching debugger to tab:', this._debuggee);
      try {
        await chrome.debugger.attach(this._debuggee, '1.3');
      } catch (e: any) {
        if (!e.message?.includes('Already attached')) throw e;
        debugLog('attachToTab: debugger already attached, reusing');
      }
      const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Target.getTargetInfo');
      return {
        targetInfo: result?.targetInfo,
      };
    }
    if (message.method === 'reattachViaReload') {
      await this._tabPromise;
      const tabId = this._debuggee.tabId;
      if (!tabId)
        throw new Error('No tab to reload');
      await this._reloadAndReattach(tabId);
      const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Target.getTargetInfo');
      return { targetInfo: result?.targetInfo };
    }
    if (!this._debuggee.tabId)
      throw new Error('No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.');
    if (message.method === 'forwardCDPCommand') {
      if (this._degraded)
        throw new Error('Debugger temporarily unavailable (detached by external program). Retrying in background.');
      const { sessionId, method, params } = message.params;
      debugLog('CDP command:', method, params);
      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...this._debuggee,
        sessionId,
      };
      try {
        return await chrome.debugger.sendCommand(
            debuggerSession,
            method,
            params
        );
      } catch (e: any) {
        // Proactive degraded mode: if sendCommand fails because the debugger was
        // yanked mid-command (race with _onDebuggerDetach), enter degraded mode
        // immediately instead of letting the raw error propagate to Playwright.
        const msg = e.message || '';
        if (msg.includes('not attached') || msg.includes('detached') || msg.includes('No current target')) {
          debugLog('sendCommand failed (debugger likely detached):', msg);
          if (!this._degraded && !this._reattaching)
            void this._tryReattach(this._debuggee.tabId!, 'sendCommand_failure');
          throw new Error('Debugger temporarily unavailable (detached by external program). Retrying in background.');
        }
        throw e;
      }
    }
  }

  private _sendError(code: number, message: string): void {
    this._sendMessage({
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
