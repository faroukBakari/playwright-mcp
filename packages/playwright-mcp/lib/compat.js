"use strict";
/**
 * Compatibility shim for functions originally imported from the `playwright`
 * package (test runner). We vendor only what the MCP server actually uses.
 */

const fs = require("fs");
const url = require("url");

async function fileExistsAsync(resolved) {
  try {
    const stat = await fs.promises.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function requireOrImport(file) {
  const ext = file.split(".").pop();
  if (ext === "mjs") {
    const fileUrl = url.pathToFileURL(file);
    return await eval(`import(${JSON.stringify(fileUrl.href)})`);
  }
  return require(file);
}

module.exports = { fileExistsAsync, requireOrImport };
