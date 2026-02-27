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
var selectTab_exports = {};
__export(selectTab_exports, {
  default: () => selectTab_default
});
module.exports = __toCommonJS(selectTab_exports);
var import_mcpBundle = require("playwright-core/lib/mcpBundle");
var import_tool = require("./tool");
const browserSelectTab = (0, import_tool.defineTool)({
  capability: "core-tabs",
  schema: {
    name: "browser_select_tab",
    title: "Select Chrome tab",
    description: "List and switch pre-existing Chrome tabs. Without parameters, lists all open tabs. With a parameter, switches to the matched tab.",
    inputSchema: import_mcpBundle.z.object({
      url: import_mcpBundle.z.string().optional().describe("URL substring match"),
      title: import_mcpBundle.z.string().optional().describe("Title substring match"),
      tabId: import_mcpBundle.z.number().optional().describe("Exact Chrome tab ID")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const hasParam = params.url || params.title || params.tabId !== void 0;
    if (!hasParam) {
      // List mode
      const result = await context.listChromeTabs();
      if (!result?.tabs) {
        response.addTextResult("Error: Could not list tabs. Ensure the Chrome extension is loaded and connected.");
        return;
      }
      const lines = [];
      if (!result.tabs.length) {
        lines.push("No open Chrome tabs.");
      } else {
        for (const tab of result.tabs) {
          const marker = tab.isCurrentTarget ? " (current)" : "";
          lines.push(`- [${tab.tabId}] ${tab.title}${marker}`);
          lines.push(`  ${tab.url}`);
        }
      }
      response.addTextResult(lines.join("\n"));
    } else {
      // Switch mode
      let strategy;
      const switchParams = {};
      if (params.tabId !== void 0) {
        strategy = "tab_id";
        switchParams.tabId = params.tabId;
      } else if (params.url) {
        strategy = "url_match";
        switchParams.url = params.url;
      } else {
        strategy = "title_match";
        switchParams.title = params.title;
      }
      const result = await context.switchChromeTab(strategy, switchParams);
      response.addTextResult(`Switched to tab ${result.tabId}`);
    }
  }
});
var selectTab_default = [
  browserSelectTab
];
