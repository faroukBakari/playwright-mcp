"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var snapshotCompressor_exports = {};
__export(snapshotCompressor_exports, {
  compressSnapshot: () => compressSnapshot,
  pruneAriaYaml: () => pruneAriaYaml,
  ollamaCompress: () => ollamaCompress
});
module.exports = __toCommonJS(snapshotCompressor_exports);

var http = require("http");
var fs = require("fs");

// --- Role classifications ---

const CONTAINER_ROLES = new Set([
  "generic", "group", "none", "presentation", "Section"
]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "checkbox", "radio", "combobox",
  "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox"
]);

// Attributes to always keep
const KEEP_ATTRS = new Set([
  "ref", "level", "checked", "selected", "disabled", "expanded",
  "required", "value", "url"
]);

// Attributes to always strip
const STRIP_ATTRS = new Set([
  "describedby", "labelledby", "orientation", "autocomplete",
  "haspopup", "roledescription", "keyshortcuts"
]);

const METRICS_FILE = "/tmp/snapshot_compression_metrics.jsonl";

function createMetricsCounters() {
  return { depthGated: 0, itemsCompressed: 0 };
}

// --- Line parser ---

function parseLine(line) {
  const rawIndent = line.match(/^(\s*)/)[1].length;
  const level = Math.floor(rawIndent / 2);
  const trimmed = line.trimStart();

  // Must start with "- "
  if (!trimmed.startsWith("- ")) {
    return { level, raw: line, isText: true, role: null, name: "", attrs: {}, hasChildren: false, children: [] };
  }

  const content = trimmed.slice(2); // after "- "

  // Parse role (first word)
  const roleMatch = content.match(/^(\w+)/);
  if (!roleMatch) {
    return { level, raw: line, isText: true, role: null, name: "", attrs: {}, hasChildren: false, children: [] };
  }

  const role = roleMatch[1];
  let rest = content.slice(role.length);

  // Parse optional quoted name
  let name = "";
  const nameMatch = rest.match(/^\s+"([^"]*)"/);
  if (nameMatch) {
    name = nameMatch[1];
    rest = rest.slice(nameMatch[0].length);
  }

  // Parse attributes [key=value] or [key]
  const attrs = {};
  const attrRegex = /\[([^\]]+)\]/g;
  let m;
  while ((m = attrRegex.exec(rest)) !== null) {
    const eqIdx = m[1].indexOf("=");
    if (eqIdx !== -1) {
      attrs[m[1].slice(0, eqIdx)] = m[1].slice(eqIdx + 1);
    } else {
      attrs[m[1]] = true;
    }
  }

  // Check if has children (ends with ":")
  const hasChildren = rest.trimEnd().endsWith(":");

  return { level, role, name, attrs, hasChildren, children: [], raw: line };
}

// --- Tree builder ---

function buildTree(lines) {
  const nodes = lines.map(parseLine);
  const root = { level: -1, role: "root", name: "", attrs: {}, hasChildren: true, children: [] };
  const stack = [root];

  for (const node of nodes) {
    // Pop stack until we find the parent (level < node.level)
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    if (node.hasChildren || node.children.length > 0) {
      stack.push(node);
    }
  }

  return root.children;
}

// --- Serializer ---

function serializeNode(node, indent) {
  const prefix = " ".repeat(indent * 2);
  let line = `${prefix}- ${node.role || "text"}`;

  if (node.isText && node.raw) {
    // Preserve raw text lines
    return `${prefix}${node.raw.trimStart()}`;
  }

  if (node.name) {
    line += ` "${node.name}"`;
  }

  // Serialize kept attributes
  for (const [key, val] of Object.entries(node.attrs)) {
    if (val === true) {
      line += ` [${key}]`;
    } else {
      line += ` [${key}=${val}]`;
    }
  }

  if (node.children.length > 0) {
    line += ":";
  }

  const lines = [line];
  for (const child of node.children) {
    lines.push(...serializeNode(child, indent + 1).split("\n"));
  }

  return lines.join("\n");
}

function serializeTree(nodes) {
  return nodes.map(n => serializeNode(n, 0)).join("\n");
}

// --- Layer 1: Algorithmic pruning ---

function isContainer(node) {
  return CONTAINER_ROLES.has(node.role);
}

function isInteractive(node) {
  return INTERACTIVE_ROLES.has(node.role);
}

function isTextOnly(node) {
  return node.isText || node.role === "text" || (node.role === "paragraph" && node.children.length === 0 && node.name);
}

