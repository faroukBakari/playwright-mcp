/**
 * Unit tests for RelayConnection — WS message routing and protocol.
 *
 * Tests: registry message routing (type-based), _callbackId echo,
 * CDP command forwarding, setTabId resolution, close cleanup.
 * Chrome APIs + WebSocket mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RelayConnection } from '../relayConnection';

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
    it('closes WebSocket and detaches debugger', () => {
      connection.setTabId(42);
      connection.close('test reason');

      expect(ws.closeCode).toBe(1000);
      expect(ws.closeReason).toBe('test reason');
      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
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
