import type { ProviderStatus } from '../bridge/messages';
import { protectedPatterns } from '../execution/ExecutionPolicy';
import type { AgentRequest } from './AgentAdapter';
import { CliAdapter, friendlyFailure, record, type ParsedEvent, type StreamState } from './CliAdapter';

export class CodexAdapter extends CliAdapter {
  readonly id = 'codex' as const;
  protected featureNames = new Set<string>();
  protected async inspect(command: string): Promise<ProviderStatus> {
    const version = await this.probe(command, ['--version']);
    const help = await this.probe(command, ['exec', '--help']);
    this.help = help.stdout;
    const features = await this.probe(command, ['features', 'list']);
    this.featureNames = new Set(features.stdout.split('\n').filter(line => !/\sremoved\s/.test(line)).map(line => line.trim().split(/\s+/)[0] ?? ''));
    const match = version.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
    const modern = !!match && (Number(match[1]) > 0 || Number(match[2]) >= 138);
    const compatible = modern && ['--json', '--ignore-user-config', '--ephemeral'].every(flag => this.help.includes(flag)) && this.featureNames.has('shell_tool') && this.featureNames.has('multi_agent');
    const capabilities = { streaming: compatible, readOnly: compatible, workspaceWrite: compatible, resumeSession: false, toolApproval: false, structuredOutput: true };
    if (!compatible) return { id: this.id, status: 'installed', version: version.stdout.trim(), reason: '需要支援 permission profiles、ignore-user-config、shell_tool 的新版 Codex（至少 0.138）。', capabilities };
    const auth = await this.probe(command, ['login', 'status']);
    const loggedIn = auth.code === 0 && /logged in|authenticated/i.test(auth.stdout + auth.stderr);
    return { id: this.id, version: version.stdout.trim(), capabilities, status: loggedIn ? 'ready' : 'installed', reason: loggedIn ? undefined : '尚未登入。請在終端執行 codex login，完成後重新檢查。' };
  }
  protected arguments(request: AgentRequest): string[] {
    // Pass the complete table as one TOML value. CLI dotted overrides do not
    // reliably preserve quoted filesystem keys containing dots and slashes.
    const rules = [
      `"."="${request.mode === 'workspace-write' ? 'write' : 'read'}"`,
      '".git"="read"', '".agents"="read"', '".vscode"="read"',
      ...protectedPatterns.map(pattern => `${JSON.stringify(pattern)}="deny"`)
    ];
    const profile = `permissions.multi_agent={filesystem={":minimal"="read",":workspace_roots"={${rules.join(',')}}},network={enabled=false}}`;
    const settings: string[] = [
      'approval_policy="never"', 'default_permissions="multi_agent"', profile,
      'mcp_servers={}', 'web_search="disabled"',
      'shell_environment_policy.inherit="core"',
      'analytics.enabled=false', 'feedback.enabled=false'
    ];
    // Native Codex tools perform file reads, edits and local command execution.
    // Keep engine internals enabled; this extension only coordinates invocations.
    settings.push('features.shell_tool=true');
    if (this.featureNames.has('unified_exec')) settings.push('features.unified_exec=true');
    const disable = ['multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'image_generation', 'view_image', 'workspace_dependencies', 'memories', 'skill_search', 'skill_mcp_dependency_install', 'goals'];
    for (const feature of disable) if (this.featureNames.has(feature)) settings.push(`features.${feature}=false`);
    if (request.effort) settings.push(`model_reasoning_effort=${JSON.stringify(request.effort)}`);
    return ['exec', '--json', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
      ...(request.model ? ['--model', request.model] : []),
      ...settings.flatMap(setting => ['-c', setting]), '-'];
  }
  protected parse(line: Record<string, unknown>, state: StreamState): ParsedEvent[] {
    if (line.type === 'thread.started' && typeof line.thread_id === 'string') state.sessionId = line.thread_id;
    if (line.type === 'error' || line.type === 'turn.failed') throw new Error(friendlyFailure(JSON.stringify(line)));
    if (line.type === 'turn.completed') state.completed = true;
    const item = record(line.item);
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      const id = String(item.id ?? 'message');
      const previous = state.itemText.get(id) ?? '';
      if (!item.text.startsWith(previous)) throw new Error('Codex 串流文字格式已變更，請更新插件。');
      const delta = item.text.slice(previous.length);
      state.itemText.set(id, item.text);
      return delta ? [{ type: 'text-delta', text: delta }] : [];
    }
    if (line.type === 'item.started' && typeof item.type === 'string') return [{ type: 'activity', text: `處理中：${item.type}` }];
    if (line.type === 'turn.started') return [{ type: 'activity', text: 'Provider 正在處理…' }];
    return [];
  }
}
