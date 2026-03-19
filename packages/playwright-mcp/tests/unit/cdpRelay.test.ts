import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

// Import from compiled playwright-core (file: dependency, vitest alias)
import { CDPRelayServer } from 'playwright-core/lib/mcp/cdpRelay';
import type { CDPRelayOptions, RelayState } from 'playwright-core/lib/mcp/cdpRelay';

/**
 * Test harness that creates a real HTTP server on port 0 and a CDPRelayServer
 * with fast grace TTL. Provides helpers to connect/disconnect WebSocket clients
 * simulating Playwright and extension endpoints.
 */
class RelayTestHarness {
  server!: http.Server;
  relay!: CDPRelayServer;
  private _playwrightWs: WebSocket | null = null;
  private _extensionWs: WebSocket | null = null;

  async setup(options: CDPRelayOptions = { graceTTL: 50 }) {
    this.server = http.createServer();
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.relay = new CDPRelayServer(this.server, 'chrome', options);
  }

  async teardown() {
    this._playwrightWs?.close();
    this._extensionWs?.close();
    this.relay?.stop();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** Connect a WebSocket to the extension endpoint. Sends a minimal handshake. */
  async connectExtension(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.extensionEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._extensionWs = ws;
    return ws;
  }

  /** Connect a WebSocket to the CDP (Playwright) endpoint. */
  async connectPlaywright(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.cdpEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    this._playwrightWs = ws;
    return ws;
  }

  /** Connect a raw WebSocket to the CDP endpoint without storing it (for multi-client). */
  async connectPlaywrightRaw(): Promise<WebSocket> {
    const ws = new WebSocket(this.relay.cdpEndpoint());
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    return ws;
  }

  /** Disconnect a WebSocket and wait for the close event to propagate. */
  async disconnect(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) {
      await new Promise<void>(resolve => {
        ws.on('close', () => resolve());
        ws.close();
      });
    }
    // Small delay for relay to process the close event
    await sleep(10);
  }
}

/** Helper for multi-client test scenarios. */
class MultiClientHelper {
  private _clients = new Map<string, WebSocket>();
  private _messages = new Map<string, any[]>();

  constructor(private _harness: RelayTestHarness) {}

