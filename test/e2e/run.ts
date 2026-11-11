import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { ExtensionApi } from '../../src/extension';
import { chatLocation } from '../../src/views/ChatLocation';
import { access, writeFile } from 'node:fs/promises';

/** Runs inside an isolated, real VS Code Extension Development Host. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>('local-workspace.multi-agent-workspace');
  assert.ok(extension, 'Development extension must be registered');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('multiAgent.open'));
  assert.ok(commands.includes('multiAgent.options'));
  assert.equal(extension.exports.viewId, chatLocation(vscode.version).viewId);
  await vscode.commands.executeCommand('multiAgent.open');
  await vscode.commands.executeCommand(`${extension.exports.viewId}.focus`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([extension.exports.whenChatReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Vue webview did not send the ready handshake')), 15000); })]);
  } finally { clearTimeout(timer); }
  console.log(`HOST_SMOKE_PASS: ${extension.exports.viewId}, native chat sidebar, commands, Vue webview ready`);
  await vscode.commands.executeCommand('multiAgent.options');
  try {
    await Promise.race([extension.exports.whenSettingsReady, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Settings page did not become ready')), 15000); })]);
  } finally { clearTimeout(timer); }
  assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Multi-Agent 設定')));
  console.log('SETTINGS_HOST_PASS: native gear command opens the real settings editor and receives ready');
  if (process.env.MULTI_AGENT_CAPTURE_READY && process.env.MULTI_AGENT_CAPTURE_DONE) {
    await writeFile(process.env.MULTI_AGENT_CAPTURE_READY, 'ready');
    const deadline = Date.now() + 20000;
    while (true) {
      try { await access(process.env.MULTI_AGENT_CAPTURE_DONE); break; } catch { /* Wait for screenshot capture before closing. */ }
      if (Date.now() > deadline) throw new Error('Native sidebar screenshot timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
