import { AccountService } from './accounts/AccountService';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { ConversationDatabase } from './storage/ConversationDatabase';
import { realpath } from 'node:fs/promises';
import { ProcessManager } from './execution/ProcessManager';
import { AgentRegistry } from './agents/AgentRegistry';
import { ClaudeCodeAdapter } from './agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from './agents/CodexAppServerAdapter';
import { SessionRepository } from './storage/SessionRepository';
import { Orchestrator } from './orchestration/Orchestrator';
import { ChatWebviewProvider } from './views/ChatWebviewProvider';
import { chatLocation } from './views/ChatLocation';
import { SettingsService } from './settings/SettingsService';
import { CodexModelCatalog } from './settings/CodexModelCatalog';

let orchestrator: Orchestrator | undefined;
let processManager: ProcessManager | undefined;
export interface ExtensionApi { whenChatReady: Promise<void>; whenSettingsReady: Promise<void>; viewId: string }
export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi | undefined> {
  const location = chatLocation(vscode.version);
  await vscode.commands.executeCommand('setContext', 'multiAgent.legacySidebar', location.legacy);
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1 || folders[0]?.uri.scheme !== 'file' || vscode.env.remoteName) {
    const message = 'Multi-Agent V0.1 需要一個本機資料夾工作區。請使用 Open Folder 開啟單一專案。';
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(location.viewId, {
      resolveWebviewView(view) { view.webview.html = `<!doctype html><html lang="zh-Hant"><body><p>${message}</p></body></html>`; }
    }), vscode.commands.registerCommand('multiAgent.open', () => vscode.window.showInformationMessage(message)),
    vscode.commands.registerCommand('multiAgent.options', () => vscode.window.showInformationMessage(message)));
    return;
  }
  const cwd = await realpath(folders[0].uri.fsPath);
  const processes = new ProcessManager();
  processManager = processes;
  const config = () => vscode.workspace.getConfiguration('multiAgent');
  const registry = new AgentRegistry([
    new ClaudeCodeAdapter(processes, () => config().get<string>('claudePath', ''), context.extensionPath),
    new CodexAppServerAdapter(processes, () => config().get<string>('codexPath', ''), context.extensionPath)
  ]);
  const accounts = new AccountService(context.globalState, join(context.globalStorageUri.fsPath, 'accounts'), registry);
  const database = await ConversationDatabase.open(join(context.globalStorageUri.fsPath, 'conversations.sqlite'), cwd, join(context.extensionPath, 'dist/sqlite/sql-wasm.wasm'));
  orchestrator = new Orchestrator(registry, new SessionRepository(context.workspaceState, cwd, database), cwd,
    () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.length === 1 && vscode.workspace.workspaceFolders[0]?.uri.toString() === folders[0]?.uri.toString(),
    () => Math.min(3600, Math.max(10, config().get<number>('timeoutSeconds', 300))) * 1000,
    () => { void vscode.window.showErrorMessage('Multi-Agent 無法儲存本機聊天紀錄。請檢查 VS Code storage 的可用空間與權限。'); },
    (provider, accountId) => accounts.env(provider, accountId));
  const settings = new SettingsService(new CodexModelCatalog(processes, () => config().get<string>('codexPath', ''), context.extensionPath));
  orchestrator.onUsage = (provider, accountId, usage) => accounts.recordUsage(provider, accountId, usage);
  const controller = new ChatWebviewProvider(context.extensionUri, orchestrator, settings, accounts);
  let providerCheckPending = false;
  const checkChangedProviders = () => {
    if (!providerCheckPending || orchestrator?.state.activeTaskId || orchestrator?.state.checking) return;
    providerCheckPending = false; void orchestrator?.checkProviders();
  };
  context.subscriptions.push(controller,
    { dispose: orchestrator.subscribe(() => { if (providerCheckPending) queueMicrotask(checkChangedProviders); }) },
    vscode.window.registerWebviewViewProvider(location.viewId, controller),
    vscode.commands.registerCommand('multiAgent.open', () => vscode.commands.executeCommand(`${location.viewId}.focus`)),
    vscode.commands.registerCommand('multiAgent.options', () => controller.showOptions().catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : '無法開啟設定。'))),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void orchestrator?.invalidateWorkspace(); void vscode.window.showInformationMessage('工作區已變更，請 Reload Window 重新綁定 Multi-Agent。'); }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('multiAgent')) return;
      if (!settings.isSaving) settings.changed();
      if (event.affectsConfiguration('multiAgent.codexPath') || event.affectsConfiguration('multiAgent.claudePath')) {
        providerCheckPending = true; queueMicrotask(checkChangedProviders);
      }
    })
  );
  await orchestrator.flush();
  return { whenChatReady: controller.whenReady, whenSettingsReady: controller.whenSettingsReady, viewId: location.viewId };
}
export async function deactivate(): Promise<void> {
  await orchestrator?.dispose(); await processManager?.dispose();
  orchestrator = undefined; processManager = undefined;
}
