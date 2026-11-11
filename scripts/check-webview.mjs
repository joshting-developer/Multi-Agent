import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Execute the shipped IIFE without Node globals. Source-level Vue tests alone
// cannot catch a library-mode bundle that leaves process.env in the browser.
for (const surface of ['chat', 'settings']) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app" data-surface="${surface}"></div></body></html>`, { runScripts: 'outside-only', url: 'https://webview.invalid' });
  const messages = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: message => messages.push(message), getState: () => undefined, setState: () => undefined });
  try {
    assert.equal(typeof dom.window.process, 'undefined');
    dom.window.eval(await readFile('dist/webview/chat.js', 'utf8'));
    assert.ok(messages.some(message => message.type === 'ready' && message.version === 1), 'Compiled webview must bootstrap and send ready');
    assert.ok(dom.window.document.querySelector(surface === 'chat' ? 'textarea' : '.settings-page'), `Compiled ${surface} must render`);
    console.log(`Compiled ${surface}: browser bootstrap and IPC handshake PASS`);
  } finally { dom.window.close(); }
}
