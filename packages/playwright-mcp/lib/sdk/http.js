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
var http_exports = {};
__export(http_exports, {
  addressToString: () => addressToString,
  startMcpHttpServer: () => startMcpHttpServer
});
module.exports = __toCommonJS(http_exports);
var import_assert = __toESM(require("assert"));
var import_crypto = __toESM(require("crypto"));
var import_utilsBundle = require("playwright-core/lib/utilsBundle");
var mcpBundle = __toESM(require("playwright-core/lib/mcpBundle"));
var import_utils = require("playwright-core/lib/utils");
var mcpServer = __toESM(require("./server"));
const testDebug = (0, import_utilsBundle.debug)("pw:mcp:test");
async function startMcpHttpServer(config, serverBackendFactory, allowedHosts) {
  const httpServer = (0, import_utils.createHttpServer)();
  await (0, import_utils.startHttpServer)(httpServer, config);
  return await installHttpTransport(httpServer, config, serverBackendFactory, allowedHosts);
}
function addressToString(address, options) {
  (0, import_assert.default)(address, "Could not bind server socket");
  if (typeof address === "string")
    throw new Error("Unexpected address type: " + address);
  let host = address.family === "IPv4" ? address.address : `[${address.address}]`;
  if (options.normalizeLoopback && (host === "0.0.0.0" || host === "[::]" || host === "[::1]" || host === "127.0.0.1"))
    host = "localhost";
  return `${options.protocol}://${host}:${address.port}`;
}
async function installHttpTransport(httpServer, config, serverBackendFactory, allowedHosts) {
  const url = addressToString(httpServer.address(), { protocol: "http", normalizeLoopback: true });
  const host = new URL(url).host;
  allowedHosts = (allowedHosts || [host]).map((h) => h.toLowerCase());
  const allowAnyHost = allowedHosts.includes("*");
  const sseSessions = /* @__PURE__ */ new Map();
  const streamableSessions = /* @__PURE__ */ new Map();
  const startTime = Date.now();
  let lastActivityTimestamp = Date.now();
  const idleTtlMs = (config.idleTtl || 0) * 60 * 1000;

  // Idle TTL: self-terminate after configured idle period
  if (idleTtlMs > 0) {
    setInterval(() => {
      if (Date.now() - lastActivityTimestamp > idleTtlMs) {
        console.error(`Idle TTL expired (${config.idleTtl}m). Shutting down.`);
        process.emit("SIGINT");
      }
    }, 60000);
  }
  httpServer.on("request", async (req, res) => {
    if (!allowAnyHost) {
      const host2 = req.headers.host?.toLowerCase();
      if (!host2) {
        res.statusCode = 400;
        return res.end("Missing host");
      }
      if (!allowedHosts.includes(host2)) {
        res.statusCode = 403;
        return res.end("Access is only allowed at " + allowedHosts.join(", "));
      }
    }
    const url2 = new URL(`http://localhost${req.url}`);
    if (url2.pathname === "/killkillkill" && req.method === "GET") {
      res.statusCode = 200;
      res.end("Killing process");
      process.emit("SIGINT");
      return;
    }
    if (url2.pathname === "/health" && req.method === "GET") {
      const health = {
        status: "ok",
        uptime_s: Math.round((Date.now() - startTime) / 1000),
        active_sessions: sseSessions.size + streamableSessions.size,
        port: config.port,
        idle_ttl_minutes: config.idleTtl || 0,
        last_activity_s: Math.round((Date.now() - lastActivityTimestamp) / 1000)
      };
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify(health));
      return;
    }
    // Reset activity timestamp only for actual MCP traffic (SSE or Streamable HTTP)
    lastActivityTimestamp = Date.now();
    if (url2.pathname.startsWith("/sse"))
      await handleSSE(serverBackendFactory, req, res, url2, sseSessions);
    else
      await handleStreamable(serverBackendFactory, req, res, streamableSessions);
  });
  return url;
}
async function handleSSE(serverBackendFactory, req, res, url, sessions) {
  if (req.method === "POST") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.statusCode = 400;
      return res.end("Missing sessionId");
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.statusCode = 404;
      return res.end("Session not found");
    }
    return await transport.handlePostMessage(req, res);
  } else if (req.method === "GET") {
    const transport = new mcpBundle.SSEServerTransport("/sse", res);
    sessions.set(transport.sessionId, transport);
    testDebug(`create SSE session: ${transport.sessionId}`);
    await mcpServer.connect(serverBackendFactory, transport, false);
    res.on("close", () => {
      testDebug(`delete SSE session: ${transport.sessionId}`);
      sessions.delete(transport.sessionId);
    });
    return;
  }
  res.statusCode = 405;
  res.end("Method not allowed");
}
async function handleStreamable(serverBackendFactory, req, res, sessions) {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (transport)
      return await transport.handleRequest(req, res);
    // Stale session ID — fall through to create a new session instead of 404.
    // This handles Chrome restart: client holds old session ID, server lost it.
    testDebug(`stale session ${sessionId}, creating new session`);
  }
  if (req.method === "POST") {
    // If stale session, pre-read body for auto-recovery check.
    // The stream is consumed, so all subsequent handleRequest calls use parsedBody.
    let parsedBody;
    if (sessionId) {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        parsedBody = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 400;
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" },
          id: null
        }));
        return;
      }
    }
    const transport = new mcpBundle.StreamableHTTPServerTransport({
      sessionIdGenerator: () => import_crypto.default.randomUUID(),
      onsessioninitialized: async (sessionId2) => {
        testDebug(`create http session: ${transport.sessionId}`);
        await mcpServer.connect(serverBackendFactory, transport, true);
        sessions.set(sessionId2, transport);
      }
    });
    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      testDebug(`delete http session: ${transport.sessionId}`);
    };
    // Auto-recovery: stale session with a non-initialize request.
    // Initialize the transport internally, then replay the original request.
    if (parsedBody) {
      const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      const isInit = messages.some((m) => m.method === "initialize");
      if (!isInit) {
        try {
          const initBody = {
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "auto-recovery", version: "1.0" }
            },
            id: `__auto_init_${Date.now()}`
          };
          const initRequest = new Request(`http://localhost${req.url}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "accept": "application/json, text/event-stream"
            }
          });
          const initResponse = await transport._webStandardTransport.handleRequest(
            initRequest, { parsedBody: initBody }
          );
          // Drain init response to prevent resource leaks
          if (initResponse.body) {
            const reader = initResponse.body.getReader();
            try { while (!(await reader.read()).done) {} } catch {}
          }
          if (initResponse.status === 200) {
            // Fix stale session ID in rawHeaders (hono reads these) and headers
            const newSessionId = transport.sessionId;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
              if (req.rawHeaders[i].toLowerCase() === "mcp-session-id") {
                req.rawHeaders[i + 1] = newSessionId;
                break;
              }
            }
            req.headers["mcp-session-id"] = newSessionId;
            testDebug(`auto-recovered stale session ${sessionId} → ${newSessionId}`);
          } else {
            testDebug(`auto-recovery init failed: ${initResponse.status}`);
          }
        } catch (e) {
          testDebug(`auto-recovery failed: ${e.message}`);
        }
      }
      // Body was consumed — replay with parsedBody (works for both init and tool calls)
      await transport.handleRequest(req, res, parsedBody);
      return;
    }
    // Normal path (no stale session)
    await transport.handleRequest(req, res);
    return;
  }
  res.statusCode = 400;
  res.end("Invalid request");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addressToString,
  startMcpHttpServer
});