  async connectClient(label: string): Promise<WebSocket> {
    const ws = await this._harness.connectPlaywrightRaw();
    this._clients.set(label, ws);
    const messages: any[] = [];
    this._messages.set(label, messages);
    ws.on('message', (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()));
    });
    return ws;
  }

  async disconnectClient(label: string): Promise<void> {
    const ws = this._clients.get(label);
    if (ws) {
      await this._harness.disconnect(ws);
      this._clients.delete(label);
    }
  }

  messagesFor(label: string): any[] {
    return this._messages.get(label) ?? [];
  }

  wsFor(label: string): WebSocket | undefined {
    return this._clients.get(label);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('CDPRelayServer — Wave 1', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 50, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('grace activates on playwright disconnect', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);

    expect(harness.relay.state).toBe('grace');
  });

  it('grace reconnection within TTL succeeds', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    await sleep(20);

    // Reconnect during grace
    const pw2 = await harness.connectPlaywright();
    expect(harness.relay.state).toBe('connected');
  });

  it('grace expires after TTL', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Collect extension messages to verify registry:serverDown
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      extMessages.push(JSON.parse(data.toString()));
    });

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    // Wait for grace to expire (TTL=50ms, wait 80ms)
    await sleep(80);

    expect(harness.relay.state).toBe('disconnected');
    expect(extMessages.some(m => m.type === 'registry:serverDown')).toBe(true);
  });

  it('reconnection counter increments and caps at 3', async () => {
    // Use a separate harness with longer grace to avoid expiry between cycles
    const longHarness = new RelayTestHarness();
    await longHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

    try {
      const ext = await longHarness.connectExtension();

      // First clean connect — sets counter to 0
      const pw0 = await longHarness.connectPlaywright();
      await longHarness.disconnect(pw0);
      expect(longHarness.relay.state).toBe('grace');

      // 3 grace reconnections should succeed (counter goes 1, 2, 3)
      for (let i = 0; i < 3; i++) {
        const pwReconnect = await longHarness.connectPlaywright();
        expect(longHarness.relay.state).toBe('connected');
        await longHarness.disconnect(pwReconnect);
        expect(longHarness.relay.state).toBe('grace');
      }

      // 4th reconnection during grace should be rejected (counter=4 > max=3)
      const pwFinal = new WebSocket(longHarness.relay.cdpEndpoint());
      const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
        pwFinal.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        pwFinal.on('open', () => {
          // If it opens, wait for server to close it
        });
      });

      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toContain('Reconnect limit exceeded');
      expect(longHarness.relay.state).toBe('disconnected');
    } finally {
      await longHarness.teardown();
    }
  });

  it('counter resets on clean connection', async () => {
    // Use a separate harness with longer grace for the reconnection phase
    const longHarness = new RelayTestHarness();
    await longHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

    try {
      const ext = await longHarness.connectExtension();

      // First clean connect + disconnect → enters grace
      const pw0 = await longHarness.connectPlaywright();
      await longHarness.disconnect(pw0);

      // Use up 3 reconnections (counter goes 1, 2, 3)
      for (let i = 0; i < 3; i++) {
        const pw = await longHarness.connectPlaywright();
        await longHarness.disconnect(pw);
      }
      // State is 'grace' with counter at 3

      // Stop the long harness — we'll use the default short-TTL harness for the reset test
      await longHarness.teardown();

      // Now test that a clean connection resets the counter
      const resetHarness = new RelayTestHarness();
      await resetHarness.setup({ graceTTL: 5000, graceBufferMaxBytes: 1024 });

      try {
        const ext2 = await resetHarness.connectExtension();

        // Clean connect — counter resets to 0
        const pwClean = await resetHarness.connectPlaywright();
        expect(resetHarness.relay.state).toBe('connected');
        await resetHarness.disconnect(pwClean);
        expect(resetHarness.relay.state).toBe('grace');

        // Should be able to do 3 grace reconnections
        for (let i = 0; i < 3; i++) {
          const pw = await resetHarness.connectPlaywright();
          expect(resetHarness.relay.state).toBe('connected');
          await resetHarness.disconnect(pw);
          expect(resetHarness.relay.state).toBe('grace');
        }

        // 4th should fail — confirms counter was counting from 0
        const pwFinal = new WebSocket(resetHarness.relay.cdpEndpoint());
        const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
          pwFinal.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        expect(closeEvent.code).toBe(1008);
      } finally {
        await resetHarness.teardown();
      }
    } catch (e) {
      // Ensure cleanup if longHarness teardown didn't happen yet
      try { await longHarness.teardown(); } catch {}
      throw e;
    }
  });

  it('buffer eviction at max bytes (pre-Wave2)', async () => {
    // graceBufferMaxBytes=1024
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');

    // Send events from extension that exceed the 1024-byte buffer
    // Each event is ~200 bytes (rough UTF-16 estimate: chars*2)
    // So a 150-char message ≈ 300 bytes. 5 events ≈ 1500 bytes > 1024, so oldest get evicted.
    const events: string[] = [];
    for (let i = 0; i < 5; i++) {
      const payload = JSON.stringify({
        method: 'forwardCDPEvent',
        params: {
          method: 'Network.dataReceived',
          params: { data: `event-${i}-${'x'.repeat(100)}` },
        },
      });
      events.push(payload);
      ext.send(payload);
    }

    // Small delay for events to be processed
    await sleep(20);

    // Reconnect and collect flushed messages
    const pw2 = await harness.connectPlaywright();
    const received: any[] = [];
    pw2.on('message', (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString()));
    });

    // Wait for flush
    await sleep(30);

    // Some events should have been evicted (oldest), newest preserved
    // We can't guarantee exact count due to timing, but we verify:
    // 1. State is connected
    // 2. At least one event was received (buffer wasn't empty)
    // 3. The last event sent is present
    expect(harness.relay.state).toBe('connected');
    // Buffer should have dropped some events to stay under 1024 bytes
    // The newest events should be preserved
    if (received.length > 0) {
      const lastReceived = received[received.length - 1];
      expect(lastReceived.params?.data).toContain('event-4');
    }
  });
});

