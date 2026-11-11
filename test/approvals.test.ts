import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import type { AgentRequest } from '../src/agents/AgentAdapter';
import type { AgentId } from '../src/bridge/messages';
class Processes extends ProcessManager {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly provider: AgentId, private readonly scenario = 'ok') { super(); }
  override run(request: ProcessRequest) { this.requests.push(request); return super.run({ ...request, command: process.execPath, args: [resolve('test/fixtures/agent.cjs'), this.provider, this.scenario, ...request.args] }); }
}
const request: AgentRequest = { taskId: 'task', cwd: process.cwd(), prompt: 'synthetic', mode: 'workspace-write', approvalMode: 'ask', model: 'test-model', effort: 'high', timeoutMs: 5000, signal: new AbortController().signal };
describe.each(['codex', 'claude'] as const)('%s official approval protocol', provider => {
  const setup = (scenario = 'approval') => { const processes = new Processes(provider, scenario); return { processes, adapter: provider === 'codex' ? new CodexAppServerAdapter(processes, () => process.execPath, process.cwd()) : new ClaudeCodeAdapter(processes, () => process.execPath, process.cwd()) }; };
  it.each([true, false])('round-trips a human decision (%s)', async allow => {
    const { adapter, processes } = setup(); const status = await adapter.detect();
    expect(status.account?.email).toBe(`${provider}@example.test`); expect(JSON.stringify(status)).not.toContain('secret-must-not-leak');
    const approve = vi.fn(async () => allow); let text = '';
    for await (const event of adapter.execute({ ...request, approve })) if (event.type === 'text-delta') text += event.text;
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('核准'), detail: expect.any(String) }));
    expect(text).toBe(provider === 'codex' ? allow ? 'accept' : 'decline' : allow ? 'allow' : 'deny');
    await processes.dispose();
  });
  it('does not approve a write in read-only mode even with an allow callback', async () => {
    const { adapter, processes } = setup(); await adapter.detect(); const approve = vi.fn(async () => true);
    for await (const event of adapter.execute({ ...request, mode: 'read-only', approve })) void event;
    expect(approve).not.toHaveBeenCalled(); await processes.dispose();
  });
  it('maps auto-review to the native reviewer and full access to explicit CLI settings', async () => {
    const { adapter, processes } = setup('ok'); await adapter.detect();
    for (const approvalMode of ['auto-review', 'full-access'] as const) {
      let text = ''; for await (const event of adapter.execute({ ...request, approvalMode })) if (event.type === 'text-delta') text += event.text;
      if (provider === 'codex') {
        const params = JSON.parse(text); expect(params.approvalsReviewer).toBe(approvalMode === 'auto-review' ? 'auto_review' : 'user');
        expect(params.approvalPolicy).toBe(approvalMode === 'auto-review' ? 'on-request' : 'never');
      } else { const args = processes.requests.at(-1)!.args; expect(args[args.indexOf('--permission-mode') + 1]).toBe(approvalMode === 'auto-review' ? 'auto' : 'bypassPermissions'); }
    }
    await processes.dispose();
  });
});
