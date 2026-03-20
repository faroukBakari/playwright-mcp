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

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TabItem  } from './tabItem';

import type { TabInfo } from './tabItem';
import { AuthTokenSection } from './authToken';

interface ConnectedTab extends TabInfo {
  sessionId?: string;
}

interface ConnectionStatus {
  isConnected: boolean;
  connectedTabs: ConnectedTab[];
}

const StatusApp: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>({
    isConnected: false,
    connectedTabs: []
  });

  useEffect(() => {
    void loadStatus();
  }, []);

  const loadStatus = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    const connectedTabIds: number[] = response.connectedTabIds ?? [];
    const sessions: Record<string, number> = response.sessions ?? {};

    // Reverse map: tabId → sessionId
    const tabToSession: Record<number, string> = {};
    for (const [sid, tabId] of Object.entries(sessions))
      tabToSession[tabId] = sid;

    if (connectedTabIds.length > 0) {
      const tabs: ConnectedTab[] = [];
      for (const tabId of connectedTabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          tabs.push({
            id: tab.id!,
            windowId: tab.windowId!,
            title: tab.title!,
            url: tab.url!,
            favIconUrl: tab.favIconUrl,
            sessionId: tabToSession[tabId],
          });
        } catch {
          // Tab may have been closed between status query and get
        }
      }
      setStatus({ isConnected: true, connectedTabs: tabs });
    } else {
      setStatus({ isConnected: false, connectedTabs: [] });
    }
  };

  const focusTab = async (tabId: number) => {
    await chrome.tabs.update(tabId, { active: true });
    window.close();
  };

  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: 'disconnect' });
    window.close();
  };

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {status.isConnected && status.connectedTabs.length > 0 ? (
          <div>
            <div className='tab-section-title'>
              {status.connectedTabs.length === 1 ? 'Page with connected MCP client:' : `${status.connectedTabs.length} pages with connected MCP clients:`}
            </div>
            {status.connectedTabs.map(tab => (
              <div key={tab.id}>
                <TabItem
                  tab={tab}
                  sessionId={tab.sessionId}
                  button={
                    <Button variant='primary' onClick={disconnect}>
                      Disconnect
                    </Button>
                  }
                  onClick={() => focusTab(tab.id)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className='status-banner'>
            No MCP clients are currently connected.
          </div>
        )}
        <AuthTokenSection />
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<StatusApp />);
}
