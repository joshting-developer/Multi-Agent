import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatWebviewProvider } from '../src/views/ChatWebviewProvider';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { SessionRepository } from '../src/storage/SessionRepository';
import { createdPanels, window as nativeWindow } from './fixtures/vscode';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../src/accounts/AccountService';

describe('Webview to native agent execution', () => {
  it('starts workspace-write directly after workspace authorization without another modal', async () => {
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = {
      id: 'codex', capabilities: () => capabilities,
      detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { requests.push(request); yield { type: 'complete', taskId: request.taskId }; },
      cancel: async () => undefined
    };
    const repository = new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace');
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), repository, '/workspace', () => true, () => 10000);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] });
    await orchestrator.checkProviders();
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator);
    let receive: ((message: unknown) => void) | undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    controller.resolveWebviewView({
      webview: {
        options: {}, cspSource: 'vscode-webview:', html: '',
        asWebviewUri: (uri: vscode.Uri) => uri, postMessage,
        onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() {} }; }
      },
      onDidDispose: () => ({ dispose() {} })
    } as unknown as vscode.WebviewView);
    try {
      receive!({ version: 1, requestId: 'edit-1', type: 'send-message', provider: 'codex', mode: 'workspace-write', text: 'Update source.txt' });
      await vi.waitFor(() => expect(orchestrator.state.tasks[0]?.status).toBe('completed'));
      expect(requests[0]).toMatchObject({ cwd: '/workspace', mode: 'workspace-write', prompt: 'Update source.txt' });
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'edit-1' });
      // 已受理先於完成送出，Webview 依此清掉該請求的草稿，而不是看其他對話的執行狀態。
      const order = postMessage.mock.calls.map(([message]) => message).filter(message => message.requestId === 'edit-1').map(message => message.type);
      expect(order).toEqual(['request-accepted', 'request-settled']);
      nativeWindow.showWarningMessage.mockResolvedValueOnce(undefined);
      receive!({ version: 1, requestId: 'full-cancel', type: 'send-message', provider: 'codex', mode: 'workspace-write', text: 'Synthetic full access', approvalMode: 'full-access' });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'full-cancel' }));
      expect(requests).toHaveLength(1);
      nativeWindow.showWarningMessage.mockResolvedValueOnce('啟用完整存取');
      receive!({ version: 1, requestId: 'full-allow', type: 'send-message', provider: 'codex', mode: 'workspace-write', text: 'Synthetic full access', approvalMode: 'full-access' });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'full-allow' }));
      expect(requests.at(-1)?.approvalMode).toBe('full-access');
      expect(requests).toHaveLength(2);
      receive!({ version: 1, requestId: 'discuss-1', type: 'start-discussion', provider: 'codex', text: 'Synthetic topic', rounds: 2 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'discuss-1' }));
      const rounds = orchestrator.state.tasks.filter(task => task.roundNo).slice(-2);
      expect(rounds.map(task => [task.mode, task.participantRole, task.roundNo])).toEqual([['read-only', 'architect', 1], ['read-only', 'critic', 2]]);
      expect(rounds[0]!.participantId).not.toBe(rounds[1]!.participantId); expect(orchestrator.state.discussionId).toBeUndefined();
      expect(requests.slice(-3).map(request => request.mode)).toEqual(['read-only', 'read-only', 'read-only']);
      expect(orchestrator.state.tasks.at(-1)).toMatchObject({ participantRole: 'summarizer', discussionId: rounds[0]!.discussionId, mode: 'read-only' });
      const beforeExtend = postMessage.mock.calls.length;
      receive!({ version: 1, requestId: 'extend-1', type: 'extend-discussion', discussionId: rounds[0]!.discussionId, rounds: 1 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'extend-1' }));
      expect(orchestrator.state.tasks.filter(task => task.roundNo).at(-1)).toMatchObject({ discussionId: rounds[0]!.discussionId, roundNo: 3, participantRole: 'architect', mode: 'read-only' });
      await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'snapshot').at(-1)?.snapshot.discussion).toEqual({ id: rounds[0]!.discussionId, status: 'completed', completedRounds: 3, maxRounds: 3, summaryTaskId: orchestrator.state.tasks.at(-1)!.id }));
      // 延長後的任何執行中畫面都已是新上限，不會短暫顯示舊的 m。
      const extended = postMessage.mock.calls.slice(beforeExtend).map(([message]) => message).filter(message => message.type === 'snapshot' && message.snapshot.discussion?.status === 'running');
      expect(extended.length).toBeGreaterThan(0); expect(extended.every(message => message.snapshot.discussion.maxRounds === 3)).toBe(true);
      receive!({ version: 1, requestId: 'cross-1', type: 'start-discussion', provider: 'codex', partner: 'claude', text: 'Synthetic topic', rounds: 2 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'error', requestId: 'cross-1', message: expect.stringMatching(/^Claude Code：.*可改用 Codex 單 Agent 討論。$/) }));
      expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'cross-1' });
      receive!({ version: 1, requestId: 'options-1', type: 'show-options' });
      await vi.waitFor(() => expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('multiAgent.settings', 'Multi-Agent 設定', vscode.ViewColumn.Active, expect.anything()));
      expect(createdPanels.at(-1)?.webview.html).toContain('data-surface="settings"');
    } finally { controller.dispose(); await orchestrator.dispose(); }
  });
  it('keeps official quota in sync only while the settings page is visible', async () => {
    const orchestrator = new Orchestrator(new AgentRegistry([]), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 10000);
    const accounts = { refreshUsage: vi.fn(async () => undefined), list: () => [], subscribe: () => () => undefined };
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator, undefined, accounts as never); controller.usageSyncMs = 20;
    try {
      await controller.showOptions(); const panel = createdPanels.at(-1)!;
      await vi.waitFor(() => expect(accounts.refreshUsage.mock.calls.length).toBeGreaterThanOrEqual(2));
      panel.changeViewState(false); const hidden = accounts.refreshUsage.mock.calls.length;
      await new Promise(done => setTimeout(done, 80)); expect(accounts.refreshUsage).toHaveBeenCalledTimes(hidden);
      panel.changeViewState(true); expect(accounts.refreshUsage).toHaveBeenCalledTimes(hidden + 1);
      panel.dispose(); const closed = accounts.refreshUsage.mock.calls.length;
      await new Promise(done => setTimeout(done, 80)); expect(accounts.refreshUsage).toHaveBeenCalledTimes(closed);
    } finally { controller.dispose(); await orchestrator.dispose(); }
  });
  it('closes the login terminal once the account becomes logged in, but not one that already was', async () => {
    const orchestrator = new Orchestrator(new AgentRegistry([]), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 10000);
    const status = new Map<string, boolean>([['old', true]]);
    const accounts = {
      terminal: (id: string) => ({ name: id, command: ['claude', 'auth', 'login'], env: {} }),
      refresh: async (ids: string[]) => { for (const id of ids) status.set(id, true); },
      useResetCredit: vi.fn(async () => 'reset'),
      list: () => [{ id: 'new', usage: { resetCreditList: [{ id: 'soon', title: 'Full reset', expiresAt: new Date(2026, 11, 5).getTime() }] } }],
      loggedIn: (id: string) => status.get(id),
      subscribe: () => () => undefined
    };
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator, undefined, accounts as never);
    let receive: ((message: unknown) => void) | undefined;
    controller.resolveWebviewView({
      webview: { options: {}, cspSource: 'vscode-webview:', html: '', asWebviewUri: (uri: vscode.Uri) => uri, postMessage: vi.fn().mockResolvedValue(true), onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: () => ({ dispose() {} })
    } as unknown as vscode.WebviewView);
    try {
      receive!({ version: 1, requestId: 'login-new', type: 'account-terminal', accountId: 'new', action: 'login' });
      receive!({ version: 1, requestId: 'login-old', type: 'account-terminal', accountId: 'old', action: 'login' });
      await vi.waitFor(() => expect(nativeWindow.createTerminal).toHaveBeenCalledTimes(2));
      const [fresh, existing] = nativeWindow.createTerminal.mock.results.map(result => result.value as { dispose: ReturnType<typeof vi.fn> });
      await vi.waitFor(() => expect(fresh!.dispose).toHaveBeenCalled());
      expect(existing!.dispose).not.toHaveBeenCalled();
      // 重置券要先在原生視窗確認；取消時不呼叫官方 API。
      nativeWindow.showWarningMessage.mockResolvedValueOnce(undefined);
      receive!({ version: 1, requestId: 'reset-cancel', type: 'use-reset-credit', accountId: 'new' });
      await vi.waitFor(() => expect(nativeWindow.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('重置券'), { modal: true }, '使用'));
      nativeWindow.showWarningMessage.mockResolvedValueOnce('使用');
      receive!({ version: 1, requestId: 'reset-ok', type: 'use-reset-credit', accountId: 'new' });
      await vi.waitFor(() => expect(accounts.useResetCredit).toHaveBeenCalledTimes(1));
      expect(accounts.useResetCredit).toHaveBeenCalledWith('new', undefined);
      // 指定某張券時，確認視窗寫出是哪一張；不在清單上的券不送出。
      nativeWindow.showWarningMessage.mockResolvedValueOnce('使用');
      receive!({ version: 1, requestId: 'reset-one', type: 'use-reset-credit', accountId: 'new', creditId: 'soon' });
      await vi.waitFor(() => expect(accounts.useResetCredit).toHaveBeenCalledWith('new', 'soon'));
      expect(nativeWindow.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('「Full reset」（2026/12/5 到期）'), { modal: true }, '使用');
      receive!({ version: 1, requestId: 'reset-unknown', type: 'use-reset-credit', accountId: 'new', creditId: 'gone' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(accounts.useResetCredit).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(nativeWindow.showInformationMessage).toHaveBeenCalledWith('已使用一張重置券，額度已重置。'));
    } finally { controller.dispose(); await orchestrator.dispose(); }
  });
  it('runs a chat message on the selected account when the composer does not name one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-agent-chat-account-'));
    const envs: (Record<string, string> | undefined)[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = {
      id: 'codex', accountEnvKey: 'CODEX_HOME', capabilities: () => capabilities,
      detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { envs.push(request.env); yield { type: 'complete', taskId: request.taskId }; },
      cancel: async () => undefined
    };
    const registry = new AgentRegistry([adapter]);
    let state: unknown;
    const accounts = new AccountService({ get: <T>() => state as T, update: async (_key: string, value: unknown) => { state = value; } }, root, registry);
    const orchestrator = new Orchestrator(registry, new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 10000, () => undefined, (provider, accountId) => accounts.env(provider, accountId));
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    const first = await accounts.add('codex', 'first'); const chosen = await accounts.add('codex', 'chosen'); await accounts.select('codex', chosen.id);
    const settings = { read: () => ({ codex: { model: 'test-model', effort: 'low' } }), validate: () => undefined, subscribe: () => () => undefined };
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator, settings as never, accounts);
    let receive: ((message: unknown) => void) | undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    controller.resolveWebviewView({
      webview: { options: {}, cspSource: 'vscode-webview:', html: '', asWebviewUri: (uri: vscode.Uri) => uri, postMessage, onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: () => ({ dispose() {} })
    } as unknown as vscode.WebviewView);
    try {
      receive!({ version: 1, requestId: 'chat-1', type: 'send-message', provider: 'codex', mode: 'read-only', text: 'hello', preferences: { model: 'test-model', effort: 'low' } });
      await vi.waitFor(() => expect(orchestrator.state.tasks[0]?.status).toBe('completed'));
      expect(orchestrator.state.tasks[0]?.accountId).toBe(chosen.id);
      expect(envs[0]?.CODEX_HOME).toBe(join(root, chosen.id)); expect(envs[0]?.CODEX_HOME).not.toBe(join(root, first.id));
    } finally { controller.dispose(); await orchestrator.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});

