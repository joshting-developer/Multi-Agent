import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { CodexAdapter } from '../src/agents/CodexAdapter';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
import type { AgentAdapter, AgentEvent, AgentRequest } from '../src/agents/AgentAdapter';
import type { AgentId } from '../src/bridge/messages';
import { failureKind, ProviderFailure } from '../src/agents/CliAdapter';
export class FixtureProcesses extends ProcessManager {
  readonly requests: ProcessRequest[] = [];
  constructor(readonly provider: AgentId, readonly scenario = 'ok') { super(); }
  override run(request: ProcessRequest) {
    this.requests.push(request);
    return super.run({ ...request, command: process.execPath, args: [resolve('test/fixtures/agent.cjs'), this.provider, this.scenario, ...request.args] });
  }
}
const make = (id: AgentId, scenario = 'ok') => {
  const manager = new FixtureProcesses(id, scenario);
  return { manager, adapter: id === 'claude' ? new ClaudeCodeAdapter(manager, () => process.execPath, process.cwd()) : new CodexAdapter(manager, () => process.execPath, process.cwd()) };
};
const request: AgentRequest = { taskId: 'task', prompt: 'Hello', cwd: process.cwd(), mode: 'read-only', timeoutMs: 3000, signal: new AbortController().signal };
async function execute(adapter: AgentAdapter): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.execute(request)) events.push(event);
  return events;
}
describe.each(['claude', 'codex'] as const)('%s adapter', id => {
  it('detects auth and streams without duplicating final text', async () => {
    const { adapter, manager } = make(id);
    expect((await adapter.detect()).status).toBe('ready');
    const events = await execute(adapter);
    expect(events.filter(event => event.type === 'text-delta').map(event => event.text).join('')).toBe('Hello 世界');
    expect(events.at(-1)).toMatchObject({ type: 'complete', sessionId: `${id}-session` });
    expect(manager.requests.at(-1)?.input).toBe('Hello');
    const args = manager.requests.at(-1)!.args;
    expect(args.join(' ')).not.toMatch(/yolo|dangerously|bypass/);
    if (id === 'codex') {
      expect(args).toContain('features.shell_tool=true'); expect(args).toContain('features.unified_exec=true');
      expect(args).not.toContain('features.code_mode_host=false');
      expect(args).toContain('features.multi_agent=false'); expect(args).toContain('default_permissions="multi_agent"');
      expect(args.find(value => value.startsWith('permissions.multi_agent={'))).toContain('"."="read"');
      expect(args).not.toContain('--ignore-rules'); expect(args).not.toContain('project_doc_max_bytes=0');
    }
    else {
      expect(args).toContain('--restricted'); expect(args).toContain('--safe-mode'); expect(args).toContain('Read,Glob,Grep');
      expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toMatchObject({ autoMemoryEnabled: false });
    }
  });
  it('does not read the default login during detection and reports a missing login when it runs', async () => {
    const { adapter, manager } = make(id, 'unauthenticated');
    expect((await adapter.detect()).status).toBe('ready');
    expect(manager.requests.some(request => request.args.includes('status'))).toBe(false);
    await expect(execute(adapter)).rejects.toThrow(/登入/);
  });
  it('reports quota without leaking stderr secrets', async () => {
    const { adapter } = make(id, 'exit'); await adapter.detect();
    await expect(execute(adapter)).rejects.toThrow(/額度/);
    await expect(execute(adapter)).rejects.toMatchObject({ kind: 'quota' });
    await expect(execute(adapter)).rejects.toBeInstanceOf(ProviderFailure);
    await expect(execute(adapter)).rejects.not.toThrow(/secret-token/);
  });
  it('rejects malformed output', async () => {
    const { adapter } = make(id, 'invalid'); await adapter.detect();
    await expect(execute(adapter)).rejects.toThrow(/JSONL/);
  });
  it('fails closed when an older CLI lacks required safety flags', async () => {
    const { adapter, manager } = make(id, 'old');
    expect((await adapter.detect()).status).toBe('installed');
    await expect(execute(adapter)).rejects.toThrow(/版本|需要/);
    expect(manager.requests.some(request => request.input === 'Hello')).toBe(false);
  });
  it('uses native workspace-write tools when the request permits editing', async () => {
    const { adapter, manager } = make(id); await adapter.detect();
    expect(adapter.capabilities().workspaceWrite).toBe(true);
    for await (const event of adapter.execute({ ...request, mode: 'workspace-write' })) void event;
    const args = manager.requests.at(-1)!.args;
    if (id === 'codex') {
      expect(args.find(value => value.startsWith('permissions.multi_agent={'))).toContain('"."="write"');
      expect(args).toContain('features.shell_tool=true');
    } else expect(args).toContain('Read,Glob,Grep,Edit,Write');
  });
  it('passes the selected model and effort literally to the official CLI', async () => {
    const { adapter, manager } = make(id); await adapter.detect();
    const model = id === 'codex' ? 'test-model' : 'opus';
    for await (const event of adapter.execute({ ...request, model, effort: 'high' })) void event;
    const args = manager.requests.at(-1)!.args;
    expect(args[args.indexOf('--model') + 1]).toBe(model);
    if (id === 'codex') expect(args).toContain('model_reasoning_effort="high"');
    else expect(args[args.indexOf('--effort') + 1]).toBe('high');
    expect(manager.requests.at(-1)?.input).toBe('Hello');
  });
});
describe('Codex compatibility', () => {
  it('tolerates future event types and sustained output', async () => {
    const { adapter } = make('codex', 'flood'); await adapter.detect();
    const events = await execute(adapter);
    expect(events).toContainEqual({ taskId: 'task', type: 'text-delta', text: 'done' });
  });
  it('does not accept a missing turn.completed as success', async () => {
    const { adapter } = make('codex', 'incomplete'); await adapter.detect();
    await expect(execute(adapter)).rejects.toThrow(/完成事件/);
  });
  it('handles a missing executable', async () => {
    const adapter = new CodexAdapter(new ProcessManager(), () => '/nonexistent/codex', process.cwd());
    expect((await adapter.detect()).status).toBe('not-installed');
  });
});
describe('Provider failure kinds', () => {
  it('separates exhausted quota from temporary rate limits without matching translated text', () => {
    expect(failureKind("You've hit your usage limit. Try again at 5pm.")).toBe('quota');
    expect(failureKind('insufficient_quota: billing hard limit')).toBe('quota');
    expect(failureKind('HTTP 429 Too Many Requests')).toBe('rate-limit');
    expect(failureKind('rate_limit_error: overloaded')).toBe('rate-limit');
    expect(failureKind('401 unauthorized, please log in')).toBeUndefined();
    expect(failureKind('network timed out')).toBeUndefined();
  });
});
