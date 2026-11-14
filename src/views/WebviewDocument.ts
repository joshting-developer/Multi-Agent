import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function configureWebview(webview: vscode.Webview, extensionUri: vscode.Uri, surface: 'chat' | 'settings'): void {
  const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  webview.options = { enableScripts: true, localResourceRoots: [root] };
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'chat.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'chat.css'));
  const nonce = randomBytes(24).toString('base64');
  webview.html = `<!doctype html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src blob:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';"><link rel="stylesheet" href="${style}"><title>Multi-Agent ${surface === 'settings' ? '設定' : 'Chat'}</title></head><body><div id="app" data-surface="${surface}"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
