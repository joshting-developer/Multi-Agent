import { vi } from 'vitest';
import { join } from 'node:path';

export const createdPanels: Array<ReturnType<typeof createPanel>> = [];
function createPanel() {
  let receiver: ((message: unknown) => void) | undefined;
  let dispose: (() => void) | undefined; let viewState: (() => void) | undefined;
  const panel = {
    webview: { options: {}, html: '', cspSource: 'vscode-webview:',
      asWebviewUri: (uri: unknown) => uri, postMessage: vi.fn().mockResolvedValue(true),
      onDidReceiveMessage: (handler: (message: unknown) => void) => { receiver = handler; return { dispose() {} }; }
    },
    visible: true, onDidChangeViewState: (handler: () => void) => { viewState = handler; return { dispose() { viewState = undefined; } }; }, changeViewState: (visible: boolean) => { panel.visible = visible; viewState?.(); },
    receive: (message: unknown) => receiver?.(message), reveal: vi.fn(),
    onDidDispose: (handler: () => void) => { dispose = handler; return { dispose() {} }; },
    dispose: () => dispose?.()
  };
  return panel;
}
export const window = { showInformationMessage: vi.fn(), createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() })), onDidCloseTerminal: vi.fn(() => ({ dispose() {} })), showWarningMessage: vi.fn(), showQuickPick: vi.fn(), createWebviewPanel: vi.fn(() => { const panel = createPanel(); createdPanels.push(panel); return panel; }) };
export const commands = { executeCommand: vi.fn() };
export const ViewColumn = { Active: -1 };
export const ConfigurationTarget = { Global: 1 };
export const configValues = new Map<string, unknown>();
export const configuration = {
  get: <T>(key: string, fallback?: T): T => (configValues.has(key) ? configValues.get(key) : fallback) as T,
  update: vi.fn(async (key: string, value: unknown) => { configValues.set(key, value); })
};
export const workspace = { getConfiguration: () => configuration };
export const Uri = {
  file: (path: string) => ({ fsPath: path, toString: () => path }),
  joinPath: (root: { fsPath: string }, ...paths: string[]) => Uri.file(join(root.fsPath, ...paths))
};
