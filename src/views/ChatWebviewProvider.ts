import * as vscode from 'vscode';
import { webviewMessageSchema, type AgentId, type HostToWebview, type WebviewToHost } from '../bridge/messages';
import { Orchestrator } from '../orchestration/Orchestrator';
import { DiscussionCoordinator } from '../orchestration/DiscussionCoordinator';
import { randomUUID } from 'node:crypto';
import { SettingsService } from '../settings/SettingsService';
import { claudeModels, defaultSettings, type ProviderPreferences } from '../bridge/settings';
import { configureWebview } from './WebviewDocument';
import type { AccountService } from '../accounts/AccountService';
import { toMarkdown } from '../storage/Export';
import { writeFile } from 'node:fs/promises';

export class ChatWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private settingsPanel?: vscode.WebviewPanel;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private readonly disposables: vscode.Disposable[] = [];
  private approvalPending = false;
  private readonly fullAccessGrants = new Set<AgentId>();
  private readonly discussions: DiscussionCoordinator;
  private resolveReady: () => void = () => undefined;
  readonly whenReady = new Promise<void>(resolve => { this.resolveReady = resolve; });
  private resolveSettingsReady: () => void = () => undefined;
  readonly whenSettingsReady = new Promise<void>(resolve => { this.resolveSettingsReady = resolve; });
  constructor(private readonly extensionUri: vscode.Uri, private readonly orchestrator: Orchestrator, private readonly settings?: SettingsService, private readonly accounts?: AccountService) {
    this.discussions = new DiscussionCoordinator(orchestrator, () => this.snapshot());
    this.unsubscribe = orchestrator.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.snapshot(); }, 40);
    });
    if (settings) this.disposables.push({ dispose: settings.subscribe(() => this.snapshot()) });
    if (accounts) this.disposables.push({ dispose: accounts.subscribe(() => this.snapshot()) });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.attach(view.webview, 'chat');
    this.disposables.push(view.onDidDispose(() => this.webviews.delete(view.webview)));
  }
  private attach(webview: vscode.Webview, surface: 'chat' | 'settings'): void {
    this.webviews.add(webview);
    configureWebview(webview, this.extensionUri, surface);
    this.disposables.push(webview.onDidReceiveMessage((raw: unknown) => {
      const parsed = webviewMessageSchema.safeParse(raw);
      if (!parsed.success) { this.post({ version: 1, type: 'error', message: '輸入格式不正確，請檢查模型、路徑與數值。' }, webview); return; }
      void this.handle(parsed.data, webview, surface).catch(error => this.post({ version: 1, type: 'error', requestId: parsed.data.requestId, message: error instanceof Error ? error.message : '操作失敗。' }, webview));
    }));
  }
  private post(message: HostToWebview, target?: vscode.Webview): void {
    for (const webview of target ? [target] : this.webviews) void webview.postMessage(message);
  }
  /** 在 VS Code 終端機執行官方登入／登出，憑證由官方 CLI 寫入該帳號自己的目錄。 */
  private openAccountTerminal(id: string, action: 'login' | 'logout'): void {
    if (!this.accounts) throw new Error('帳號管理尚未就緒。');
    const { name, command, env } = this.accounts.terminal(id, action);
    const terminal = vscode.window.createTerminal({ name, ...(env && { env }) });
    terminal.show(); terminal.sendText(command.map(part => /^[\w./:@=-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' '));
  }
  /** 明確選擇的帳號優先，其次是該 Provider 目前選定的帳號；每個環節（A、B、總結、代替）都各自帶入。 */
  private preferencesFor(provider: AgentId, explicit?: ProviderPreferences, accountId?: string): ProviderPreferences | undefined {
    const preferences = explicit ?? this.settings?.read()[provider];
    if (preferences) this.settings?.validate(provider, preferences);
    if (this.settings && !preferences?.model) throw new Error('請先選擇明確的模型。');
    const account = accountId ?? explicit?.accountId ?? this.accounts?.selected()[provider];
    if (account) this.accounts?.check(provider, account);
    return preferences && account ? { ...preferences, accountId: account } : preferences;
  }
  private snapshot(target?: vscode.Webview): void {
    this.post({ version: 1, type: 'snapshot', snapshot: { ...this.orchestrator.state, discussion: this.discussions.summary(), accounts: this.accounts?.list(), selectedAccounts: this.accounts?.selected(),
      settings: this.settings?.read() ?? defaultSettings,
      models: this.settings?.models ?? { codex: [], claude: claudeModels, loading: false }
    } }, target);
  }
  private async handle(message: WebviewToHost, source: vscode.Webview, surface: 'chat' | 'settings'): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (surface === 'chat') this.resolveReady(); else this.resolveSettingsReady();
        this.snapshot(source);
        if (!this.orchestrator.state.providers.length) { await this.orchestrator.checkProviders(); void this.accounts?.refresh(); }
        if (!this.settings?.models.codex.length) void this.settings?.refreshModels();
        break;
      case 'new-conversation': await this.orchestrator.newConversation(); this.snapshot(source); this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); break;
      case 'open-conversation': await this.orchestrator.openConversation(message.conversationId); this.snapshot(source); this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); break;
      case 'search-conversations': this.post({ version: 1, type: 'conversation-results', requestId: message.requestId, conversations: this.orchestrator.searchConversations(message.query, message.filters) }, source); break;
      case 'rename-conversation': await this.orchestrator.renameConversation(message.conversationId, message.title); break;
      case 'delete-conversation': {
        const answer = await vscode.window.showWarningMessage('刪除此對話及其本機訊息？此操作無法復原。', { modal: true }, '刪除');
        if (answer === '刪除') await this.orchestrator.deleteConversation(message.conversationId); break;
      }
      case 'reject-answer': await this.orchestrator.setRejected(message.taskId, message.rejected); break;
      case 'answer-approval': this.orchestrator.answerApproval(message.approvalId, message.allow); break;
      case 'check-providers': await this.orchestrator.checkProviders(); await this.accounts?.refresh(); break;
      case 'cancel-task': if (this.orchestrator.state.discussionId) await this.discussions.cancel(); else await this.orchestrator.cancel(message.taskId); break;
      case 'clear-conversation': {
        const answer = await vscode.window.showWarningMessage('刪除目前對話的本機聊天紀錄？其他對話與官方 CLI 紀錄不受影響。', { modal: true }, '清除');
        if (answer === '清除') await this.orchestrator.clear();
        break;
      }
      case 'open-settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-workspace.multi-agent-workspace'); break;
      case 'show-options': await this.showOptions(); break;
      case 'refresh-models': await this.settings?.refreshModels(); break;
      case 'save-settings': {
        if (!this.settings) throw new Error('設定服務尚未就緒。');
        await this.settings.save(message.settings); this.snapshot();
        this.post({ version: 1, type: 'settings-saved', requestId: message.requestId }, source);
        break;
      }
      case 'set-provider-preferences': {
        if (!this.settings) throw new Error('設定服務尚未就緒。');
        await this.settings.setProvider(message.provider, message.preferences); this.snapshot();
        this.post({ version: 1, type: 'settings-saved', requestId: message.requestId }, source);
        break;
      }
      case 'authorize-workspace': await this.authorize(); break;
      case 'start-discussion': {
        if (this.approvalPending) throw new Error('請先完成目前的授權對話框。');
        const partner = message.partner ?? message.provider;
        try {
          // A 使用畫面上選定的模型與帳號；B 若為同一 Provider 沿用相同模型，帳號可另外指定。
          const lead = this.preferencesFor(message.provider, message.preferences);
          const partnerPreferences = partner === message.provider ? this.preferencesFor(partner, lead, message.partnerAccountId) : this.preferencesFor(partner, undefined, message.partnerAccountId);
          // 每次討論使用新的 Participant，避免沿用前一次討論的上下文。
          const run = this.discussions.run(message.text, [
            { id: randomUUID(), provider: message.provider, role: 'architect', preferences: lead },
            { id: randomUUID(), provider: partner, role: 'critic', preferences: partnerPreferences }
          ], message.rounds);
          this.snapshot();
          await run;
        }
        finally { this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); }
        break;
      }
      case 'add-account': {
        if (!this.accounts) throw new Error('帳號管理尚未就緒。');
        const account = await this.accounts.add(message.provider, message.name, message.apiKey);
        if (message.apiKey === undefined) this.openAccountTerminal(account.id, 'login'); else await this.accounts.refresh();
        break;
      }
      case 'rename-account': await this.accounts?.rename(message.accountId, message.name); break;
      case 'remove-account': {
        const answer = await vscode.window.showWarningMessage('移除這個帳號？會刪除它在 Multi-Agent 的官方 CLI 設定目錄，需要時可再登入。', { modal: true }, '移除');
        if (answer === '移除') await this.accounts?.remove(message.accountId); break;
      }
      case 'account-terminal': this.openAccountTerminal(message.accountId, message.action); break;
      case 'select-account': await this.accounts?.select(message.provider, message.accountId); break;
      case 'check-accounts': await this.accounts?.refresh(); break;
      case 'export-conversation': {
        const id = this.orchestrator.state.conversationId;
        if (!id || !this.orchestrator.state.tasks.length) throw new Error('目前對話沒有可匯出的內容。');
        await this.orchestrator.flush();
        const data = this.orchestrator.exportConversation(id);
        const target = await vscode.window.showSaveDialog({ title: '匯出對話（含完整訊息，可能包含程式碼或機密，請自行保管）', defaultUri: vscode.Uri.file(`${data.conversation.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.${message.format === 'json' ? 'json' : 'md'}`), filters: message.format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] } });
        if (target) { await writeFile(target.fsPath, message.format === 'json' ? JSON.stringify(data, null, 2) : toMarkdown(data), { mode: 0o600 }); void vscode.window.showInformationMessage('已匯出對話。'); }
        break;
      }
      case 'set-persistence': {
        if (!message.enabled) {
          const answer = await vscode.window.showWarningMessage('停止保存這個專案的對話？之後的新訊息只留在本次視窗，關閉後就不見；已保存的紀錄不會自動刪除。', { modal: true }, '停止保存');
          if (answer !== '停止保存') break;
        }
        await this.orchestrator.setPersistence(message.enabled); break;
      }
      case 'load-earlier': await this.orchestrator.loadEarlier(); break;
      case 'clear-project': {
        const answer = await vscode.window.showWarningMessage(`刪除「${this.orchestrator.state.workspace}」的所有對話與稽核紀錄？其他專案不受影響，此操作無法復原。`, { modal: true }, '刪除');
        if (answer === '刪除') await this.orchestrator.clearProject(); break;
      }
      case 'backup-history': {
        const target = await vscode.window.showSaveDialog({ title: '備份歷史資料庫（含所有專案的完整對話，只存在本機）', defaultUri: vscode.Uri.file(`multi-agent-history-${new Date().toISOString().slice(0, 10)}.sqlite`), filters: { SQLite: ['sqlite'] } });
        if (target) { await this.orchestrator.flush(); await this.orchestrator.backupHistory(target.fsPath); void vscode.window.showInformationMessage('已備份歷史資料庫。'); }
        break;
      }
      case 'restore-history': {
        const [source] = await vscode.window.showOpenDialog({ title: '選擇要還原的備份', canSelectMany: false, filters: { SQLite: ['sqlite'] } }) ?? [];
        if (!source) break;
        const answer = await vscode.window.showWarningMessage('用備份取代目前所有專案的歷史紀錄？目前的資料庫會另存一份 before-restore 檔。', { modal: true }, '還原');
        if (answer !== '還原') break;
        const previous = await this.orchestrator.restoreHistory(source.fsPath);
        void vscode.window.showInformationMessage(`已還原。原本的資料庫另存為 ${previous}`);
        this.snapshot(); break;
      }
      case 'resolve-discussion': {
        if (message.decision === 'substitute') {
          if (!message.provider) throw new Error('請選擇代替的 Provider。');
          this.discussions.resolve(message.discussionId, { type: 'substitute', provider: message.provider, preferences: this.preferencesFor(message.provider) });
        } else this.discussions.resolve(message.discussionId, { type: message.decision });
        break;
      }
      case 'extend-discussion': {
        if (this.approvalPending) throw new Error('請先完成目前的授權對話框。');
        try { const run = this.discussions.extend(message.discussionId, message.rounds); this.snapshot(); await run; }
        finally { this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); }
        break;
      }
      case 'send-message': {
        if (this.approvalPending) throw new Error('請先完成目前的授權對話框。');
        this.orchestrator.assertCanSend(message.provider, message.mode);
        try {
          const preferences = message.preferences ?? this.settings?.read()[message.provider];
          if (preferences) this.settings?.validate(message.provider, preferences);
          if (this.settings && !preferences?.model) throw new Error('請先選擇明確的模型。');
          const approvalMode = message.approvalMode ?? this.settings?.read().approvalMode ?? 'ask';
          const provider = this.orchestrator.state.providers.find(item => item.id === message.provider);
          if (provider?.approvalModes && !provider.approvalModes.includes(approvalMode)) throw new Error('目前 CLI 不支援所選核准模式，請更新 CLI 或改選要求核准。');
          if (approvalMode === 'full-access' && message.mode !== 'read-only' && !this.fullAccessGrants.has(message.provider)) {
            this.approvalPending = true;
            try {
              const answer = await vscode.window.showWarningMessage('完整存取會允許 Agent 存取工作區外的檔案、執行命令與使用網路。本次 VS Code 視窗中要啟用嗎？', { modal: true }, '啟用完整存取');
              if (answer !== '啟用完整存取') return;
              this.fullAccessGrants.add(message.provider);
              await this.orchestrator.auditWorkspace('full-access-granted', message.provider);
            } finally { this.approvalPending = false; }
          }
          if (!message.text && !message.attachments?.length) throw new Error('請輸入訊息或貼上圖片。');
          if (message.attachments?.length && !this.orchestrator.attachmentStore) throw new Error('目前無法保存圖片。');
          const attachments = message.attachments?.length ? await this.orchestrator.attachmentStore!.save(this.orchestrator.state.conversationId!, message.attachments) : undefined;
          const execution = this.orchestrator.send(message.provider, message.text || '請看附加的圖片。', message.mode, preferences, approvalMode, { attachments });
          // 任務已排入原對話；之後切換檢視或背景事件都不再影響這個請求的草稿。
          this.snapshot(); this.post({ version: 1, type: 'request-accepted', requestId: message.requestId }, source);
          await execution;
        }
        finally { this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); }
        break;
      }
    }
  }
  async showOptions(): Promise<void> {
    if (this.settingsPanel) { this.settingsPanel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('multiAgent.settings', 'Multi-Agent 設定', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.settingsPanel = panel;
    this.attach(panel.webview, 'settings');
    this.disposables.push(panel.onDidDispose(() => { this.webviews.delete(panel.webview); if (this.settingsPanel === panel) this.settingsPanel = undefined; }));
  }
  private async authorize(): Promise<void> {
    if (this.approvalPending || this.orchestrator.state.activeTaskId) throw new Error('請先完成或停止目前操作。');
    this.approvalPending = true;
    try {
      const classification = await vscode.window.showQuickPick([
        { label: '個人專案', value: 'personal' as const, description: '可逐一授權本機官方 Provider' },
        { label: '公司專案', value: 'company' as const, description: '預設僅 Claude；請遵守公司資料政策' },
        { label: '限制資料', value: 'restricted' as const, description: '停用所有 Provider 資料傳送' }
      ], { title: '目前工作區的資料分類', placeHolder: this.orchestrator.state.workspace });
      if (!classification) return;
      if (classification.value === 'restricted') { await this.orchestrator.setPolicy({ classification: 'restricted', allowedProviders: [] }); return; }
      const choices = await vscode.window.showQuickPick([
        { label: 'Claude Code', id: 'claude' as AgentId, picked: true },
        { label: 'Codex', id: 'codex' as AgentId, picked: classification.value === 'personal' }
      ], { canPickMany: true, title: '授權 Provider 接收資料及讀寫目前工作區（後續不逐次確認寫檔）' });
      if (!choices) return;
      if (classification.value === 'company' && choices.some(choice => choice.id === 'codex')) {
        const approval = await vscode.window.showWarningMessage('確認公司政策允許目前 Codex 帳號接收此工作區資料？公司 Claude 授權不代表個人 Codex 已獲准。', { modal: true }, '公司政策允許');
        if (approval !== '公司政策允許') return;
      }
      await this.orchestrator.setPolicy({ classification: classification.value, allowedProviders: choices.map(choice => choice.id) });
    } finally { this.approvalPending = false; }
  }
  dispose(): void {
    this.unsubscribe(); if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.settingsPanel?.dispose(); this.webviews.clear();
  }
}
