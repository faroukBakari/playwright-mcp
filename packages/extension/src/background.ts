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

import { RelayConnection } from './relayConnection';
import { extLog } from './extensionLog';
import * as tabRegistry from './tabRegistry';
import * as debuggerManager from './debuggerManager';

type PageMessage = {
  type: 'connectToMCPRelay';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  tabId?: number;
  windowId?: number;
  mcpRelayUrl: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
};

class TabShareExtension {
  private _activeConnection: RelayConnection | undefined;
  private _connectedTabs = new Set<number>();
  private _pendingTabSelection = new Map<number, { connection: RelayConnection, timerId?: number }>();

  constructor() {
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    // Debugger manager owns chrome.debugger.onDetach — handles registry
    // updates, auto-reattach for transient detaches, and terminal callbacks.
    debuggerManager.init((tabId, reason) => {
      extLog('lifecycle', `Terminal debugger detach for tab ${tabId}: ${reason}`);
      if (!this._connectedTabs.has(tabId))
        return;
      this._removeConnectedTab(tabId);
      this._activeConnection?.tabManager.removeByTab(tabId);
      if (this._connectedTabs.size === 0) {
        this._activeConnection?.close('All tabs disconnected');
        this._activeConnection = undefined;
      }
    });
    // Reconcile registry on service worker restart
    tabRegistry.reconcile().catch(e => extLog('lifecycle', 'tabRegistry reconcile error:', e));
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectToMCPRelay':
        this._connectToRelay(sender.tab!.id!, message.mcpRelayUrl).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'getTabs':
        this._getTabs().then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab':
        const tabId = message.tabId || sender.tab?.id!;
        const windowId = message.windowId || sender.tab?.windowId!;
        this._connectTab(sender.tab!.id!, tabId, windowId, message.mcpRelayUrl!).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      case 'getConnectionStatus':
        sendResponse({
          connectedTabIds: [...this._connectedTabs],
        });
        return false;
      case 'disconnect':
        this._disconnect().then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
    }
    return false;
  }

  private async _connectToRelay(selectorTabId: number, mcpRelayUrl: string): Promise<void> {
    try {
      extLog('lifecycle', `Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      const connection = new RelayConnection(socket);
      connection.onregistrymessage = msg => tabRegistry.handleRegistryMessage(msg);
      connection.onclose = () => {
        extLog('lifecycle', 'Connection closed');
        this._pendingTabSelection.delete(selectorTabId);
      };
      this._pendingTabSelection.set(selectorTabId, { connection });
      extLog('lifecycle', `Connected to MCP relay`);
    } catch (error: any) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      extLog('lifecycle', message);
      throw new Error(message);
    }
  }

  private async _connectTab(selectorTabId: number, tabId: number, windowId: number, mcpRelayUrl: string): Promise<void> {
    try {
      extLog('lifecycle', `Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);

      // Wave 2: If a connection is already active (multi-tab in progress),
      // don't destroy it. Close the redundant pending connection created by
      // _connectToRelay and return — tab assignments are managed by the relay
      // via the attachToTab protocol, not the popup flow.
      if (this._activeConnection) {
        extLog('lifecycle', `Active connection exists — ignoring popup tab selection`);
        const pending = this._pendingTabSelection.get(selectorTabId);
        if (pending) {
          pending.connection.close('Connection already active');
          this._pendingTabSelection.delete(selectorTabId);
        }
        return;
      }

      // First connection: move pending → active and set up handlers
      this._activeConnection = this._pendingTabSelection.get(selectorTabId)?.connection;
      if (!this._activeConnection)
        throw new Error('No active MCP relay connection');
      this._pendingTabSelection.delete(selectorTabId);

      this._activeConnection.setTabId(tabId);
      chrome.tabs.get(tabId).then(
          tab => tabRegistry.upsertOnAttach(tabId, windowId, { url: tab.url, title: tab.title }),
          () => tabRegistry.upsertOnAttach(tabId, windowId, {}),
      ).catch(e => extLog('lifecycle', 'tabRegistry upsert error:', e));
      this._activeConnection.onclose = () => {
        extLog('lifecycle', 'MCP connection closed');
        this._activeConnection = undefined;
        this._clearAllConnectedTabs();
      };
      this._activeConnection.ontabattach = (id: number, sessionId: string) => {
        this._addConnectedTab(id);
        // Persist sessionId in tabRegistry for recovery after SW restart
        chrome.tabs.get(id).then(
          tab => tabRegistry.upsertOnAttach(id, tab.windowId ?? 0, { url: tab.url, title: tab.title, sessionId }),
          () => tabRegistry.upsertOnAttach(id, 0, { sessionId }),
        ).catch(e => extLog('lifecycle', 'tabRegistry upsert error:', e));
      };
      this._activeConnection.ontabdetach = (id: number) => {
        this._removeConnectedTab(id);
      };

      await Promise.all([
        this._addConnectedTab(tabId),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true }),
      ]);
      extLog('lifecycle', `Connected to MCP bridge`);
    } catch (error: any) {
      this._clearAllConnectedTabs();
      extLog('lifecycle', `Failed to connect tab ${tabId}:`, error.message);
      throw error;
    }
  }

  private async _addConnectedTab(tabId: number): Promise<void> {
    this._connectedTabs.add(tabId);
    await this._updateBadge(tabId, { text: '✓', color: '#4CAF50', title: 'Connected to MCP client' });
  }

  private async _removeConnectedTab(tabId: number): Promise<void> {
    this._connectedTabs.delete(tabId);
    await this._updateBadge(tabId, { text: '' });
  }

  private async _clearAllConnectedTabs(): Promise<void> {
    const tabs = [...this._connectedTabs];
    this._connectedTabs.clear();
    await Promise.all(tabs.map(tabId => this._updateBadge(tabId, { text: '' })));
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || '' });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  private async _onTabRemoved(tabId: number): Promise<void> {
    tabRegistry.onTabRemoved(tabId);
    const pendingConnection = this._pendingTabSelection.get(tabId)?.connection;
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.close('Browser tab closed');
      return;
    }
    if (!this._connectedTabs.has(tabId))
      return;
    this._removeConnectedTab(tabId);
    this._activeConnection?.tabManager.removeByTab(tabId);
    if (this._connectedTabs.size === 0) {
      this._activeConnection?.close('Browser tab closed');
      this._activeConnection = undefined;
    }
  }

  private _onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
    tabRegistry.onTabActivated(activeInfo.tabId);
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = undefined;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close('Tab has been inactive for 5 seconds');
            chrome.tabs.sendMessage(tabId, { type: 'connectionTimeout' });
          }
        }, 5000);
        return;
      }
    }
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) {
    tabRegistry.onTabUpdated(tabId, changeInfo);
    if (this._connectedTabs.has(tabId))
      void this._addConnectedTab(tabId);
  }

  private async _getTabs(): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    return tabs.filter(tab => tab.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => tab.url!.startsWith(scheme)));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }

  private async _disconnect(): Promise<void> {
    this._activeConnection?.close('User disconnected');
    this._activeConnection = undefined;
    await this._clearAllConnectedTabs();
  }
}

new TabShareExtension();
