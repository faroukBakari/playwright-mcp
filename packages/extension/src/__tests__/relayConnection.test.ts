/**
 * Unit tests for RelayConnection — WS message routing and protocol.
 *
 * Tests: registry message routing (type-based), _callbackId echo,
 * CDP command forwarding, setTabId resolution, close cleanup,
 * multi-tab delegation via TabManager, event clientId tagging.
 * Chrome APIs + WebSocket mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { seedTab } from './chrome-mock';
import { RelayConnection } from '../relayConnection';
import * as tabRegistry from '../tabRegistry';

// --- WebSocket mock ---

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  sent: any[] = [];
  closeCode?: number;
  closeReason?: string;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = MockWebSocket.CLOSED;
    // Trigger onclose asynchronously like real WS
    queueMicrotask(() => this.onclose?.());
  }

  // Helper to simulate receiving a message
  receive(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

// Wire WebSocket global
(globalThis as any).WebSocket = MockWebSocket;

describe('RelayConnection', () => {
  let ws: MockWebSocket;
  let connection: RelayConnection;

  beforeEach(() => {
    ws = new MockWebSocket();
    connection = new RelayConnection(ws as any);
  });

  describe('registry message routing', () => {
    it('routes registry:list to onregistrymessage handler', async () => {
      const handler = vi.fn(async (msg: any) => ({
        type: 'registry:response',
        tabs: [{ tabId: 1, url: 'https://x.com' }],
      }));
      connection.onregistrymessage = handler;

      ws.receive({ type: 'registry:list' });
      // Allow async processing
      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith({ type: 'registry:list' });
      });

      await vi.waitFor(() => {
        expect(ws.sent).toContainEqual(expect.objectContaining({
          type: 'registry:response',
          tabs: [{ tabId: 1, url: 'https://x.com' }],
        }));
      });
    });

    it('routes registry:focus to onregistrymessage handler', async () => {
      const handler = vi.fn(async () => ({
        type: 'registry:focusResult',
        success: true,
      }));
      connection.onregistrymessage = handler;

      ws.receive({ type: 'registry:focus', tabId: 42 });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith({ type: 'registry:focus', tabId: 42 });
      });
    });

    it('echoes _callbackId in response for sideband HTTP routing', async () => {
      const handler = vi.fn(async () => ({
        type: 'registry:response',
        tabs: [],
      }));
      connection.onregistrymessage = handler;

      ws.receive({ type: 'registry:list', _callbackId: 'cb-123' });

      await vi.waitFor(() => {
        const registryResponses = ws.sent.filter(m => m.type === 'registry:response');
        expect(registryResponses).toHaveLength(1);
        expect(registryResponses[0]._callbackId).toBe('cb-123');
      });
    });

    it('does not send response when handler returns null', async () => {
      connection.onregistrymessage = vi.fn(async () => null);

      ws.receive({ type: 'registry:list' });

      await new Promise(r => setTimeout(r, 50));
      const registryResponses = ws.sent.filter(m => m.type?.startsWith('registry:'));
      expect(registryResponses).toHaveLength(0);
    });

    it('does not route non-registry messages to onregistrymessage', async () => {
      const handler = vi.fn();
      connection.onregistrymessage = handler;

      // CDP protocol message (id-based)
      ws.receive({ id: 1, method: 'attachToTab', params: {} });

      await new Promise(r => setTimeout(r, 50));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('setTabId', () => {
    it('resolves the tab promise for CDP commands', async () => {
      connection.setTabId(42);

      // attachToTab should now be able to proceed (it awaits _tabPromise)
      ws.receive({ id: 1, method: 'attachToTab', params: {} });

      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      });
    });
  });

  describe('CDP command forwarding', () => {
    it('forwards forwardCDPCommand to chrome.debugger.sendCommand', async () => {
      connection.setTabId(42);

      // First attach
      ws.receive({ id: 1, method: 'attachToTab' });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      // Then forward a CDP command
      ws.receive({
        id: 2,
        method: 'forwardCDPCommand',
        params: {
          sessionId: undefined,
          method: 'Page.navigate',
          params: { url: 'https://example.com' },
        },
      });

      await vi.waitFor(() => {
        expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
          expect.objectContaining({ tabId: 42 }),
          'Page.navigate',
          { url: 'https://example.com' },
        );
      });
    });
  });

  describe('close', () => {
    it('closes WebSocket and detaches all via TabManager', async () => {
      connection.setTabId(42);
      // Attach so TabManager has an entry to detach
      ws.receive({ id: 1, method: 'attachToTab', params: {} });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      connection.close('test reason');

      expect(ws.closeCode).toBe(1000);
      expect(ws.closeReason).toBe('test reason');
      // TabManager.detachAll calls chrome.debugger.detach for each entry
      await vi.waitFor(() => {
        expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
      });
    });

    it('fires onclose callback', () => {
      const onclose = vi.fn();
      connection.onclose = onclose;
      connection.close('done');

      expect(onclose).toHaveBeenCalledOnce();
    });

    it('removes debugger event listener', () => {
      connection.close('done');
      expect(chrome.debugger.onEvent.removeListener).toHaveBeenCalled();
    });

    it('is idempotent', () => {
      const onclose = vi.fn();
      connection.onclose = onclose;
      connection.close('first');
      connection.close('second');

      // onclose should only fire once
      expect(onclose).toHaveBeenCalledOnce();
    });
  });

  describe('multi-tab delegation', () => {
    it('attachToTab with sessionId delegates to tabManager', async () => {
      connection.setTabId(42);

      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'relay-client-1' } });

      await vi.waitFor(() => {
        expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      });

      expect(connection.tabManager.size).toBe(1);
      expect(connection.tabManager.getDebuggee('relay-client-1')).toEqual({ tabId: 42 });
    });

    it('forwardCDPCommand routes via tabManager.getDebuggee(sessionId)', async () => {
      connection.setTabId(42);

      // Attach first client
      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'client-A' } });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      // Forward command with sessionId
      ws.receive({
        id: 2,
        method: 'forwardCDPCommand',
        params: {
          sessionId: 'client-A',
          method: 'Runtime.evaluate',
          params: { expression: '1+1' },
        },
      });

      await vi.waitFor(() => {
        expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
          expect.objectContaining({ tabId: 42 }),
          'Runtime.evaluate',
          { expression: '1+1' },
        );
      });
    });

    it('detachTab removes client from tabManager', async () => {
      connection.setTabId(42);

      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'client-X' } });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      expect(connection.tabManager.size).toBe(1);

      ws.receive({ id: 2, method: 'detachTab', params: { sessionId: 'client-X' } });
      await vi.waitFor(() => {
        // Response sent
        expect(ws.sent.some(m => m.id === 2 && m.result !== undefined)).toBe(true);
      });

      expect(connection.tabManager.size).toBe(0);
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    });

    it('events are tagged with sessionId from tabManager lookup', async () => {
      connection.setTabId(42);

      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'client-A' } });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      // Simulate a debugger event from tab 42
      const eventListener = (chrome.debugger.onEvent.addListener as any).mock.calls[
        (chrome.debugger.onEvent.addListener as any).mock.calls.length - 1
      ][0];

      eventListener({ tabId: 42, sessionId: 'cdp-sess-1' }, 'Page.loadEventFired', { timestamp: 123 });

      await vi.waitFor(() => {
        const cdpEvents = ws.sent.filter(m => m.method === 'forwardCDPEvent');
        expect(cdpEvents).toHaveLength(1);
        expect(cdpEvents[0].params.sessionId).toBe('client-A');
        expect(cdpEvents[0].params.cdpSessionId).toBe('cdp-sess-1');
        expect(cdpEvents[0].params.method).toBe('Page.loadEventFired');
      });
    });

    it('events from unknown tabs are dropped', async () => {
      connection.setTabId(42);
      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'client-A' } });
      await vi.waitFor(() => expect(chrome.debugger.attach).toHaveBeenCalled());

      const eventListener = (chrome.debugger.onEvent.addListener as any).mock.calls[
        (chrome.debugger.onEvent.addListener as any).mock.calls.length - 1
      ][0];

      // Event from tab 999 (not attached)
      eventListener({ tabId: 999 }, 'Page.loadEventFired', {});

      await new Promise(r => setTimeout(r, 30));
      const cdpEvents = ws.sent.filter(m => m.method === 'forwardCDPEvent');
      expect(cdpEvents).toHaveLength(0);
    });
  });

  describe('ontabattach sessionId', () => {
    it('passes both tabId and sessionId to callback', async () => {
      connection.setTabId(42);
      const handler = vi.fn();
      connection.ontabattach = handler;

      ws.receive({ id: 1, method: 'attachToTab', params: { sessionId: 'sess-42' } });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(42, 'sess-42');
      });
    });

    it('generates anonymous sessionId when none provided', async () => {
      connection.setTabId(42);
      const handler = vi.fn();
      connection.ontabattach = handler;

      ws.receive({ id: 1, method: 'attachToTab', params: {} });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(42, '_anon-42');
      });
    });
  });

  describe('recoverSessions', () => {
    it('reattaches to tab found in registry', async () => {
      connection.setTabId(10); // Initial tab (unrelated, just to resolve the promise)
      const handler = vi.fn();
      connection.ontabattach = handler;

      // Seed registry with a session→tab mapping
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://example.com', sessionId: 'sess-A' });
      // Seed chrome mock so tabs.get(42) succeeds
      seedTab({ id: 42, url: 'https://example.com', windowId: 1 });

      ws.receive({
        id: 5,
        method: 'recoverSessions',
        params: {
          sessions: [{ sessionId: 'sess-A', cdpSessionId: 'cdp-1' }],
        },
      });

      await vi.waitFor(() => {
        const response = ws.sent.find(m => m.id === 5);
        expect(response).toBeDefined();
        expect(response.result).toHaveLength(1);
        expect(response.result[0]).toMatchObject({
          sessionId: 'sess-A',
          tabId: 42,
          success: true,
        });
      });

      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
      expect(handler).toHaveBeenCalledWith(42, 'sess-A');
    });

    it('returns failure for unknown sessionId', async () => {
      connection.setTabId(10);

      ws.receive({
        id: 6,
        method: 'recoverSessions',
        params: {
          sessions: [{ sessionId: 'unknown-sess', cdpSessionId: 'cdp-2' }],
        },
      });

      await vi.waitFor(() => {
        const response = ws.sent.find(m => m.id === 6);
        expect(response).toBeDefined();
        expect(response.result).toHaveLength(1);
        expect(response.result[0]).toMatchObject({
          sessionId: 'unknown-sess',
          success: false,
        });
        expect(response.result[0].error).toContain('No registry entry');
      });
    });

    it('falls back to URL match when original tab is gone', async () => {
      connection.setTabId(10);
      const handler = vi.fn();
      connection.ontabattach = handler;

      // Seed registry with tab 42, but don't seed tab 42 in chrome mock (simulates tab gone)
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://example.com', sessionId: 'sess-B' });
      // Seed a different tab with the same URL
      seedTab({ id: 99, url: 'https://example.com', windowId: 1 });

      ws.receive({
        id: 7,
        method: 'recoverSessions',
        params: {
          sessions: [{ sessionId: 'sess-B', cdpSessionId: 'cdp-3' }],
        },
      });

      await vi.waitFor(() => {
        const response = ws.sent.find(m => m.id === 7);
        expect(response).toBeDefined();
        expect(response.result).toHaveLength(1);
        expect(response.result[0]).toMatchObject({
          sessionId: 'sess-B',
          tabId: 99,
          success: true,
        });
      });

      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 99 }, '1.3');
      expect(handler).toHaveBeenCalledWith(99, 'sess-B');
    });

    it('URL fallback excludes already-claimed tabs (duplicate URLs)', async () => {
      connection.setTabId(10);
      const handler = vi.fn();
      connection.ontabattach = handler;

      // Two sessions both had the same URL on different tabs (now gone)
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://dup.com', sessionId: 'sess-X' });
      await tabRegistry.upsertOnAttach(43, 1, { url: 'https://dup.com', sessionId: 'sess-Y' });
      // Two replacement tabs with the same URL
      seedTab({ id: 100, url: 'https://dup.com', windowId: 1 });
      seedTab({ id: 101, url: 'https://dup.com', windowId: 1 });

      ws.receive({
        id: 20,
        method: 'recoverSessions',
        params: {
          sessions: [
            { sessionId: 'sess-X', cdpSessionId: 'cdp-x' },
            { sessionId: 'sess-Y', cdpSessionId: 'cdp-y' },
          ],
        },
      });

      await vi.waitFor(() => {
        const response = ws.sent.find(m => m.id === 20);
        expect(response).toBeDefined();
        expect(response.result).toHaveLength(2);
        // Both should succeed with different tab IDs
        expect(response.result[0]).toMatchObject({ sessionId: 'sess-X', success: true });
        expect(response.result[1]).toMatchObject({ sessionId: 'sess-Y', success: true });
        const tabIds = response.result.map((r: any) => r.tabId);
        expect(new Set(tabIds).size).toBe(2); // no duplicates
      });
    });

    it('returns failure when tab gone and no URL match exists', async () => {
      connection.setTabId(10);

      // Seed registry with tab 42, but no matching tab in chrome mock
      await tabRegistry.upsertOnAttach(42, 1, { url: 'https://gone.com', sessionId: 'sess-C' });

      ws.receive({
        id: 8,
        method: 'recoverSessions',
        params: {
          sessions: [{ sessionId: 'sess-C', cdpSessionId: 'cdp-4' }],
        },
      });

      await vi.waitFor(() => {
        const response = ws.sent.find(m => m.id === 8);
        expect(response).toBeDefined();
        expect(response.result).toHaveLength(1);
        expect(response.result[0]).toMatchObject({
          sessionId: 'sess-C',
          success: false,
        });
        expect(response.result[0].error).toContain('Tab 42 gone');
      });
    });
  });

  describe('keepalive', () => {
    it('sends keepalive messages at 20s intervals', () => {
      vi.useFakeTimers();
      const freshWs = new MockWebSocket();
      const conn = new RelayConnection(freshWs as any);

      expect(freshWs.sent.filter(m => m.type === 'keepalive')).toHaveLength(0);

      vi.advanceTimersByTime(20_000);
      expect(freshWs.sent.filter(m => m.type === 'keepalive')).toHaveLength(1);

      vi.advanceTimersByTime(20_000);
      expect(freshWs.sent.filter(m => m.type === 'keepalive')).toHaveLength(2);

      conn.close('done');
      vi.useRealTimers();
    });

    it('stops keepalive on close', () => {
      vi.useFakeTimers();
      const freshWs = new MockWebSocket();
      const conn = new RelayConnection(freshWs as any);

      conn.close('done');
      freshWs.sent.length = 0; // clear any messages from close

      vi.advanceTimersByTime(40_000);
      expect(freshWs.sent.filter(m => m.type === 'keepalive')).toHaveLength(0);

      vi.useRealTimers();
    });

    it('does not send keepalive when WS is closed', () => {
      vi.useFakeTimers();
      const freshWs = new MockWebSocket();
      const _conn = new RelayConnection(freshWs as any);

      freshWs.readyState = MockWebSocket.CLOSED;
      vi.advanceTimersByTime(20_000);

      expect(freshWs.sent.filter(m => m.type === 'keepalive')).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  describe('error handling', () => {
    it('sends JSON-RPC error on malformed message', async () => {
      // Trigger with invalid JSON
      ws.onmessage?.({ data: '{invalid json' });

      await vi.waitFor(() => {
        expect(ws.sent).toContainEqual(expect.objectContaining({
          error: expect.objectContaining({
            code: -32700,
            message: expect.stringContaining('Error parsing'),
          }),
        }));
      });
    });
  });
});
