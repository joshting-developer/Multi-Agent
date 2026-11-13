import type { ProviderStatus } from '../bridge/messages';
import { protectedPatterns } from '../execution/ExecutionPolicy';
import type { AgentRequest } from './AgentAdapter';
import { CliAdapter, friendlyFailure, record, type ParsedEvent, type StreamState } from './CliAdapter';

export class ClaudeCodeAdapter extends CliAdapter {
  readonly id = 'claude' as const;
  protected async inspect(command: string): Promise<ProviderStatus> {
    const version = await this.probe(command, ['--version']);
    const help = await this.probe(command, ['--help']);
    this.help = help.stdout;
    const compatible = ['--restricted', '--safe-mode', '--tools', '--strict-mcp-config', '--include-partial-messages', '--settings', '--no-session-persistence'].every(flag => this.help.includes(flag));
    const capabilities = { streaming: compatible, readOnly: compatible, workspaceWrite: compatible, resumeSession: false, toolApproval: true, structuredOutput: true };
    if (!compatible) return { id: this.id, status: 'installed', version: version.stdout.trim(), reason: '此版本缺少 restricted / safe-mode 或串流能力，請更新 Claude Code。', capabilities };
    const auth = await this.probe(command, ['auth', 'status']);
    let loggedIn = false;
    let identity: Record<string, unknown> = {};
    try { identity = record(JSON.parse(auth.stdout)); loggedIn = identity.loggedIn === true; } catch { /* Unknown auth format cannot establish readiness. */ }
    return { id: this.id, version: version.stdout.trim(), capabilities, approvalModes: this.help.includes('auto') ? ['ask', 'auto-review', 'full-access'] : ['ask', 'full-access'],
      account: loggedIn ? { type: typeof identity.authMethod === 'string' ? identity.authMethod : 'Claude CLI', email: typeof identity.email === 'string' ? identity.email : undefined, organization: typeof identity.orgName === 'string' ? identity.orgName : undefined, plan: typeof identity.subscriptionType === 'string' ? identity.subscriptionType : undefined } : undefined, status: loggedIn && auth.code === 0 ? 'ready' : 'installed', reason: loggedIn ? undefined : '尚未登入。請在終端執行 claude auth login，完成後重新檢查。' };
  }
  protected arguments(request: AgentRequest): string[] {
    if (request.effort && !this.help.includes('--effort')) throw new Error('此 Claude Code 版本不支援推理強度，請更新 CLI。');
    const interactive = !!request.approvalMode;
    const tools = request.mode === 'workspace-write' ? (interactive ? 'Read,Glob,Grep,Edit,Write,Bash' : 'Read,Glob,Grep,Edit,Write') : 'Read,Glob,Grep';
    const permission = request.mode === 'read-only' ? 'plan' : request.approvalMode === 'full-access' ? 'bypassPermissions' : request.approvalMode === 'auto-review' ? 'auto' : interactive ? 'manual' : 'dontAsk';
    if (request.approvalMode === 'auto-review' && !this.detected?.approvalModes?.includes('auto-review')) throw new Error('此 Claude CLI 不支援代我核准，請更新 CLI。');
    const deny = protectedPatterns.flatMap(pattern => ['Read', 'Edit', 'Write', 'Grep', 'Glob'].map(tool => `${tool}(${pattern})`));
    return ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--effort', request.effort] : []),
      ...(request.approvalMode === 'full-access' && request.mode !== 'read-only' ? ['--dangerously-skip-permissions'] : ['--restricted']),
      '--safe-mode', '--tools', tools, '--allowedTools', interactive ? 'Read,Glob,Grep' : tools,
      ...(interactive ? ['--input-format', 'stream-json', '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio'] : []),
      '--permission-mode', permission,
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence',
      // --safe-mode 實測已不讀 auto-memory；仍明確關掉, 避免 Participant 之間或與使用者自己的 Claude Code 經由專案記憶互相讀寫。
      '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, permissions: { deny } })];
  }
  protected override inputStream(request: AgentRequest) {
    if (!request.approvalMode) return undefined;
    return (send: (value: string) => void) => {
      send(JSON.stringify({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } }) + '\n');
      send(JSON.stringify({ type: 'user', session_id: '', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null }) + '\n');
    };
  }
  protected override async handleControl(line: Record<string, unknown>, request: AgentRequest, send: (value: string) => void): Promise<boolean> {
    if (line.type === 'control_response') {
      if (record(line.response).subtype === 'error') throw new Error('Claude 串流初始化或權限設定失敗，請更新 CLI。');
      return true;
    }
    if (line.type !== 'control_request') return false;
    const control = record(line.request);
    if (control.subtype !== 'can_use_tool') {
      send(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: line.request_id, error: 'Unsupported control request' } }) + '\n'); return true;
    }
    const allow = request.mode !== 'read-only' && !!request.approve && await request.approve({ title: `核准 Claude 工具：${String(control.tool_name)}`, detail: JSON.stringify(control.input, null, 2) });
    send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: line.request_id, response: allow ? { behavior: 'allow', updatedInput: control.input } : { behavior: 'deny', message: '使用者拒絕或取消此動作。' } } }) + '\n');
    return true;
  }
  protected parse(line: Record<string, unknown>, state: StreamState): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    if (typeof line.session_id === 'string') state.sessionId = line.session_id;
    if (line.type === 'stream_event') {
      const event = record(line.event);
      if (event.type === 'message_start') state.text = '';
      const delta = record(event.delta);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        state.text += delta.text; state.emitted = true;
        events.push({ type: 'text-delta', text: delta.text });
      }
      const block = record(event.content_block);
      if (block.type === 'tool_use') events.push({ type: 'activity', text: `使用工具：${String(block.name)}` });
    }
    if (line.type === 'assistant') {
      const content = record(line.message).content;
      const text = Array.isArray(content) ? content.map(record).filter(block => block.type === 'text').map(block => String(block.text ?? '')).join('') : '';
      // Older releases may emit complete assistant messages but no partial deltas.
      if (text && !state.text) { events.push({ type: 'text-delta', text }); state.emitted = true; }
      state.text = ''; // Next assistant message can stream independently.
    }
    if (line.type === 'result') {
      if (line.is_error || (typeof line.subtype === 'string' && line.subtype !== 'success')) throw new Error(friendlyFailure(JSON.stringify(line)));
      if (!state.emitted && typeof line.result === 'string') events.push({ type: 'text-delta', text: line.result });
      state.completed = true;
    }
    return events;
  }
}
