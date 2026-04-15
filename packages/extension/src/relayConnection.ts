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

import { extLog, extLogS, setSink, clearSink } from './extensionLog';
import type { LogEntry } from './extensionLog';
import { reattachPromise, notifyContextRecoveryComplete } from './debuggerManager';
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
  private _closed = false;
  private _keepaliveInterval: ReturnType<typeof setInterval>;

  onclose?: () => void;
  onregistrymessage?: (message: any) => Promise<any>;
  ontabattach?: (tabId: number, sessionId: string) => void;
  ontabdetach?: (tabId: number) => void;

  constructor(ws: WebSocket) {
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    // Store listener for cleanup. Debugger detach handling is owned by
    // debuggerManager (not RelayConnection) to support auto-reattach.
    // Wrap async handler so the synchronous listener signature is satisfied.
    this._eventListener = (...args: Parameters<typeof this._onDebuggerEvent>) => {
      this._onDebuggerEvent(...args).catch(e => extLog('relay', 'Error in debugger event handler:', e));
    };
    chrome.debugger.onEvent.addListener(this._eventListener);
    // Wire extension log forwarding over this WS
    setSink((entry: LogEntry) => this._sendLog(entry));
    // MV3 keepalive: send application-level messages every 20s to reset
    // Chrome's service worker idle timer (~30s). Protocol-level ping/pong
    // does NOT reset the timer — only ws.send()/onmessage do (Chrome 116+).
    this._keepaliveInterval = setInterval(() => {
      if (this._ws.readyState === WebSocket.OPEN)
        this._ws.send(JSON.stringify({ type: 'keepalive' }));
    }, 20_000);
  }

  /** Expose TabManager for background.ts tab closure handling. */
  get tabManager(): TabManager {
    return this._tabManager;
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  /** Notify relay that a tab was closed — triggers dormant session cleanup. */
  sendTabClosed(sessionId: string, tabId: number): void {
    this._sendMessage({ method: 'tabClosed', params: { sessionId, tabId } });
  }

  /**
   * Notify relay that a security-induced detach/reattach cycle completed for
   * the given tab. The relay will initiate server-side context recovery and
   * respond with contextRecoveryComplete when ready.
   */
  sendDebuggerReattached(tabId: number): void {
    this._tabManager.getSessionForTab(tabId).then(sessionId => {
      if (!sessionId) {
        extLog('relay', `debuggerReattached: no session found for tab ${tabId}, dropping`);
        return;
      }
      extLog('relay', `debuggerReattached emitted for tab ${tabId} sessionId=${sessionId}`);
      this._sendMessage({ method: 'debuggerReattached', params: { tabId, sessionId } });
    }).catch(e => extLog('relay', `debuggerReattached lookup failed for tab ${tabId}:`, e));
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    clearInterval(this._keepaliveInterval);
    clearSink();
    chrome.debugger.onEvent.removeListener(this._eventListener);
    void this._tabManager.detachAll();
    this.onclose?.();
  }

  // High-frequency CDP events that are forwarded but not worth logging individually.
  // These fire hundreds of times on busy pages (LinkedIn, etc.) and drown out
  // actionable relay/lifecycle logs in the service worker console.
  private static _quietCDPEvents = new Set([
    'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished',
    'Network.loadingFailed', 'Network.dataReceived', 'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo', 'Network.requestServedFromCache',
    'Log.entryAdded',
  ]);

  private async _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): Promise<void> {
    if (source.tabId == null)
      return;
    const sessionId = await this._tabManager.getSessionForTab(source.tabId);
    if (!sessionId)
      return;
    if (!RelayConnection._quietCDPEvents.has(method))
      extLogS('relay', sessionId, 'Forwarding CDP event:', method, params);
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

    // Context recovery confirmation from relay — unblocks reattachPromise so
    // CDP commands retry after server-side execution contexts are restored.
    if (parsed.method === 'contextRecoveryComplete') {
      const tabId: number | undefined = parsed.params?.tabId;
      if (tabId != null) {
        extLog('relay', `contextRecoveryComplete received for tab ${tabId}`);
        notifyContextRecoveryComplete(tabId);
      }
      return;
    }

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

      let tabId: number;
      if (requestedTabId != null) {
        // Verify tab still exists — it may have been closed while session was dormant
        try {
          await chrome.tabs.get(requestedTabId);
          tabId = requestedTabId;
        } catch {
          extLogS('relay', sessionId, `Requested tab ${requestedTabId} gone, creating new tab`);
          const newTab = await chrome.tabs.create({ active: true, url: 'about:blank' });
          tabId = newTab.id!;
        }
      } else {
        // No explicit tabId — create a new tab.
        // Use about:blank to avoid chrome://newtab which blocks CDP access.
        const newTab = await chrome.tabs.create({ active: true, url: 'about:blank' });
        extLogS('relay', sessionId, `chrome.tabs.create → tabId=${newTab.id}`);
        tabId = newTab.id!;
      }

      const effectiveSessionId = sessionId ?? `_anon-${tabId}`;
      const { debuggee } = await this._tabManager.attach(effectiveSessionId, tabId);
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

          const { debuggee } = await this._tabManager.attach(sessionId, tabId);
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
        // Look up tabId before releasing so we can fire ontabdetach
        const debuggee = await this._tabManager.getDebuggee(sessionId);
        const tabId = debuggee?.tabId;
        await this._tabManager.detach(sessionId);
        if (tabId != null)
          this.ontabdetach?.(tabId);
      }
      return {};
    }

    if (message.method === 'listTabs') {
      const allTabs = await chrome.tabs.query({});
      const sessions = await this._tabManager.getAllSessions();
      const sessionByTab = new Map(sessions.map(s => [s.tabId, s.sessionId]));
      const automatedTabIds = new Set(sessions.map(s => s.tabId));

      const tabs = allTabs
        .filter(t => t.id != null && t.url && !['chrome:', 'edge:', 'devtools:'].some(scheme => t.url!.startsWith(scheme)))
        .map(t => ({
          tabId: t.id!,
          url: t.url || '',
          title: t.title || '',
          active: t.active ?? false,
          windowId: t.windowId ?? 0,
          debuggerAttached: automatedTabIds.has(t.id!),
          attachedSessionId: sessionByTab.get(t.id!) ?? null,
        }));
      return { tabs };
    }

    if (message.method === 'createTab') {
      const url: string = message.params?.url ?? 'about:blank';
      const sessionId: string | undefined = message.params?.sessionId;
      const newTab = await chrome.tabs.create({ active: true, url });
      const tabId = newTab.id!;
      extLogS('relay', sessionId, `chrome.tabs.create → tabId=${tabId} url=${url}`);

      if (sessionId) {
        const { debuggee } = await this._tabManager.attach(sessionId, tabId);
        this.ontabattach?.(tabId, sessionId);

        // Get full targetInfo (targetId, browserContextId, etc.) — Playwright
        // needs these fields in Target.attachedToTarget to create a Page.
        const result: any = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
        return {
          tabId,
          url: newTab.url || url,
          targetInfo: result?.targetInfo,
        };
      }

      return { tabId, url: newTab.url || url };
    }

    // ── Download commands (chrome.downloads API) ──────────────────────
    if (message.method === 'Downloads.downloadFile') {
      const { url, filename, timeout } = message.params || {};
      if (!url)
        return { error: 'url is required' };

      const downloadTimeout = timeout || 30000;
      const saveAsDetectMs = 3000;
      const sessionId = message.params?.sessionId;

      extLogS('downloads', sessionId, 'downloadFile: starting', { url, filename, timeout: downloadTimeout });

      // 1. Initiate download
      let downloadId: number;
      try {
        downloadId = await new Promise<number>((resolve, reject) => {
          chrome.downloads.download(
            { url, filename: filename || undefined, saveAs: false },
            (id) => {
              if (chrome.runtime.lastError)
                reject(new Error(chrome.runtime.lastError.message));
              else
                resolve(id);
            }
          );
        });
      } catch (e: any) {
        extLogS('downloads', sessionId, 'downloadFile: initiation failed', e.message);
        return { error: e.message };
      }

      extLogS('downloads', sessionId, 'downloadFile: initiated', { downloadId });

      // 2. Wait for completion with fast Save As detection
      try {
        const result = await new Promise<any>((resolve, reject) => {
          let resolved = false;
          let filenameReceived = false;

          const cleanup = () => {
            resolved = true;
            clearTimeout(fullTimeoutId);
            clearTimeout(saveAsTimerId);
            chrome.downloads.onChanged.removeListener(listener);
          };

          const fullTimeoutId = setTimeout(() => {
            if (!resolved) {
              cleanup();
              reject(new Error(
                `Download timed out after ${downloadTimeout}ms. ` +
                'Possible causes: (1) Chrome\'s "Ask where to save each file" is enabled — ' +
                'disable it at chrome://settings/downloads. (2) Network issue or slow server. ' +
                '(3) File too large — retry with a larger timeout.'
              ));
            }
          }, downloadTimeout);

          // Fast Save As detection: if no filename within 3s, the dialog is likely blocking
          const saveAsTimerId = setTimeout(() => {
            if (!filenameReceived && !resolved) {
              cleanup();
              reject(new Error(
                'Download appears blocked by Chrome\'s "Ask where to save each file" dialog. ' +
                'Disable this setting at chrome://settings/downloads, then retry.'
              ));
            }
          }, saveAsDetectMs);

          const listener = (delta: chrome.downloads.DownloadDelta) => {
            if (delta.id !== downloadId || resolved)
              return;

            if (delta.filename?.current) {
              filenameReceived = true;
              clearTimeout(saveAsTimerId);
              extLogS('downloads', sessionId, 'downloadFile: filename received', { filename: delta.filename.current });
            }

            if (delta.state?.current === 'complete') {
              cleanup();
              // Query final state for full metadata
              chrome.downloads.search({ id: downloadId }, (items) => {
                const item = items[0];
                extLogS('downloads', sessionId, 'downloadFile: complete', { filename: item?.filename, fileSize: item?.fileSize });
                resolve({
                  downloadId,
                  filename: item?.filename || '',
                  fileSize: item?.fileSize || item?.bytesReceived || 0,
                  state: 'complete',
                  url: item?.url || url,
                  mime: item?.mime || '',
                });
              });
            } else if (delta.state?.current === 'interrupted') {
              cleanup();
              chrome.downloads.search({ id: downloadId }, (items) => {
                const item = items[0];
                extLogS('downloads', sessionId, 'downloadFile: interrupted', { error: item?.error });
                reject(new Error(
                  `Download interrupted: ${item?.error || 'unknown error'}. URL: ${url}`
                ));
              });
            }
          };

          chrome.downloads.onChanged.addListener(listener);
        });

        return result;
      } catch (e: any) {
        extLogS('downloads', sessionId, 'downloadFile: failed', e.message);
        throw e;
      }
    }

    if (message.method === 'Downloads.listDownloads') {
      const { query, state, limit } = message.params || {};
      const sessionId = message.params?.sessionId;

      extLogS('downloads', sessionId, 'listDownloads: querying', { query, state, limit });

      const searchParams: chrome.downloads.DownloadQuery = {};
      if (query)
        searchParams.query = [query];
      if (state)
        searchParams.state = state as string;
      searchParams.limit = limit || 20;
      searchParams.orderBy = ['-startTime'];

      const items = await new Promise<chrome.downloads.DownloadItem[]>((resolve) => {
        chrome.downloads.search(searchParams, resolve);
      });

      extLogS('downloads', sessionId, 'listDownloads: found', { count: items.length });

      return {
        downloads: items.map(item => ({
          id: item.id,
          url: item.url,
          filename: item.filename,
          state: item.state,
          fileSize: item.fileSize,
          bytesReceived: item.bytesReceived,
          startTime: item.startTime,
          endTime: item.endTime,
          mime: item.mime,
          error: item.error,
        })),
      };
    }

    // TEMPORARY TEST COMMANDS — remove after chrome.downloads verification
    if (message.method === 'Test.enableDownloadListeners') {
      chrome.downloads.onCreated.addListener((item) => {
        extLogS('downloads', message.params?.sessionId, 'TEST: onCreated fired', { id: item.id, url: item.url, filename: item.filename, state: item.state });
      });
      chrome.downloads.onChanged.addListener((delta) => {
        extLogS('downloads', message.params?.sessionId, 'TEST: onChanged fired', delta);
      });
      extLogS('downloads', message.params?.sessionId, 'TEST: download listeners registered');
      return { success: true };
    }

    if (message.method === 'Test.downloadWithSaveAsFalse') {
      const testUrl = message.params?.url || 'https://httpbin.org/bytes/1024';
      const testFilename = message.params?.filename || 'test-download.bin';
      extLogS('downloads', message.params?.sessionId, 'TEST: chrome.downloads.download starting', { url: testUrl, filename: testFilename, saveAs: false });
      try {
        const downloadId = await new Promise<number>((resolve, reject) => {
          chrome.downloads.download(
            { url: testUrl, filename: testFilename, saveAs: false },
            (id) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(id);
              }
            }
          );
        });
        extLogS('downloads', message.params?.sessionId, 'TEST: chrome.downloads.download SUCCESS', { downloadId });
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id === downloadId) {
            extLogS('downloads', message.params?.sessionId, 'TEST: chrome.downloads.onChanged', delta);
            if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted')
              chrome.downloads.onChanged.removeListener(listener);
          }
        };
        chrome.downloads.onChanged.addListener(listener);
        return { success: true, downloadId };
      } catch (error: any) {
        extLogS('downloads', message.params?.sessionId, 'TEST: chrome.downloads.download FAILED', error.message);
        return { success: false, error: error.message };
      }
    }
    // END TEMPORARY TEST COMMANDS

    // For forwardCDPCommand, resolve debuggee via tabManager
    const debuggee = await this._tabManager.getDebuggee(message.params?.sessionId);
    if (!debuggee?.tabId) {
      throw new Error('No tab attached. Please attach / reattach to a tab');
    }

    if (message.method === 'forwardCDPCommand') {
      const { cdpSessionId, method, params } = message.params;
      extLogS('relay', message.params?.sessionId, 'CDP command:', method, params);
      const isDownload = method.includes('ownload');
      if (isDownload)
        extLogS('downloads', message.params?.sessionId, `chrome.debugger dispatching: ${method}`, params);
      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId: cdpSessionId,
      };
      // Forward CDP command to chrome.debugger, with retry on security-induced detach
      try {
        const result = await chrome.debugger.sendCommand(debuggerSession, method, params);
        if (isDownload)
          extLogS('downloads', message.params?.sessionId, `chrome.debugger result: ${method}`, result);
        return result;
      } catch (error: any) {
        if (isDownload)
          extLogS('downloads', message.params?.sessionId, `chrome.debugger FAILED: ${method}`, error.message);
        const pending = reattachPromise(debuggee.tabId!);
        if (!pending)
          throw error;
        extLogS('relay', message.params?.sessionId, `CDP command failed during reattach, awaiting debugger recovery: ${method}`);
        const success = await pending;
        if (!success)
          throw error;
        extLogS('relay', message.params?.sessionId, `Retrying CDP command after reattach: ${method}`);
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