// 1a. Container collapsing (bottom-up)
function collapseContainers(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    // Recurse first (bottom-up)
    if (node.children.length > 0) {
      node.children = collapseContainers(node.children);
    }

    // Container with exactly 1 child → replace with child
    if (isContainer(node) && node.children.length === 1) {
      const child = node.children[0];
      // Preserve child's identity, drop container
      child.level = node.level;
      nodes[i] = child;
      continue;
    }

    // Container where all children are text-only → promote children up
    if (isContainer(node) && node.children.length > 0 && node.children.every(isTextOnly)) {
      // Promote children: replace this node with its children
      const promoted = node.children.map(c => ({ ...c, level: node.level }));
      nodes.splice(i, 1, ...promoted);
      i += promoted.length - 1;
    }
  }
  return nodes;
}

// 1b. Text trimming
function trimText(nodes, maxLen) {
  for (const node of nodes) {
    // Truncate long names in non-interactive elements
    if (node.name && node.name.length > maxLen && !isInteractive(node)) {
      node.name = node.name.slice(0, maxLen) + "...";
    }

    if (node.children.length > 0) {
      trimText(node.children, maxLen);
    }
  }
}

// 1b-extra. Repeated item compression
function compressRepeatedItems(nodes, counters) {
  if (nodes.length <= 4) {
    // For children, still recurse
    for (const node of nodes) {
      if (node.children.length > 0) {
        node.children = compressRepeatedItems(node.children, counters);
      }
    }
    return nodes;
  }

  // Detect runs of identical roles
  let i = 0;
  const result = [];
  while (i < nodes.length) {
    const run = [nodes[i]];
    let j = i + 1;
    while (j < nodes.length && nodes[j].role === nodes[i].role && nodes[i].role) {
      run.push(nodes[j]);
      j++;
    }

    if (run.length > 4) {
      // Keep first 3, add summary, drop rest
      for (let k = 0; k < 3; k++) {
        result.push(run[k]);
      }
      if (counters) counters.itemsCompressed++;
      const summaryNode = {
        level: run[0].level,
        role: "text",
        name: `... (${run.length - 3} more ${run[0].role} items)`,
        attrs: {},
        hasChildren: false,
        children: [],
        isText: false
      };
      result.push(summaryNode);
    } else {
      result.push(...run);
    }
    i = j;
  }

  // Recurse into children
  for (const node of result) {
    if (node.children.length > 0) {
      node.children = compressRepeatedItems(node.children, counters);
    }
  }

  return result;
}

// 1c. Attribute stripping
function stripAttributes(nodes) {
  for (const node of nodes) {
    if (node.attrs) {
      const cleaned = {};
      for (const [key, val] of Object.entries(node.attrs)) {
        if (STRIP_ATTRS.has(key)) {
          // Strip placeholder only when name exists
          continue;
        }
        if (key === "placeholder" && node.name) {
          continue;
        }
        // Keep known-good attrs, and any unknown attrs (fail-open)
        cleaned[key] = val;
      }
      node.attrs = cleaned;
    }

    if (node.children.length > 0) {
      stripAttributes(node.children);
    }
  }
}

// 1d. Depth gating
function gateDepth(nodes, maxDepth, currentDepth, counters) {
  if (currentDepth === undefined) currentDepth = 0;

  for (const node of nodes) {
    if (currentDepth >= maxDepth && node.children.length > 0) {
      if (counters) counters.depthGated++;
      const count = countDescendants(node);
      node.children = [{
        level: node.level + 1,
        role: "text",
        name: `... (${count} children hidden)`,
        attrs: {},
        hasChildren: false,
        children: [],
        isText: false
      }];
    } else if (node.children.length > 0) {
      gateDepth(node.children, maxDepth, currentDepth + 1, counters);
    }
  }
}

function countDescendants(node) {
  let count = node.children.length;
  for (const child of node.children) {
    count += countDescendants(child);
  }
  return count;
}

// Main Layer 1 entry point
function pruneAriaYaml(snapshot, options) {
  const maxTextLen = options?.maxTextLen ?? 100;
  const maxDepth = options?.maxDepth ?? 8;
  const counters = options?._counters ?? createMetricsCounters();

  if (!snapshot || !snapshot.trim()) return snapshot;

  const lines = snapshot.split("\n").filter(l => l.trim());
  const tree = buildTree(lines);

  // Apply pruning passes (order matters: bottom-up first)
  const collapsed = collapseContainers(tree);
  trimText(collapsed, maxTextLen);
  const compressed = compressRepeatedItems(collapsed, counters);
  stripAttributes(compressed);
  gateDepth(compressed, maxDepth, 0, counters);

  return serializeTree(compressed);
}