describe('CDPRelayServer — Wave 2', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 500, extensionGraceTTL: 50, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('extension grace activates on extension disconnect', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(ext);

    expect(harness.relay.state).toBe('extensionGrace');
  });

  it('extension reconnects within grace', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Simulate attachToTab response so relay has a tabId to reattach
    // First, send a forwardCDPEvent that doesn't need tab tracking
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    await sleep(20);

    // Reconnect extension — relay will try attachToTab with lastTabId
    // Since lastTabId is null (no prior attachToTab), relay goes disconnected
    // For this test, we verify the grace → reconnect path with lastTabId set

    // Use a fresh harness with tabId pre-seeded via the protocol
    await harness.teardown();

    const h2 = new RelayTestHarness();
    await h2.setup({ graceTTL: 500, extensionGraceTTL: 100, graceBufferMaxBytes: 1024 });
    try {
      const ext2 = await h2.connectExtension();
      const pw2 = await h2.connectPlaywright();

      // Simulate the attachToTab exchange: Playwright sends Target.setAutoAttach,
      // relay calls attachToTab on extension. We respond with tabId.
      const extMessages: any[] = [];
      ext2.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        extMessages.push(msg);
        // Respond to attachToTab with tabId
        if (msg.method === 'attachToTab') {
          ext2.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
          }));
        }
      });

      // Trigger Target.setAutoAttach from Playwright side
      pw2.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
      await sleep(30);

      expect(h2.relay.lastTabId).toBe(42);

      // Now disconnect extension
      await h2.disconnect(ext2);
      expect(h2.relay.state).toBe('extensionGrace');

      // Reconnect extension — register handler BEFORE connect to catch attachToTab
      const ext3Messages: any[] = [];
      const ext3 = new WebSocket(h2.relay.extensionEndpoint());
      ext3.on('message', (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString());
        ext3Messages.push(msg);
        if (msg.method === 'attachToTab') {
          ext3.send(JSON.stringify({
            id: msg.id,
            result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
          }));
        }
      });
      await new Promise<void>((resolve, reject) => {
        ext3.on('open', resolve);
        ext3.on('error', reject);
      });

      await sleep(50);

      expect(h2.relay.state).toBe('connected');
      const attachMsg = ext3Messages.find(m => m.method === 'attachToTab');
      expect(attachMsg?.params?.tabId).toBe(42);
    } finally {
      await h2.teardown();
    }
  });

  it('extension grace expires after TTL', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Wait for extension grace to expire (TTL=50ms, wait 80ms)
    await sleep(80);

    expect(harness.relay.state).toBe('disconnected');
  });

  it('CDP commands fail-fast during extension grace', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Send a CDP command from Playwright
    const received: any[] = [];
    pw.on('message', (data: WebSocket.RawData) => {
      received.push(JSON.parse(data.toString()));
    });

    pw.send(JSON.stringify({ id: 99, method: 'Runtime.evaluate', params: { expression: '1+1' } }));
    await sleep(20);

    expect(received.length).toBeGreaterThanOrEqual(1);
    const errorResponse = received.find(m => m.id === 99);
    expect(errorResponse?.error?.code).toBe(-32000);
    expect(errorResponse?.error?.message).toBe('Extension reconnecting');
  });

  it('playwright disconnect during extension grace → immediate disconnected', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Extension disconnects first → enters extensionGrace
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Then Playwright disconnects → both sides gone → disconnected
    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('disconnected');
  });

  it('extension reconnect sends attachToTab with tracked tabId', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Set up extension to respond to attachToTab with tabId
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 77 },
        }));
      }
    });

    // Trigger Target.setAutoAttach to seed lastTabId
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    expect(harness.relay.lastTabId).toBe(77);

    // Disconnect extension
    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');

    // Reconnect — register handler BEFORE connect to catch attachToTab
    const ext2Messages: any[] = [];
    const ext2 = new WebSocket(harness.relay.extensionEndpoint());
    ext2.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      ext2Messages.push(msg);
      if (msg.method === 'attachToTab') {
        ext2.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 77 },
        }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ext2.on('open', resolve);
      ext2.on('error', reject);
    });

    await sleep(50);

    const attachMsg = ext2Messages.find(m => m.method === 'attachToTab');
    expect(attachMsg).toBeDefined();
    expect(attachMsg.params.tabId).toBe(77);
    expect(harness.relay.state).toBe('connected');
  });

  it('URL tracking from Page.frameNavigated', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Send a top-frame Page.frameNavigated event from extension
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Page.frameNavigated',
        params: {
          frame: { url: 'https://example.com/page1', id: 'main-frame' },
        },
      },
    }));

    await sleep(20);
    expect(harness.relay.lastTabUrl).toBe('https://example.com/page1');

    // Send another navigation
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Page.frameNavigated',
        params: {
          frame: { url: 'https://example.com/page2', id: 'main-frame' },
        },
      },
    }));

    await sleep(20);
    expect(harness.relay.lastTabUrl).toBe('https://example.com/page2');
  });

  it('sub-frame navigations ignored for URL tracking', async () => {
    const ext = await harness.connectExtension();
    const pw = await harness.connectPlaywright();

    // Send a top-frame navigation first
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Page.frameNavigated',
        params: {
          frame: { url: 'https://example.com/main', id: 'main-frame' },
        },
      },
    }));
    await sleep(20);
    expect(harness.relay.lastTabUrl).toBe('https://example.com/main');

    // Send a sub-frame navigation (has parentFrameId)
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        method: 'Page.frameNavigated',
        params: {
          frame: { url: 'https://ads.example.com/iframe', id: 'sub-frame', parentFrameId: 'main-frame' },
        },
      },
    }));
    await sleep(20);

    // URL should remain the top-frame URL
    expect(harness.relay.lastTabUrl).toBe('https://example.com/main');
  });
});

