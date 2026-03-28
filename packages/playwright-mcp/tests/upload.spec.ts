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

import fs from 'fs';
import path from 'path';
import os from 'os';
import { test, expect } from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-upload-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Extract first file-input ref from a navigate/snapshot response. */
function extractInputRef(result: any): string {
  const text = result.content[0].text;
  const match = text.match(/\[ref=(e\d+)\]/);
  if (!match)
    throw new Error('No ref found in response:\n' + text.slice(0, 500));
  return match[1];
}

// ---------------------------------------------------------------------------
// Upload happy path — exercises the full handle() function:
// modal state check → normalizePath → validatePaths → clearModalState →
// waitForCompletion → (isWSL ? readFilesAsPayloads : setFiles(paths))
// ---------------------------------------------------------------------------

test('browser_file_upload uploads a single file', async ({ client, server }) => {
  const tempFile = createTempFile('test-upload.txt', 'hello upload');
  try {
    server.setContent('/', `
      <input type="file" id="upload">
      <div id="result"></div>
      <script>
        document.getElementById('upload').addEventListener('change', (e) => {
          const file = e.target.files[0];
          const reader = new FileReader();
          reader.onload = () => {
            document.getElementById('result').textContent =
              'name=' + file.name + ' content=' + reader.result;
          };
          reader.readAsText(file);
        });
      </script>
    `, 'text/html');

    const navResult = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: server.PREFIX },
    });
    const ref = extractInputRef(navResult);

    // Click triggers file chooser — modal state captured
    await client.callTool({
      name: 'browser_click',
      arguments: { element: 'file input', ref },
    });

    // Upload the file — this exercises the full handle path
    const uploadResult = await client.callTool({
      name: 'browser_file_upload',
      arguments: { paths: [tempFile] },
    });

    // Verify: snapshot should show the page after upload (no error)
    expect(uploadResult).toHaveResponse({
      isError: undefined,
    });

    // Verify the file was actually uploaded and read by the page
    const verifyResult = await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: '() => document.getElementById("result").textContent',
      },
    });
    const verifyText = verifyResult.content[0].text;
    expect(verifyText).toContain('name=test-upload.txt');
    expect(verifyText).toContain('content=hello upload');
  } finally {
    fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error: no file chooser visible
// ---------------------------------------------------------------------------

test('browser_file_upload without file chooser returns error', async ({ client, server }) => {
  server.setContent('/', `<title>No Upload</title><p>Hello</p>`, 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: { paths: ['/tmp/nonexistent.txt'] },
  });

  expect(result).toHaveResponse({
    error: expect.stringContaining('modal state'),
    isError: true,
  });
});

// ---------------------------------------------------------------------------
// Error: file not found
// ---------------------------------------------------------------------------

test('browser_file_upload with nonexistent file returns error', async ({ client, server }) => {
  server.setContent('/', `<input type="file" id="upload">`, 'text/html');

  const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const ref = extractInputRef(navResult);
  await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: { paths: ['/tmp/pw-upload-test-definitely-nonexistent-file.pdf'] },
  });

  expect(result).toHaveResponse({
    error: expect.stringContaining('File not found'),
    isError: true,
  });
});

// ---------------------------------------------------------------------------
// Cancel: omit paths → file chooser cancelled
// ---------------------------------------------------------------------------

test('browser_file_upload with no paths cancels file chooser', async ({ client, server }) => {
  server.setContent('/', `<input type="file" id="upload">`, 'text/html');

  const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const ref = extractInputRef(navResult);
  await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: {},
  });

  // Cancel should succeed — no error, snapshot present
  expect(result).toHaveResponse({
    isError: undefined,
  });
});

// ---------------------------------------------------------------------------
// Multiple files
// ---------------------------------------------------------------------------

test('browser_file_upload with multiple files', async ({ client, server }) => {
  const tempFile1 = createTempFile('doc1.txt', 'first file');
  const tempFile2 = createTempFile('doc2.txt', 'second file');
  try {
    server.setContent('/', `
      <input type="file" id="upload" multiple>
      <div id="result"></div>
      <script>
        document.getElementById('upload').addEventListener('change', (e) => {
          const names = Array.from(e.target.files).map(f => f.name);
          document.getElementById('result').textContent = names.join(',');
        });
      </script>
    `, 'text/html');

    const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
    const ref = extractInputRef(navResult);
    await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

    const result = await client.callTool({
      name: 'browser_file_upload',
      arguments: { paths: [tempFile1, tempFile2] },
    });

    expect(result).toHaveResponse({ isError: undefined });

    const verifyResult = await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: '() => document.getElementById("result").textContent',
      },
    });
    const verifyText = verifyResult.content[0].text;
    expect(verifyText).toContain('doc1.txt');
    expect(verifyText).toContain('doc2.txt');
  } finally {
    fs.rmSync(path.dirname(tempFile1), { recursive: true, force: true });
    fs.rmSync(path.dirname(tempFile2), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path normalization: tilde expansion
// ---------------------------------------------------------------------------

test('browser_file_upload resolves tilde path', async ({ client, server }) => {
  const testDir = path.join(os.homedir(), '.pw-upload-test-tmp');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'tilde-test.txt');
  fs.writeFileSync(testFile, 'tilde content');
  try {
    server.setContent('/', `
      <input type="file" id="upload">
      <div id="result"></div>
      <script>
        document.getElementById('upload').addEventListener('change', (e) => {
          document.getElementById('result').textContent = e.target.files[0].name;
        });
      </script>
    `, 'text/html');

    const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
    const ref = extractInputRef(navResult);
    await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

    const result = await client.callTool({
      name: 'browser_file_upload',
      arguments: { paths: ['~/.pw-upload-test-tmp/tilde-test.txt'] },
    });

    expect(result).toHaveResponse({ isError: undefined });

    const verifyResult = await client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: '() => document.getElementById("result").textContent',
      },
    });
    expect(verifyResult.content[0].text).toContain('tilde-test.txt');
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path rejection: Windows drive path
// ---------------------------------------------------------------------------

test('browser_file_upload rejects Windows drive path', async ({ client, server }) => {
  server.setContent('/', `<input type="file" id="upload">`, 'text/html');

  const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const ref = extractInputRef(navResult);
  await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: { paths: ['C:\\Users\\test\\resume.pdf'] },
  });

  expect(result).toHaveResponse({
    error: expect.stringContaining('Windows path detected'),
    isError: true,
  });
});

// ---------------------------------------------------------------------------
// Path rejection: UNC path
// ---------------------------------------------------------------------------

test('browser_file_upload rejects UNC path', async ({ client, server }) => {
  server.setContent('/', `<input type="file" id="upload">`, 'text/html');

  const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const ref = extractInputRef(navResult);
  await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: { paths: ['\\\\wsl.localhost\\Ubuntu\\home\\user\\file.pdf'] },
  });

  expect(result).toHaveResponse({
    error: expect.stringContaining('UNC path detected'),
    isError: true,
  });
});

// ---------------------------------------------------------------------------
// Path rejection: directory
// ---------------------------------------------------------------------------

test('browser_file_upload rejects directory path', async ({ client, server }) => {
  server.setContent('/', `<input type="file" id="upload">`, 'text/html');

  const navResult = await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  const ref = extractInputRef(navResult);
  await client.callTool({ name: 'browser_click', arguments: { element: 'file input', ref } });

  const result = await client.callTool({
    name: 'browser_file_upload',
    arguments: { paths: ['/tmp'] },
  });

  expect(result).toHaveResponse({
    error: expect.stringContaining('Expected a file but got a directory'),
    isError: true,
  });
});
