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
var wait_exports = {};
__export(wait_exports, {
  default: () => wait_default
});
module.exports = __toCommonJS(wait_exports);
var import_mcpBundle = require("playwright-core/lib/mcpBundle");
var import_tool = require("./tool");
const wait = (0, import_tool.defineTool)({
  capability: "core",
  schema: {
    name: "browser_wait_for",
    title: "Wait for",
    description: "Wait for text to appear or disappear or a specified time to pass",
    inputSchema: import_mcpBundle.z.object({
      time: import_mcpBundle.z.number().optional().describe("The time to wait in seconds"),
      text: import_mcpBundle.z.string().optional().describe("The text to wait for"),
      textGone: import_mcpBundle.z.string().optional().describe("The text to wait for to disappear"),
      includeSnapshot: import_mcpBundle.z.boolean().optional().describe("Set to false to suppress the accessibility snapshot in the response.")
    }),
    type: "assertion"
  },
  handle: async (context, params, response) => {
    if (!params.text && !params.textGone && !params.time)
      throw new Error("Either time, text or textGone must be provided");
    // Pure time wait (no text conditions) — early return
    if (params.time && !params.text && !params.textGone) {
      response.addCode(`await new Promise(f => setTimeout(f, ${params.time} * 1000));`);
      await new Promise((f) => setTimeout(f, Math.min(3e4, params.time * 1e3)));
      response.addTextResult(`Waited ${params.time}s`);
      response.setIncludeSnapshot();
      return;
    }
    const tab = context.currentTabOrDie();
    const goneLocator = params.textGone ? tab.page.getByText(params.textGone).filter({ visible: true }).first() : void 0;
    if (goneLocator) {
      response.addCode(`await page.getByText(${JSON.stringify(params.textGone)}).first().waitFor({ state: 'hidden' });`);
      await goneLocator.waitFor({ state: "hidden" });
    }
    // When time+text combined, time caps the text wait (not stacked)
    const totalTimeout = params.time ? Math.min(params.time * 1000, 3000) : 3000;
    let textFound = false;
    if (params.text) {
      // Stage 1: Fast-poll via evaluate (1s max, 200ms intervals)
      const pollResult = await tab.page.evaluate(async (target) => {
        for (let i = 0; i < 5; i++) {
          if (document.body.innerText.includes(target)) return true;
          await new Promise(r => setTimeout(r, 200));
        }
        return false;
      }, params.text);
      if (pollResult) {
        textFound = true;
      } else {
        // Stage 2: Playwright waitFor with visibility filter, remaining time
        const stage2Timeout = Math.max(totalTimeout - 1000, 500);
        try {
          const locator = tab.page.getByText(params.text).filter({ visible: true }).first();
          await locator.waitFor({ state: "visible", timeout: stage2Timeout });
          textFound = true;
        } catch (e) {
          // Timeout is not fatal — we return snapshot for LLM to decide
        }
      }
      response.addCode(`// 2-stage wait: fast-poll 1s + waitFor ${totalTimeout - 1000}ms`);
    }
    // Differentiated result messages
    if (params.text && params.textGone) {
      response.addTextResult(textFound
        ? `Found: "${params.text}", gone: "${params.textGone}"`
        : `Timeout: "${params.text}" not found after ${totalTimeout}ms, gone: "${params.textGone}"`);
    } else if (params.text) {
      response.addTextResult(textFound
        ? `Found: "${params.text}"`
        : `Timeout: "${params.text}" not found after ${totalTimeout}ms`);
    } else if (params.textGone) {
      response.addTextResult(`Gone: "${params.textGone}"`);
    }
    response.setIncludeSnapshot();
  }
});
var wait_default = [
  wait
];
