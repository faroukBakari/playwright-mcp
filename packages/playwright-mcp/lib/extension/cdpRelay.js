"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var cdpRelay_exports = {};
__export(cdpRelay_exports, {
  CDPRelayServer: () => CDPRelayServer,
  RELAY_PORT: () => RELAY_PORT
});
module.exports = __toCommonJS(cdpRelay_exports);
var import_child_process = require("child_process");
var import_os = __toESM(require("os"));
var import_utilsBundle = require("playwright-core/lib/utilsBundle");
var import_registry = require("playwright-core/lib/server/registry/index");
var import_utils = require("playwright-core/lib/utils");
var import_http2 = require("../sdk/http");
var import_log = require("../log");
var protocol = __toESM(require("./protocol"));
const debugLogger = (0, import_utilsBundle.debug)("pw:mcp:relay");
const RELAY_PORT = parseInt(process.env.PLAYWRIGHT_MCP_RELAY_PORT || '56229', 10);
const EXTENSION_RECONNECT_GRACE_MS = 10000;
class CDPRelayServer {
  constructor(server, browserChannel, userDataDir, executablePath) {
    this._playwrightConnection = null;
    this._extensionConnection = null;
    this._extensionPingInterval = null;
    this._extensionReconnectTimer = null;
    this._extensionDegraded = false;
    this._extensionDegradedPromise = null;
    this._nextSessionId = 1;
    this._targetAnnouncedToPlaywright = false;
    this._wsHost = (0, import_http2.addressToString)(server.address(), { protocol: "ws" });
    this._browserChannel = browserChannel;
    this._userDataDir = userDataDir;
    this._executablePath = executablePath;
    this._cdpPath = `/cdp`;
    this._extensionPath = `/extension`;
    this._resetExtensionConnection();
    this._wss = new import_utilsBundle.wsServer({ server });
    this._wss.on("connection", this._onConnection.bind(this));
  }
  cdpEndpoint() {
    return `${this._wsHost}${this._cdpPath}`;
  }
  extensionEndpoint() {
    return `${this._wsHost}${this._extensionPath}`;
  }
  async ensureExtensionConnectionForMCPContext(clientInfo, abortSignal, forceNewTab) {
    debugLogger("Ensuring extension connection for MCP context");
    if (this._extensionConnection && this._connectedTabInfo)
      return;
    if (this._extensionConnection) {
      // Extension connected via auto-connect but no tab selected yet
      await this.selectAndAttach(forceNewTab ? 'new' : 'active');
      return;
    }
    // Layer 3: If grace period is active, wait for the extension to auto-reconnect
    // instead of opening a new connect.html tab (which would lose the original tab).
    if (this._extensionReconnectTimer) {
      debugLogger("Grace period active — waiting for extension auto-reconnect");
      await Promise.race([
        this._extensionConnectionPromise,
        new Promise((_, reject) => setTimeout(() => {
          reject(new Error("Extension reconnect timeout during grace period"));
        }, EXTENSION_RECONNECT_GRACE_MS)),
        new Promise((_, reject) => abortSignal.addEventListener("abort", reject))
      ]);
      debugLogger("Extension reconnected during grace period");
      return;
    }
    this._connectBrowser(clientInfo, forceNewTab);
    debugLogger("Waiting for incoming extension connection");
    await Promise.race([
      this._extensionConnectionPromise,
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error(`Extension connection timeout. Make sure the "Playwright MCP Bridge" extension is installed. See https://github.com/microsoft/playwright-mcp/blob/main/packages/extension/README.md for installation instructions.`));
      }, process.env.PWMCP_TEST_CONNECTION_TIMEOUT ? parseInt(process.env.PWMCP_TEST_CONNECTION_TIMEOUT, 10) : 5e3)),
      new Promise((_, reject) => abortSignal.addEventListener("abort", reject))
    ]);
    debugLogger("Extension connection established");
  }
  _connectBrowser(clientInfo, forceNewTab) {
    const mcpRelayEndpoint = `${this._wsHost}${this._extensionPath}`;
    const url = new URL("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html");
    url.searchParams.set("mcpRelayUrl", mcpRelayEndpoint);
    const client = {
      name: clientInfo.name,
      version: clientInfo.version
    };
    url.searchParams.set("client", JSON.stringify(client));
    url.searchParams.set("protocolVersion", process.env.PWMCP_TEST_PROTOCOL_VERSION ?? protocol.VERSION.toString());
    if (forceNewTab)
      url.searchParams.set("newTab", "true");
    const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || "VZmfc1eceu6jsGy1DBHaVgBkuX_71ME5MwW2Mo7AHgY";
    url.searchParams.set("token", token);
    const href = url.toString();
    let executablePath = this._executablePath;
    if (!executablePath) {
      const executableInfo = import_registry.registry.findExecutable(this._browserChannel);
      if (!executableInfo)
        throw new Error(`Unsupported channel: "${this._browserChannel}"`);
      executablePath = executableInfo.executablePath();
      if (!executablePath)
        throw new Error(`"${this._browserChannel}" executable not found. Make sure it is installed at a standard location.`);
    }
    const args = [];
    if (this._userDataDir)
      args.push(`--user-data-dir=${this._userDataDir}`);
    if (import_os.default.platform() === "linux" && this._browserChannel === "chromium")
      args.push("--no-sandbox");
    args.push(href);
    (0, import_child_process.spawn)(executablePath, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: "ignore"
    });
  }
  async selectAndAttach(strategy, params = {}) {
    if (!this._extensionConnection)
      throw new Error("Extension not connected");
    debugLogger(`selectAndAttach: strategy=${strategy}`);
    const result = await this._extensionConnection.send("selectAndAttach", { strategy, ...params });
    this._connectedTabInfo = {
      targetInfo: result.targetInfo,
      sessionId: null // assigned when Playwright sends Target.setAutoAttach
    };
    debugLogger(`selectAndAttach: attached to tab ${result.tabId}`);
    return result;
  }
  async listTabs() {
    if (!this._extensionConnection)
      throw new Error("Extension not connected");
    return await this._extensionConnection.send("listTabs", {});
  }
  stop() {
    this.closeConnections("Server stopped");
    this._wss.close();
  }
  closeConnections(reason) {
    if (this._extensionReconnectTimer) {
      clearTimeout(this._extensionReconnectTimer);
      this._extensionReconnectTimer = null;
    }
    this._closePlaywrightConnection(reason);
    this._closeExtensionConnection(reason);
  }
  _onConnection(ws2, request) {
    const url = new URL(`http://localhost${request.url}`);
    debugLogger(`New connection to ${url.pathname}`);
    if (url.pathname === this._cdpPath) {
      this._handlePlaywrightConnection(ws2);
    } else if (url.pathname === this._extensionPath) {
      this._handleExtensionConnection(ws2);
    } else {
      debugLogger(`Invalid path: ${url.pathname}`);
      ws2.close(4004, "Invalid path");
    }
  }
  _handlePlaywrightConnection(ws2) {
    if (this._playwrightConnection) {
      debugLogger("Rejecting second Playwright connection");
      ws2.close(1e3, "Another CDP client already connected");
      return;
    }
    this._playwrightConnection = ws2;
    this._targetAnnouncedToPlaywright = false;
    ws2.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await this._handlePlaywrightMessage(message);
      } catch (error) {
        debugLogger(`Error while handling Playwright message
${data.toString()}
`, error);
      }
    });
    ws2.on("close", () => {
      if (this._playwrightConnection !== ws2)
        return;
      this._playwrightConnection = null;
      // Keep extension connection AND debugger alive — Playwright may reconnect
      // (e.g., tab switch calls closeBrowserContext then re-establishes).
      // Debugger lifecycle is managed by the extension; true cleanup is in stop().
      debugLogger("Playwright WebSocket closed — extension + debugger preserved");
    });
    ws2.on("error", (error) => {
      debugLogger("Playwright WebSocket error:", error);
    });
    debugLogger("Playwright MCP connected");
  }
  _closeExtensionConnection(reason) {
    clearInterval(this._extensionPingInterval);
    this._extensionConnection?.close(reason);
    this._extensionConnectionPromise.reject(new Error(reason));
    this._resetExtensionConnection();
  }
  _resetExtensionConnection() {
    this._connectedTabInfo = void 0;
    this._extensionConnection = null;
    this._extensionDegraded = false;
    this._extensionDegradedPromise?.reject(new Error("Extension connection reset"));
    this._extensionDegradedPromise = null;
    this._extensionConnectionPromise = new import_utils.ManualPromise();
    void this._extensionConnectionPromise.catch(import_log.logUnhandledError);
  }
  _closePlaywrightConnection(reason) {
    if (this._playwrightConnection?.readyState === import_utilsBundle.ws.OPEN)
      this._playwrightConnection.close(1e3, reason);
    this._playwrightConnection = null;
  }
  _handleExtensionConnection(ws2) {
    const isGraceReconnect = !!this._extensionReconnectTimer;
    if (this._extensionReconnectTimer) {
      clearTimeout(this._extensionReconnectTimer);
      this._extensionReconnectTimer = null;
      debugLogger("Extension reconnected during grace period");
    }
    if (this._extensionConnection) {
      ws2.close(1e3, "Another extension connection already established");
      return;
    }
    this._extensionConnection = new ExtensionConnection(ws2);
    // Keepalive: prevent Chrome MV3 service worker from dying on idle timeout (30s).
    // WS-level ping for TCP health + app-level message to wake the service worker.
    this._extensionPingInterval = setInterval(() => {
      if (ws2.readyState === import_utilsBundle.ws.OPEN) {
        ws2.ping();
        ws2.send(JSON.stringify({ method: "keepalive" }));
      } else {
        clearInterval(this._extensionPingInterval);
      }
    }, 20000);
    this._extensionConnection.onclose = (c, reason) => {
      debugLogger("Extension WebSocket closed:", reason, c === this._extensionConnection);
      clearInterval(this._extensionPingInterval);
      if (this._extensionConnection !== c)
        return;
      // Stash tab info before reset clears it
      if (this._connectedTabInfo)
        this._lastConnectedTabInfo = this._connectedTabInfo;
      this._resetExtensionConnection();
      // Layer 2: Grace period — don't kill Playwright immediately
      if (this._playwrightConnection) {
        debugLogger(`Extension disconnected, waiting ${EXTENSION_RECONNECT_GRACE_MS}ms for reconnection`);
        this._extensionReconnectTimer = setTimeout(() => {
          this._extensionReconnectTimer = null;
          if (!this._extensionConnection) {
            debugLogger("Extension reconnect grace period expired, closing Playwright");
            this._closePlaywrightConnection(`Extension disconnected: ${reason} (reconnect timeout)`);
            debugLogger("No extension connection after grace period — exiting for launcher respawn");
            process.exit(1);
          }
        }, EXTENSION_RECONNECT_GRACE_MS);
      }
    };
    this._extensionConnection.onmessage = this._handleExtensionMessage.bind(this);
    this._extensionConnectionPromise.resolve();
    // Restore tab session after grace-period reconnect
    if (isGraceReconnect && this._lastConnectedTabInfo) {
      debugLogger("Restoring tab session from before disconnect");
      const restoreSession = (targetInfo) => {
        this._connectedTabInfo = {
          targetInfo,
          sessionId: this._lastConnectedTabInfo.sessionId
        };
        this._lastConnectedTabInfo = void 0;
        debugLogger("Tab session restored, re-announcing to Playwright");
        this._targetAnnouncedToPlaywright = true;
        this._sendToPlaywright({
          method: "Target.attachedToTarget",
          params: {
            sessionId: this._connectedTabInfo.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false
          }
        });
      };
      this._extensionConnection.send("attachToTab", {}).then(({ targetInfo }) => {
        restoreSession(targetInfo);
      }).catch(async (e) => {
        debugLogger("Failed to restore tab session, trying reload recovery:", e.message);
        try {
          const { targetInfo } = await this._extensionConnection.send("reattachViaReload", {});
          restoreSession(targetInfo);
        } catch (e2) {
          debugLogger("Reload recovery also failed:", e2.message);
          this._lastConnectedTabInfo = void 0;
        }
      });
    }
  }
  _handleExtensionMessage(method, params) {
    switch (method) {
      case "forwardCDPEvent":
        const sessionId = params.sessionId || this._connectedTabInfo?.sessionId;
        this._sendToPlaywright({
          sessionId,
          method: params.method,
          params: params.params
        });
        break;
      case "extensionEvent":
        debugLogger(`<extension> type=${params.type} reason=${params.reason} tabId=${params.tabId} ts=${params.ts}`);
        if (params.type === "debugger_degraded") {
          this._extensionDegraded = true;
          this._extensionDegradedPromise = new import_utils.ManualPromise();
          void this._extensionDegradedPromise.catch(import_log.logUnhandledError);
        } else if (params.type === "debugger_reattached") {
          this._extensionDegraded = false;
          this._extensionDegradedPromise?.resolve();
        }
        break;
      default:
        debugLogger(`<extension> unrecognized method=${method}`);
        break;
    }
  }
  async _handlePlaywrightMessage(message) {
    debugLogger("\u2190 Playwright:", `${message.method} (id=${message.id})`);
    const { id, sessionId, method, params } = message;
    try {
      const result = await this._handleCDPCommand(method, params, sessionId);
      this._sendToPlaywright({ id, sessionId, result });
    } catch (e) {
      debugLogger("Error in the extension:", e);
      this._sendToPlaywright({
        id,
        sessionId,
        error: { message: e.message }
      });
    }
  }
  async _handleCDPCommand(method, params, sessionId) {
    switch (method) {
      case "Browser.getVersion": {
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          userAgent: "CDP-Bridge-Server/1.0.0"
        };
      }
      case "Browser.setDownloadBehavior": {
        return {};
      }
      case "Target.setAutoAttach": {
        if (sessionId)
          break;
        if (!this._connectedTabInfo) {
          // Fallback: no selectAndAttach was called (bridge page flow)
          const { targetInfo } = await this._extensionConnection.send("attachToTab", {});
          this._connectedTabInfo = {
            targetInfo,
            sessionId: `pw-tab-${this._nextSessionId++}`
          };
        }
        if (!this._connectedTabInfo.sessionId) {
          this._connectedTabInfo.sessionId = `pw-tab-${this._nextSessionId++}`;
        }
        if (this._targetAnnouncedToPlaywright) {
          debugLogger("Target already announced, skipping duplicate auto-attach");
          return {};
        }
        this._targetAnnouncedToPlaywright = true;
        debugLogger("Simulating auto-attach");
        this._sendToPlaywright({
          method: "Target.attachedToTarget",
          params: {
            sessionId: this._connectedTabInfo.sessionId,
            targetInfo: {
              ...this._connectedTabInfo.targetInfo,
              attached: true
            },
            waitingForDebugger: false
          }
        });
        return {};
      }
      case "Target.getTargetInfo": {
        return this._connectedTabInfo?.targetInfo;
      }
    }
    return await this._forwardToExtension(method, params, sessionId);
  }
  async _forwardToExtension(method, params, sessionId) {
    if (!this._extensionConnection) {
      if (this._extensionReconnectTimer) {
        debugLogger(`Buffering CDP command ${method} while waiting for extension reconnect`);
        await this._extensionConnectionPromise;
      } else {
        throw new Error("Extension not connected");
      }
    }
    if (this._connectedTabInfo?.sessionId === sessionId)
      sessionId = void 0;
    // If extension is in degraded mode (debugger detached by Kaspersky etc.),
    // wait for re-attach instead of sending a command that will fail.
    if (this._extensionDegraded && this._extensionDegradedPromise) {
      debugLogger(`Extension degraded, waiting for re-attach before ${method}`);
      await Promise.race([
        this._extensionDegradedPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(
          "Debugger re-attach timeout. An external program (e.g. antivirus) detached the debugger."
        )), 15000))
      ]);
      debugLogger(`Extension recovered, forwarding ${method}`);
    }
    return await this._extensionConnection.send("forwardCDPCommand", { sessionId, method, params });
  }
  _sendToPlaywright(message) {
    debugLogger("\u2192 Playwright:", `${message.method ?? `response(id=${message.id})`}`);
    this._playwrightConnection?.send(JSON.stringify(message));
  }
}
class ExtensionConnection {
  constructor(ws2) {
    this._callbacks = /* @__PURE__ */ new Map();
    this._lastId = 0;
    this._ws = ws2;
    this._ws.on("message", this._onMessage.bind(this));
    this._ws.on("close", this._onClose.bind(this));
    this._ws.on("error", this._onError.bind(this));
  }
  async send(method, params) {
    if (this._ws.readyState !== import_utilsBundle.ws.OPEN)
      throw new Error(`Unexpected WebSocket state: ${this._ws.readyState}`);
    const id = ++this._lastId;
    this._ws.send(JSON.stringify({ id, method, params }));
    const error = new Error(`Protocol error: ${method}`);
    return new Promise((resolve, reject) => {
      this._callbacks.set(id, { resolve, reject, error });
    });
  }
  close(message) {
    debugLogger("closing extension connection:", message);
    if (this._ws.readyState === import_utilsBundle.ws.OPEN)
      this._ws.close(1e3, message);
  }
  _onMessage(event) {
    const eventData = event.toString();
    let parsedJson;
    try {
      parsedJson = JSON.parse(eventData);
    } catch (e) {
      debugLogger(`<closing ws> Closing websocket due to malformed JSON. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
      return;
    }
    try {
      this._handleParsedMessage(parsedJson);
    } catch (e) {
      debugLogger(`<closing ws> Closing websocket due to failed onmessage callback. eventData=${eventData} e=${e?.message}`);
      this._ws.close();
    }
  }
  _handleParsedMessage(object) {
    if (object.id && this._callbacks.has(object.id)) {
      const callback = this._callbacks.get(object.id);
      this._callbacks.delete(object.id);
      if (object.error) {
        const error = callback.error;
        error.message = object.error;
        callback.reject(error);
      } else {
        callback.resolve(object.result);
      }
    } else if (object.id) {
      debugLogger("\u2190 Extension: unexpected response", object);
    } else {
      this.onmessage?.(object.method, object.params);
    }
  }
  _onClose(event) {
    debugLogger(`<ws closed> code=${event.code} reason=${event.reason}`);
    this._dispose();
    this.onclose?.(this, event.reason);
  }
  _onError(event) {
    debugLogger(`<ws error> message=${event.message} type=${event.type} target=${event.target}`);
    this._dispose();
  }
  _dispose() {
    for (const callback of this._callbacks.values())
      callback.reject(new Error("WebSocket closed"));
    this._callbacks.clear();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CDPRelayServer,
  RELAY_PORT
});
