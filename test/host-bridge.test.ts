import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ChatWebviewProvider } from '../src/views/ChatWebviewProvider';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { SessionRepository } from '../src/storage/SessionRepository';
import { createdPanels, window as nativeWindow } from './fixtures/vscode';

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
      const rounds = orchestrator.state.tasks.slice(-2);
      expect(rounds.map(task => [task.mode, task.participantRole, task.roundNo])).toEqual([['read-only', 'architect', 1], ['read-only', 'critic', 2]]);
      expect(rounds[0]!.participantId).not.toBe(rounds[1]!.participantId); expect(orchestrator.state.discussionId).toBeUndefined();
      expect(requests.slice(-2).map(request => request.mode)).toEqual(['read-only', 'read-only']);
      receive!({ version: 1, requestId: 'extend-1', type: 'extend-discussion', discussionId: rounds[0]!.discussionId, rounds: 1 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ version: 1, type: 'request-settled', requestId: 'extend-1' }));
      expect(orchestrator.state.tasks.at(-1)).toMatchObject({ discussionId: rounds[0]!.discussionId, roundNo: 3, participantRole: 'architect', mode: 'read-only' });
      await vi.waitFor(() => expect(postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'snapshot').at(-1)?.snapshot.discussion).toEqual({ id: rounds[0]!.discussionId, status: 'completed', completedRounds: 3, maxRounds: 3 }));
      receive!({ version: 1, requestId: 'options-1', type: 'show-options' });
      await vi.waitFor(() => expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith('multiAgent.settings', 'Multi-Agent 設定', vscode.ViewColumn.Active, expect.anything()));
      expect(createdPanels.at(-1)?.webview.html).toContain('data-surface="settings"');
    } finally { controller.dispose(); await orchestrator.dispose(); }
  });
});