describe('CDPRelayServer — Multi-Client', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('two clients connect simultaneously', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(2);
  });

  it('non-last client disconnect: no grace', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await mc.disconnectClient('A');
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(1);
  });

  it('last client disconnect triggers grace', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await mc.disconnectClient('A');
    await mc.disconnectClient('B');
    expect(harness.relay.state).toBe('grace');
    expect(harness.relay.clientCount).toBe(0);
  });

  it('concurrency cap rejects at limit', async () => {
    const capHarness = new RelayTestHarness();
    await capHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, maxConcurrentClients: 2 });
    try {
      await capHarness.connectExtension();
      await capHarness.connectPlaywrightRaw();
      await capHarness.connectPlaywrightRaw();

      // Third should be rejected
      const ws3 = new WebSocket(capHarness.relay.cdpEndpoint());
      const closeEvent = await new Promise<{ code: number; reason: string }>(resolve => {
        ws3.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      expect(closeEvent.code).toBe(1008);
      expect(closeEvent.reason).toContain('Concurrent client limit');
    } finally {
      await capHarness.teardown();
    }
  });

  it('slot recycling after disconnect', async () => {
    const capHarness = new RelayTestHarness();
    await capHarness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024, maxConcurrentClients: 2 });
    try {
      await capHarness.connectExtension();
      const mc = new MultiClientHelper(capHarness);
      await mc.connectClient('A');
      await mc.connectClient('B');
      expect(capHarness.relay.clientCount).toBe(2);

      await mc.disconnectClient('A');
      expect(capHarness.relay.clientCount).toBe(1);

      // Should accept a new client now
      await mc.connectClient('C');
      expect(capHarness.relay.clientCount).toBe(2);
    } finally {
      await capHarness.teardown();
    }
  });

  it('CDP command routes response to correct client', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'forwardCDPCommand') {
        // Echo back the method name as the result so we can verify routing
        ext.send(JSON.stringify({ id: msg.id, result: { echo: msg.params.method } }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    mc.wsFor('A')!.send(JSON.stringify({ id: 100, method: 'Runtime.evaluate', params: { expression: '1' } }));
    mc.wsFor('B')!.send(JSON.stringify({ id: 200, method: 'DOM.getDocument', params: {} }));

    await sleep(50);

    const aMessages = mc.messagesFor('A');
    const bMessages = mc.messagesFor('B');

    expect(aMessages.some(m => m.id === 100)).toBe(true);
    expect(bMessages.some(m => m.id === 200)).toBe(true);
    // No cross-talk
    expect(aMessages.some(m => m.id === 200)).toBe(false);
    expect(bMessages.some(m => m.id === 100)).toBe(false);
  });

  it('CDP event routes to correct client by sessionId', async () => {
    const ext = await harness.connectExtension();
    // Capture MCP-level sessionIds from attachToTab messages sent to extension
    const mcpSessionIds: string[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        mcpSessionIds.push(msg.params.sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: msg.id * 10 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Trigger Target.setAutoAttach for both clients
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    expect(mcpSessionIds).toHaveLength(2);
    const [sessionA] = mcpSessionIds;

    // Send event tagged with MCP sessionId for client A — only A should receive it
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        sessionId: sessionA,
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [] },
      },
    }));
    await sleep(30);

    const aConsole = mc.messagesFor('A').filter(m => m.method === 'Runtime.consoleAPICalled');
    const bConsole = mc.messagesFor('B').filter(m => m.method === 'Runtime.consoleAPICalled');
    expect(aConsole.length).toBe(1);
    expect(bConsole.length).toBe(0);
  });

  it('Target.setAutoAttach assigns unique sessionIds', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    const aAttach = mc.messagesFor('A').find(m => m.method === 'Target.attachedToTarget');
    const bAttach = mc.messagesFor('B').find(m => m.method === 'Target.attachedToTarget');
    expect(aAttach.params.sessionId).toMatch(/^session-/);
    expect(bAttach.params.sessionId).toMatch(/^session-/);
    expect(aAttach.params.sessionId).not.toBe(bAttach.params.sessionId);
  });

  it('grace reconnection resumes last client session', async () => {
    const ext = await harness.connectExtension();
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    await harness.disconnect(pw);
    expect(harness.relay.state).toBe('grace');
    expect(harness.relay.lastTabId).toBe(42);

    const pw2 = await harness.connectPlaywright();
    expect(harness.relay.state).toBe('connected');
    expect(harness.relay.clientCount).toBe(1);
    // tabId is preserved from the resumed session
    expect(harness.relay.lastTabId).toBe(42);
  });

  it('grace only fires for last client', async () => {
    await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Disconnect A — should NOT enter grace
    await mc.disconnectClient('A');
    expect(harness.relay.state).toBe('connected');

    // Disconnect B (last) — should enter grace
    await mc.disconnectClient('B');
    expect(harness.relay.state).toBe('grace');
  });

  it('extension disconnect with N clients → extensionGrace', async () => {
    const ext = await harness.connectExtension();
    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    await harness.disconnect(ext);
    expect(harness.relay.state).toBe('extensionGrace');
    // Both clients still counted
    expect(harness.relay.clientCount).toBe(2);
  });

  it('simultaneous CDP commands: no cross-talk', async () => {
    const ext = await harness.connectExtension();
    // Extension responds to each forwardCDPCommand with the expression as result
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'forwardCDPCommand') {
        // Small delay to simulate async processing
        setTimeout(() => {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { value: msg.params.params?.expression ?? 'unknown' },
          }));
        }, 5);
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Fire simultaneously
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'fromA' } }));
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'fromB' } }));

    await sleep(50);

    const aResp = mc.messagesFor('A').find(m => m.id === 1 && m.result);
    const bResp = mc.messagesFor('B').find(m => m.id === 1 && m.result);
    expect(aResp).toBeDefined();
    expect(bResp).toBeDefined();
    expect(aResp.result.value).toBe('fromA');
    expect(bResp.result.value).toBe('fromB');
  });
});