// --- Layer 2: Qwen3:8b semantic distillation ---

function buildOllamaPrompt(snapshot, toolName) {
  return `/no_think
You are an accessibility tree compressor for a browser automation agent.

TASK CONTEXT: The agent just used tool "${toolName || "unknown"}".

RULES:
1. Preserve ALL [ref=eN] attributes exactly — the agent needs these to interact with elements
2. Preserve all interactive elements (buttons, links, inputs, form controls) completely
3. Remove decorative/structural noise (empty containers, repeated whitespace nodes)
4. Summarize long text content (keep first sentence + "[...]")
5. For repeated similar items (product cards, list items), keep 3 representative examples and note "... (N more similar)"
6. Output valid ARIA YAML with the same indentation format

INPUT ARIA TREE:
${snapshot}

OUTPUT (compressed ARIA YAML only, no explanation):`;
}

function extractRefs(text) {
  const refs = new Set();
  const refRegex = /\[ref=([^\]]+)\]/g;
  let m;
  while ((m = refRegex.exec(text)) !== null) {
    refs.add(m[1]);
  }
  return refs;
}

function extractInteractiveRefs(snapshot) {
  const refs = new Set();
  const lines = snapshot.split("\n");
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) continue;
    const content = trimmed.slice(2);
    const roleMatch = content.match(/^(\w+)/);
    if (!roleMatch) continue;
    if (INTERACTIVE_ROLES.has(roleMatch[1])) {
      const refMatch = content.match(/\[ref=([^\]]+)\]/);
      if (refMatch) refs.add(refMatch[1]);
    }
  }
  return refs;
}

function ollamaCompress(snapshot, toolName, timeoutMs) {
  if (!timeoutMs) timeoutMs = 2000;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "qwen3:8b",
      prompt: buildOllamaPrompt(snapshot, toolName),
      stream: false,
      options: { num_predict: 4096, temperature: 0 }
    });

    const timer = setTimeout(() => {
      req.destroy();
      resolve(null); // Timeout → return null, caller falls back
    }, timeoutMs);

    const req = http.request({
      hostname: "localhost",
      port: 11434,
      path: "/api/generate",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          const response = parsed.response || "";
          resolve(response.trim());
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => {
      clearTimeout(timer);
      resolve(null); // Ollama down → fail open
    });

    req.write(body);
    req.end();
  });
}

// --- Metrics emission ---

function emitMetrics(toolName, before, after, layer, elapsedMs, counters) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: toolName || "unknown",
      before,
      after,
      ratio: before > 0 ? +(after / before).toFixed(3) : 1,
      layer,
      elapsed_ms: elapsedMs,
      depth_gated: counters.depthGated,
      items_compressed: counters.itemsCompressed
    }) + "\n";
    fs.appendFileSync(METRICS_FILE, line);
  } catch {
    // Fail open — logging must never break compression
  }
}

// --- Main entry point ---

async function compressSnapshot(snapshot, options) {
  const mode = options?.mode ?? "none";
  const maxChars = options?.maxChars ?? 4096;
  const toolName = options?.toolName ?? "";

  if (mode === "none" || !snapshot || !snapshot.trim()) {
    return snapshot;
  }

  const t0 = Date.now();
  const beforeLen = snapshot.length;
  const counters = createMetricsCounters();

  // Layer 1: Algorithmic pruning
  let result = pruneAriaYaml(snapshot, { _counters: counters });
  let layer = "L1";

  if (mode === "algorithmic") {
    emitMetrics(toolName, beforeLen, result.length, layer, Date.now() - t0, counters);
    return result;
  }

  // Layer 2: Qwen3:8b (only in "full" mode, only if Layer 1 output exceeds threshold)
  if (mode === "full" && result.length > maxChars) {
    const interactiveRefs = extractInteractiveRefs(result);
    const llmResult = await ollamaCompress(result, toolName);

    if (llmResult) {
      const llmRefs = extractRefs(llmResult);
      let refsOk = true;
      for (const ref of interactiveRefs) {
        if (!llmRefs.has(ref)) {
          refsOk = false;
          break;
        }
      }

      if (refsOk && llmResult.length < result.length) {
        result = llmResult;
        layer = "L2";
      }
    }
  }

  emitMetrics(toolName, beforeLen, result.length, layer, Date.now() - t0, counters);
  return result;
}

// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  compressSnapshot,
  pruneAriaYaml,
  ollamaCompress
});