describe('Asking for blocked permissions while a task runs', () => {
  it('asks as soon as a command has no network, then stops, allows and continues with the same account', async () => {
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = {
      id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool', taskId: request.taskId, id: 'c', tool: 'commandExecution', phase: 'end', success: false, input: 'curl https://example.com', output: 'curl: (6) Could not resolve host: example.com' };
          // 第一個任務在被停止前一直執行，確認詢問是在執行中跳出。
          await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
        }
        yield { type: 'complete', taskId: request.taskId };
      },
      cancel: async () => undefined
    };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 0);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator);
    nativeWindow.showWarningMessage.mockReset(); nativeWindow.showWarningMessage.mockImplementation(async () => '允許並重新執行');
    try {
      const first = orchestrator.send('codex', '抓網頁', 'workspace-write', { model: 'm', effort: 'high', accountId: 'acc' }, 'auto-review');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      await first;
      expect(nativeWindow.showWarningMessage).toHaveBeenCalledWith('Codex 的命令沒有網路可用。要允許這個工作區的 Agent 使用網路嗎？', '允許並重新執行', '允許');
      expect(orchestrator.state.tasks[0]!.status).toBe('cancelled'); expect(orchestrator.state.policy.network).toBe(true);
      // 接續的任務沿用原本的帳號、模型、權限與核准方式，並帶著網路。
      expect(requests[1]).toMatchObject({ network: true, mode: 'workspace-write', approvalMode: 'auto-review', model: 'm', effort: 'high' });
      expect(orchestrator.state.tasks[1]).toMatchObject({ prompt: '剛才的命令因為沒有網路而失敗，現在已開放網路。請從中斷的地方繼續。', accountId: 'acc' });
      expect(nativeWindow.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally { controller.dispose(); await orchestrator.dispose(); nativeWindow.showWarningMessage.mockReset(); }
  });
  it('turns on operating this Mac only after a native confirmation', async () => {
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = { id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }), async *execute(request) { yield { type: 'complete', taskId: request.taskId }; }, cancel: async () => undefined };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 0);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    const controller = new ChatWebviewProvider(vscode.Uri.file('/extension'), orchestrator);
    let receive: ((message: unknown) => void) | undefined; const postMessage = vi.fn().mockResolvedValue(true);
    controller.resolveWebviewView({ webview: { options: {}, cspSource: 'vscode-webview:', html: '', asWebviewUri: (uri: vscode.Uri) => uri, postMessage, onDidReceiveMessage: (handler: (message: unknown) => void) => { receive = handler; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }) } as unknown as vscode.WebviewView);
    try {
      nativeWindow.showWarningMessage.mockReset(); nativeWindow.showWarningMessage.mockResolvedValueOnce(undefined);
      receive!({ version: 1, requestId: 'h1', type: 'set-agent-feature', feature: 'host', enabled: true });
      await vi.waitFor(() => expect(nativeWindow.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('在沙盒外執行命令'), { modal: true }, '開啟'));
      await new Promise(resolve => setTimeout(resolve, 20)); expect(orchestrator.state.policy.features).toBeUndefined();
      nativeWindow.showWarningMessage.mockResolvedValueOnce('開啟');
      receive!({ version: 1, requestId: 'h2', type: 'set-agent-feature', feature: 'host', enabled: true });
      await vi.waitFor(() => expect(orchestrator.state.policy.features).toEqual(['host']));
      // 關閉不需要確認。
      receive!({ version: 1, requestId: 'h3', type: 'set-agent-feature', feature: 'host', enabled: false });
      await vi.waitFor(() => expect(orchestrator.state.policy.features).toBeUndefined()); expect(nativeWindow.showWarningMessage).toHaveBeenCalledTimes(2);
    } finally { controller.dispose(); await orchestrator.dispose(); nativeWindow.showWarningMessage.mockReset(); }
  });
});