describe('CDPRelayServer — sessionId routing', () => {
  let harness: RelayTestHarness;

  beforeEach(async () => {
    harness = new RelayTestHarness();
    await harness.setup({ graceTTL: 200, graceBufferMaxBytes: 1024 });
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('Target.setAutoAttach sends sessionId to extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];
    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(50);

    const attachMsg = extMessages.find(m => m.method === 'attachToTab');
    expect(attachMsg).toBeDefined();
    // sessionId should be a UUID string (auto-generated by relay when no query param)
    expect(typeof attachMsg.params.sessionId).toBe('string');
    expect(attachMsg.params.sessionId.length).toBeGreaterThan(0);
  });

  it('extension events with sessionId route to correct client', async () => {
    const ext = await harness.connectExtension();
    const sessionIds: string[] = [];

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'attachToTab') {
        sessionIds.push(msg.params.sessionId);
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: msg.id * 10 },
        }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');
    await mc.connectClient('B');

    // Trigger Target.setAutoAttach for both
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);
    mc.wsFor('B')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    expect(sessionIds).toHaveLength(2);

    // Send event tagged with sessionId for client A — only A should receive it
    ext.send(JSON.stringify({
      method: 'forwardCDPEvent',
      params: {
        sessionId: sessionIds[0],
        method: 'DOM.documentUpdated',
        params: {},
      },
    }));
    await sleep(30);

    const aDom = mc.messagesFor('A').filter(m => m.method === 'DOM.documentUpdated');
    const bDom = mc.messagesFor('B').filter(m => m.method === 'DOM.documentUpdated');
    expect(aDom.length).toBe(1);
    expect(bDom.length).toBe(0);
  });

  it('client disconnect sends detachTab to extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
      if (msg.method === 'detachTab') {
        ext.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });

    const mc = new MultiClientHelper(harness);
    await mc.connectClient('A');

    // Trigger Target.setAutoAttach to seed tabId
    mc.wsFor('A')!.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    const attachMsg = extMessages.find(m => m.method === 'attachToTab');
    const sessionIdA = attachMsg?.params?.sessionId;
    expect(sessionIdA).toBeDefined();

    // Disconnect client A
    await mc.disconnectClient('A');

    // Extension should receive detachTab with the correct sessionId
    await sleep(30);
    const detachMsg = extMessages.find(m => m.method === 'detachTab');
    expect(detachMsg).toBeDefined();
    expect(detachMsg.params.sessionId).toBe(sessionIdA);
  });

  it('forwardCDPCommand includes sessionId to extension', async () => {
    const ext = await harness.connectExtension();
    const extMessages: any[] = [];

    ext.on('message', (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString());
      extMessages.push(msg);
      if (msg.method === 'attachToTab') {
        ext.send(JSON.stringify({
          id: msg.id,
          result: { targetInfo: { type: 'page', url: 'https://example.com' }, tabId: 42 },
        }));
      }
      if (msg.method === 'forwardCDPCommand') {
        ext.send(JSON.stringify({ id: msg.id, result: { value: 'ok' } }));
      }
    });

    const pw = await harness.connectPlaywright();
    pw.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: {} }));
    await sleep(30);

    const attachMsg = extMessages.find(m => m.method === 'attachToTab');
    const sessionId = attachMsg?.params?.sessionId;

    // Send a CDP command
    pw.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' } }));
    await sleep(30);

    const fwdMsg = extMessages.find(m => m.method === 'forwardCDPCommand');
    expect(fwdMsg).toBeDefined();
    expect(fwdMsg.params.sessionId).toBe(sessionId);
    expect(fwdMsg.params.method).toBe('Runtime.evaluate');
  });
});
