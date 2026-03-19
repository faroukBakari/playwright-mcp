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

import { extLog, setSink, clearSink } from './extensionLog';
import type { LogEntry } from './extensionLog';
import { reattachPromise } from './debuggerManager';
import { TabManager } from './tabManager';
import * as tabRegistry from './tabRegistry';

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
  private _tabManager = new TabManager();
  private _ws: WebSocket;
  private _eventListener: (source: chrome.debugger.DebuggerSession, method: string, params: any) => void;
  private _tabPromise: Promise<void>;
  private _tabPromiseResolve!: () => void;
  private _pendingTabId: number | null = null;
  private _closed = false;

  onclose?: () => void;
  onregistrymessage?: (message: any) => Promise<any>;
  ontabattach?: (tabId: number, sessionId: string) => void;
  ontabdetach?: (tabId: number) => void;

  constructor(ws: WebSocket) {
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    // Store listener for cleanup. Debugger detach handling is owned by
    // debuggerManager (not RelayConnection) to support auto-reattach.
    this._eventListener = this._onDebuggerEvent.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    // Wire extension log forwarding over this WS
    setSink((entry: LogEntry) => this._sendLog(entry));
  }

  /** Expose TabManager for background.ts tab closure handling. */
  get tabManager(): TabManager {
    return this._tabManager;
  }

  // Either setTabId or close is called after creating the connection.
  setTabId(tabId: number): void {
    this._pendingTabId = tabId;
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
    clearSink();
    chrome.debugger.onEvent.removeListener(this._eventListener);
    void this._tabManager.detachAll();
    this.onclose?.();
  }

  private _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    if (source.tabId == null)
      return;
    const sessionId = this._tabManager.getSessionForTab(source.tabId);
    if (!sessionId)
      return;
    extLog('relay', 'Forwarding CDP event:', method, params);
    const cdpSessionId = source.sessionId;
    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        sessionId,
        cdpSessionId,
        method,
        params,
      },
    });
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => extLog('relay', 'Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch (error: any) {
      extLog('relay', 'Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    extLog('relay', 'Received message:', parsed);

    // Route registry messages (type-based) separately from CDP protocol (id-based)
    if (typeof parsed.type === 'string' && parsed.type.startsWith('registry:')) {
      if (this.onregistrymessage) {
        const result = await this.onregistrymessage(parsed);
        if (result) {
          // Echo _callbackId for sideband HTTP response routing
          if (parsed._callbackId)
            result._callbackId = parsed._callbackId;
          this._sendMessage(result);
        }
      }
      return;
    }

    const message = parsed as ProtocolCommand;
    const response: ProtocolResponse = {
      id: message.id,
    };
    try {
      response.result = await this._handleCommand(message);
    } catch (error: any) {
      extLog('relay', 'Error handling command:', error);
      response.error = error.message;
    }
    extLog('relay', 'Sending response:', response);
    this._sendMessage(response);
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
    if (message.method === 'attachToTab') {
      const sessionId: string | undefined = message.params?.sessionId;
      const requestedTabId: number | undefined = message.params?.tabId;

      // If explicit tabId provided (reconnection), update pending and resolve
      if (requestedTabId != null && this._pendingTabId !== requestedTabId) {
        this._pendingTabId = requestedTabId;
        this._tabPromiseResolve();
      }

      let tabId: number;
      if (requestedTabId != null) {
        tabId = requestedTabId;
      } else if (this._tabManager.size === 0) {
        // First client — wait for popup tab selection
        await this._tabPromise;
        tabId = this._pendingTabId!;
      } else {
        // Subsequent client with no explicit tabId — create a new tab.
        // Use about:blank to avoid chrome://newtab which blocks CDP access.
        const newTab = await chrome.tabs.create({ active: true, url: 'about:blank' });
        tabId = newTab.id!;
      }

      const effectiveSessionId = sessionId ?? `_anon-${tabId}`;
      const debuggee = this._tabManager.attach(effectiveSessionId, tabId);
      extLog('relay', 'Attaching debugger to tab:', debuggee);
      await chrome.debugger.attach(debuggee, '1.3');
      this.ontabattach?.(tabId, effectiveSessionId);
      const result: any = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
      return {
        targetInfo: result?.targetInfo,
        tabId,
      };
    }

    if (message.method === 'recoverSessions') {
      const sessions: Array<{ sessionId: string; cdpSessionId: string }> = message.params?.sessions ?? [];
      const results: Array<{ sessionId: string; tabId?: number; targetInfo?: any; success: boolean; error?: string }> = [];
      const claimedTabIds = new Set<number>();

      for (const { sessionId } of sessions) {
        try {
          const entry = await tabRegistry.getBySessionId(sessionId);
          if (!entry) {
            results.push({ sessionId, success: false, error: 'No registry entry for session' });
            continue;
          }

          let tabId = entry.tabId;
          // Verify tab still exists (may be invalid after browser death)
          try {
            await chrome.tabs.get(tabId);
          } catch {
            // Tab gone — try URL match as fallback, excluding already-claimed tabs
            const allTabs = await chrome.tabs.query({});
            const match = allTabs.find(t => t.url === entry.url && t.id != null && !claimedTabIds.has(t.id!));
            if (match?.id != null) {
              tabId = match.id;
            } else {
              results.push({ sessionId, success: false, error: `Tab ${entry.tabId} gone, no URL match for ${entry.url}` });
              continue;
            }
          }
          claimedTabIds.add(tabId);

          const debuggee = this._tabManager.attach(sessionId, tabId);
          await chrome.debugger.attach(debuggee, '1.3');
          this.ontabattach?.(tabId, sessionId);
          const result: any = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
          results.push({ sessionId, tabId, targetInfo: result?.targetInfo, success: true });
        } catch (error: any) {
          results.push({ sessionId, success: false, error: error.message });
        }
      }

      return results;
    }

    if (message.method === 'detachTab') {
      const sessionId: string | undefined = message.params?.sessionId;
      if (sessionId) {
        const tabId = await this._tabManager.detach(sessionId);
        if (tabId != null)
          this.ontabdetach?.(tabId);
      }
      return {};
    }

    // For forwardCDPCommand, resolve debuggee via tabManager
    const debuggee = this._tabManager.getDebuggee(message.params?.sessionId);
    if (!debuggee?.tabId)
      throw new Error('No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.');

    if (message.method === 'forwardCDPCommand') {
      const { cdpSessionId, method, params } = message.params;
      extLog('relay', 'CDP command:', method, params);
      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId: cdpSessionId,
      };
      // Forward CDP command to chrome.debugger, with retry on security-induced detach
      try {
        return await chrome.debugger.sendCommand(debuggerSession, method, params);
      } catch (error: any) {
        const pending = reattachPromise(debuggee.tabId!);
        if (!pending)
          throw error;
        extLog('relay', `CDP command failed during reattach, awaiting debugger recovery: ${method}`);
        const success = await pending;
        if (!success)
          throw error;
        extLog('relay', `Retrying CDP command after reattach: ${method}`);
        return await chrome.debugger.sendCommand(debuggerSession, method, params);
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

  private _sendLog(entry: LogEntry): boolean {
    if (this._ws.readyState !== WebSocket.OPEN)
      return false;
    this._ws.send(JSON.stringify(entry));
    return true;
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
