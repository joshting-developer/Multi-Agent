import * as vscode from 'vscode';
import { webviewMessageSchema, type AgentId, type HostToWebview, type Task, type WebviewToHost } from '../bridge/messages';
import { Orchestrator } from '../orchestration/Orchestrator';
import { HybridCoordinator } from '../orchestration/HybridCoordinator';
import { providerLabel } from '../bridge/labels';
import { DiscussionCoordinator } from '../orchestration/DiscussionCoordinator';
import { randomUUID } from 'node:crypto';
import { SettingsService } from '../settings/SettingsService';
import { claudeModels, defaultSettings, type ProviderPreferences } from '../bridge/settings';
import { configureWebview } from './WebviewDocument';
import type { AccountService } from '../accounts/AccountService';
import { toMarkdown } from '../storage/Export';
import { writeFile } from 'node:fs/promises';
import type { Blocked } from '../execution/ReadRoots';

export class ChatWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly webviews = new Set<vscode.Webview>();
  private settingsPanel?: vscode.WebviewPanel;
  /** 設定頁開著時同步官方額度的週期。 */
  usageSyncMs = 5 * 60_000;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private readonly disposables: vscode.Disposable[] = [];
  /** 視窗重開（Extension 重新啟用）後第一次顯示聊天時先回到歷史對話；之後收合再展開仍停在原對話。 */
  private historyOnStart = true;
  private approvalPending = false;
  private readonly fullAccessGrants = new Set<AgentId>();
  private readonly discussions: DiscussionCoordinator;
  private readonly hybrids: HybridCoordinator;
  private resolveReady: () => void = () => undefined;
  readonly whenReady = new Promise<void>(resolve => { this.resolveReady = resolve; });
  private resolveSettingsReady: () => void = () => undefined;
  readonly whenSettingsReady = new Promise<void>(resolve => { this.resolveSettingsReady = resolve; });
  constructor(private readonly extensionUri: vscode.Uri, private readonly orchestrator: Orchestrator, private readonly settings?: SettingsService, private readonly accounts?: AccountService) {
    this.discussions = new DiscussionCoordinator(orchestrator, () => this.snapshot());
    this.hybrids = new HybridCoordinator(orchestrator, () => this.snapshot());
    this.unsubscribe = orchestrator.subscribe(() => {
      if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.snapshot(); }, 40);
    });
    if (settings) this.disposables.push({ dispose: settings.subscribe(() => this.snapshot()) });
    if (accounts) this.disposables.push({ dispose: accounts.subscribe(() => this.snapshot()) });
    orchestrator.onBlocked = (task, blocked) => { void this.promptBlocked(task, blocked).catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : '無法修改權限。')); };
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
    this.watchLogin(id, action, terminal);
  }
  /**
   * 登入／登出在終端機完成後自動重新檢查這個帳號：每 4 秒一次直到狀態改變，最多 5 分鐘；關閉終端機時再查一次。
   * 狀態變成目標時順便關掉這個終端機；開之前就已是目標狀態、逾時或檢查失敗時保留，讓使用者看得到輸出。
   */
  private watchLogin(id: string, action: 'login' | 'logout', terminal: vscode.Terminal): void {
    const accounts = this.accounts!; const deadline = Date.now() + 5 * 60_000; let running = false;
    const target = action === 'login'; const before = accounts.loggedIn(id);
    const stop = () => { clearInterval(timer); closed.dispose(); };
    const check = async () => {
      if (running) return; running = true;
      try {
        await accounts.refresh([id]);
        if (accounts.loggedIn(id) === target) { stop(); if (before !== target) terminal.dispose(); }
        else if (Date.now() > deadline) stop();
      }
      catch { stop(); } finally { running = false; }
    };
    const timer = setInterval(() => void check(), 4000);
    const closed = vscode.window.onDidCloseTerminal(item => { if (item === terminal) { stop(); void accounts.refresh([id]).catch(() => undefined); } });
    this.disposables.push({ dispose: stop });
    void check();
  }
  /** 選一個允許 Agent 唯讀的工作區外資料夾；defaultFolder 是被擋下的位置。 */
  private async pickReadRoot(defaultFolder?: string): Promise<void> {
    const [folder] = await vscode.window.showOpenDialog({ title: '允許 Agent 讀取這個資料夾（唯讀，只限這個專案）', canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '允許讀取', ...(defaultFolder && { defaultUri: vscode.Uri.file(defaultFolder) }) }) ?? [];
    if (!folder) return;
    const root = await this.orchestrator.addReadRoot(folder.fsPath);
    void vscode.window.showInformationMessage(`已允許讀取 ${root}，重新送出就能讀取。`);
  }
  private readonly asked = new Set<string>();
  /**
   * 命令一被擋下就詢問（MA-145）：一般聊天可「允許並重新執行」，停止目前任務、開放權限後用同樣的帳號與模型送出接續訊息；
   * 「允許」等任務之間才生效。討論與混合只提供「允許」。同一個任務同一種權限只問一次，資料送往哪裡仍由使用者決定。
   */
  private async promptBlocked(task: Task, blocked: Blocked): Promise<void> {
    const keys = blocked.kind === 'read' ? blocked.folders.map(folder => `${task.id}:read:${folder}`) : [`${task.id}:${blocked.kind}`];
    if (keys.every(key => this.asked.has(key))) return;
    for (const key of keys) this.asked.add(key);
    const name = task.provider === 'claude' ? 'Claude' : 'Codex';
    const solo = !task.participantId && !task.discussionId && !task.hybrid;
    const rerun = '允許並重新執行';
    if (blocked.kind === 'browser') {
      // macOS 沙盒內 Chrome 無法啟動，只能用完整存取重跑；完整存取仍要原生確認。
      if (!solo || task.approvalMode === 'full-access') return;
      const answer = await vscode.window.showWarningMessage(`${name} 在沙盒內無法啟動瀏覽器（macOS 沙盒的限制）。要用完整存取重新執行嗎？`, '用完整存取重新執行');
      if (answer && await this.grantFullAccess(task.provider)) await this.rerun(task, '剛才在沙盒內無法啟動瀏覽器，現在改用完整存取。請從中斷的地方繼續。', 'full-access');
      return;
    }
    const what = blocked.kind === 'network' ? '的命令沒有網路可用。要允許這個工作區的 Agent 使用網路嗎？' : `無法讀取工作區外的 ${blocked.folders.join('、')}。要允許這個專案唯讀這些資料夾嗎？`;
    const answer = await vscode.window.showWarningMessage(`${name} ${what}`, ...(solo ? [rerun, '允許'] : ['允許']));
    if (!answer) return;
    if (answer === rerun && this.orchestrator.state.activeTaskId === task.id) await this.orchestrator.cancel(task.id);
    await this.orchestrator.whenIdle();
    if (blocked.kind === 'network') await this.orchestrator.setNetwork(true);
    else for (const folder of blocked.folders) await this.orchestrator.addReadRoot(folder);
    if (answer === rerun) await this.rerun(task, blocked.kind === 'network' ? '剛才的命令因為沒有網路而失敗，現在已開放網路。請從中斷的地方繼續。' : `剛才無法讀取 ${blocked.folders.join('、')}，現在已允許唯讀。請從中斷的地方繼續。`);
    else void vscode.window.showInformationMessage(blocked.kind === 'network' ? '已允許這個工作區使用網路，下一個任務開始生效。' : '已允許讀取，下一個任務開始生效。');
  }
  /** 用原任務的帳號、模型與權限送出接續訊息。 */
  private async rerun(task: Task, text: string, approvalMode = task.approvalMode): Promise<void> {
    await this.orchestrator.whenIdle();
    const preferences = task.model && task.effort ? { model: task.model, effort: task.effort, ...(task.accountId && { accountId: task.accountId }) } : undefined;
    await this.orchestrator.send(task.provider, text, task.mode, preferences, approvalMode ?? 'ask');
  }
  /** 完整存取在這個視窗第一次使用前要原生確認，並寫入稽核紀錄。 */
  private async grantFullAccess(provider: AgentId): Promise<boolean> {
    if (this.fullAccessGrants.has(provider)) return true;
    const answer = await vscode.window.showWarningMessage('完整存取會允許 Agent 存取工作區外的檔案、執行命令與使用網路。本次 VS Code 視窗中要啟用嗎？', { modal: true }, '啟用完整存取');
    if (answer !== '啟用完整存取') return false;
    this.fullAccessGrants.add(provider);
    await this.orchestrator.auditWorkspace('full-access-granted', provider);
    return true;
  }
  /** 明確選擇的帳號優先，其次是該 Provider 目前選定的帳號；每個環節（A、B、總結、代替）都各自帶入。 */
  private preferencesFor(provider: AgentId, explicit?: ProviderPreferences, accountId?: string): ProviderPreferences | undefined {
    // 沒有明確帶入時，先用該帳號記住的設定，再用該 Agent 的預設。
    const own = this.accounts?.preferences(accountId ?? explicit?.accountId ?? this.accounts.selected()[provider]);
    const preferences = explicit ?? (own ? { model: own.model, effort: own.effort } : undefined) ?? this.settings?.read()[provider];
    if (preferences) this.settings?.validate(provider, preferences);
    if (this.settings && !preferences?.model) throw new Error('請先選擇明確的模型。');
    // 每次執行都必須落在 Multi-Agent 自己的帳號；舊版的預設帳號或已移除的帳號改用目前選定的帳號。
    const account = this.accounts?.resolve(provider, accountId ?? explicit?.accountId);
    return preferences && account ? { ...preferences, accountId: account } : preferences;
  }
  private snapshot(target?: vscode.Webview): void {
    this.post({ version: 1, type: 'snapshot', snapshot: { ...this.orchestrator.state, discussion: this.discussions.summary(), hybrid: this.hybrids.summary(), accounts: this.accounts?.list(), selectedAccounts: this.accounts?.selected(),
      settings: this.settings?.read() ?? defaultSettings,
      models: this.settings?.models ?? { codex: [], claude: claudeModels, loading: false }
    } }, target);
  }
  private async handle(message: WebviewToHost, source: vscode.Webview, surface: 'chat' | 'settings'): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (surface === 'chat') this.resolveReady(); else this.resolveSettingsReady();
        this.snapshot(source);
        if (surface === 'chat' && this.historyOnStart) {
          this.historyOnStart = false;
          if (this.orchestrator.state.conversations?.length && !this.orchestrator.state.activeTaskId) this.post({ version: 1, type: 'show-history' }, source);
        }
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
      case 'steer-task': await this.orchestrator.steer(message.taskId, message.text); this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); break;
      case 'cancel-task': if (this.hybrids.running) await this.hybrids.cancel(); else if (this.orchestrator.state.discussionId) await this.discussions.cancel(); else await this.orchestrator.cancel(message.taskId); break;
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
          // A、B 各自用成員面板選的帳號與模型；舊版沒帶 B 的設定時，用 B 帳號記住的設定或該 Agent 的預設。
          const lead = this.preferencesFor(message.provider, message.preferences);
          const partnerPreferences = this.preferencesFor(partner, message.partnerPreferences, message.partnerAccountId);
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
      case 'start-hybrid': {
        if (this.approvalPending) throw new Error('請先完成目前的授權對話框。');
        try {
          // 每個成員各自解析帳號與模型；名稱用帳號名稱加模型，畫面與結論都用這個名稱。
          const members = message.members.map(member => {
            const preferences = this.preferencesFor(member.provider, member.preferences);
            const account = this.accounts?.list().find(item => item.id === preferences?.accountId);
            return { provider: member.provider, preferences, ...(member.approvalMode && { approvalMode: member.approvalMode }), label: [providerLabel(member.provider), account?.name, preferences?.model].filter(Boolean).join(' · ') };
          });
          if (new Set(members.map(member => `${member.provider}:${member.preferences?.accountId}:${member.preferences?.model}`)).size !== members.length) throw new Error('同一個帳號與模型只能加入一次。');
          let approvalMode = message.approvalMode ?? this.settings?.read().approvalMode ?? 'ask';
          // 完整存取需要逐次原生確認，混合模式不代為開啟。
          if (approvalMode === 'full-access') approvalMode = 'ask';
          const run = this.hybrids.run(message.text, members, message.lead, message.mode, approvalMode);
          this.snapshot();
          this.post({ version: 1, type: 'request-accepted', requestId: message.requestId }, source);
          await run;
        }
        finally { this.post({ version: 1, type: 'request-settled', requestId: message.requestId }, source); }
        break;
      }
      case 'add-account': {
        if (!this.accounts) throw new Error('帳號管理尚未就緒。');
        const account = await this.accounts.add(message.provider, message.name ?? '', message.apiKey);
        if (message.apiKey === undefined) this.openAccountTerminal(account.id, 'login'); else await this.accounts.refresh([account.id]);
        break;
      }
      case 'rename-account': await this.accounts?.rename(message.accountId, message.name); break;
      case 'remove-account': {
        const answer = await vscode.window.showWarningMessage('移除這個帳號？會刪除它在 Multi-Agent 的官方 CLI 設定目錄，需要時可再登入。', { modal: true }, '移除');
        if (answer === '移除') await this.accounts?.remove(message.accountId); break;
      }
      case 'account-terminal': this.openAccountTerminal(message.accountId, message.action); break;
      case 'add-read-root': await this.pickReadRoot(); break;
      case 'remove-read-root': await this.orchestrator.removeReadRoot(message.path); break;
      case 'set-network': await this.orchestrator.setNetwork(message.enabled); break;
      case 'set-agent-feature': await this.orchestrator.setFeature(message.feature, message.enabled); break;
      case 'use-reset-credit': {
        if (!this.accounts) throw new Error('帳號管理尚未就緒。');
        const credit = message.creditId ? this.accounts.list().find(item => item.id === message.accountId)?.usage?.resetCreditList?.find(item => item.id === message.creditId) : undefined;
        if (message.creditId && !credit) throw new Error('找不到這張重置券，請重新整理後再選。');
        const which = credit ? `「${credit.title ?? '重置券'}」${credit.expiresAt ? `（${new Date(credit.expiresAt).toLocaleDateString('zh-TW')} 到期）` : ''}` : '一張額度重置券';
        const answer = await vscode.window.showWarningMessage(`使用${which}？會立即重置這個 Codex 帳號目前的額度，用掉後不能退回。`, { modal: true }, '使用');
        if (answer !== '使用') break;
        const outcome = await this.accounts.useResetCredit(message.accountId, message.creditId);
        const text = { reset: '已使用一張重置券，額度已重置。', nothingToReset: '目前的額度不需要重置，沒有用掉重置券。', noCredit: '這個帳號沒有可用的重置券。', alreadyRedeemed: '這次重置已經完成過，沒有再用掉重置券。' }[outcome];
        void (outcome === 'reset' ? vscode.window.showInformationMessage(text) : vscode.window.showWarningMessage(text));
        break;
      }
      case 'select-account': await this.accounts?.select(message.provider, message.accountId); break;
      case 'set-account-preferences': {
        if (!this.accounts) throw new Error('帳號管理尚未就緒。');
        const account = this.accounts.list().find(item => item.id === message.accountId);
        if (!account) throw new Error('找不到這個帳號，請重新選擇。');
        this.settings?.validate(account.provider, message.preferences);
        if (!this.orchestrator.state.providers.find(item => item.id === account.provider)?.approvalModes?.includes(message.preferences.approvalMode) && message.preferences.approvalMode !== 'ask') throw new Error('此 CLI 版本不支援所選核准模式，請更新 CLI。');
        await this.accounts.setPreferences(account.id, message.preferences);
        break;
      }
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
          // 和討論一樣經 preferencesFor 帶入帳號；畫面沒指定時用該來源目前選定的帳號。
          const preferences = this.preferencesFor(message.provider, message.preferences);
          const approvalMode = message.approvalMode ?? this.settings?.read().approvalMode ?? 'ask';
          const provider = this.orchestrator.state.providers.find(item => item.id === message.provider);
          if (provider?.approvalModes && !provider.approvalModes.includes(approvalMode)) throw new Error('目前 CLI 不支援所選核准模式，請更新 CLI 或改選要求核准。');
          if (approvalMode === 'full-access' && message.mode !== 'read-only' && !this.fullAccessGrants.has(message.provider)) {
            this.approvalPending = true;
            try {
              if (!await this.grantFullAccess(message.provider)) return;
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
    const sync = this.syncUsage(panel);
    this.disposables.push(panel.onDidDispose(() => { sync.dispose(); this.webviews.delete(panel.webview); if (this.settingsPanel === panel) this.settingsPanel = undefined; }));
  }
  /** 設定頁顯示中才定期重讀官方額度；切回設定頁時若已過一個週期也立即同步。Claude 沒有免費查詢，維持執行時更新。 */
  private syncUsage(panel: vscode.WebviewPanel): vscode.Disposable {
    let last = Date.now(); let running = false;
    const sync = () => {
      if (!panel.visible || running || !this.accounts || Date.now() - last < this.usageSyncMs - 1000) return;
      running = true; last = Date.now();
      void this.accounts.refreshUsage().catch(() => undefined).finally(() => { running = false; });
    };
    const timer = setInterval(sync, this.usageSyncMs);
    const shown = panel.onDidChangeViewState(sync);
    return { dispose: () => { clearInterval(timer); shown.dispose(); } };
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
      if (classification.value === 'restricted') { await this.orchestrator.setPolicy({ ...this.orchestrator.state.policy, classification: 'restricted', allowedProviders: [] }); return; }
      const choices = await vscode.window.showQuickPick([
        { label: 'Claude Code', id: 'claude' as AgentId, picked: true },
        { label: 'Codex', id: 'codex' as AgentId, picked: classification.value === 'personal' }
      ], { canPickMany: true, title: '授權 Provider 接收資料及讀寫目前工作區（後續不逐次確認寫檔）' });
      if (!choices) return;
      if (classification.value === 'company' && choices.some(choice => choice.id === 'codex')) {
        const approval = await vscode.window.showWarningMessage('確認公司政策允許目前 Codex 帳號接收此工作區資料？公司 Claude 授權不代表個人 Codex 已獲准。', { modal: true }, '公司政策允許');
        if (approval !== '公司政策允許') return;
      }
      await this.orchestrator.setPolicy({ ...this.orchestrator.state.policy, classification: classification.value, allowedProviders: choices.map(choice => choice.id) });
    } finally { this.approvalPending = false; }
  }
  dispose(): void {
    this.unsubscribe(); if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.settingsPanel?.dispose(); this.webviews.clear();
  }
}
