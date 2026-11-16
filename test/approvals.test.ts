import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ClaudeCodeAdapter, usageLabel } from '../src/agents/ClaudeCodeAdapter';
import { SessionUnavailable } from '../src/agents/CliAdapter';
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
    // 偵測不讀官方預設目錄的登入；帳號資訊改由設定 → 帳號依各自目錄查詢。
    expect(status.account).toBeUndefined(); expect(JSON.stringify(status)).not.toContain('secret-must-not-leak');
    const approve = vi.fn(async () => allow); let text = '';
    for await (const event of adapter.execute({ ...request, approve })) if (event.type === 'text-delta') text += event.text;
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('核准'), detail: expect.any(String) }));
    expect(text).toBe(provider === 'codex' ? allow ? 'accept' : 'decline' : allow ? 'allow' : 'deny');
    await processes.dispose();
  });
  it('reports each tool with a stable id, readable input, result and success', async () => {
    const { adapter, processes } = setup('tools'); await adapter.detect();
    const tools = []; for await (const event of adapter.execute({ ...request, approvalMode: undefined })) if (event.type === 'tool') tools.push(event);
    expect(tools).toEqual(provider === 'codex'
      ? [{ type: 'tool', taskId: 'task', id: 'c', tool: 'commandExecution', phase: 'start', input: 'ls missing' }, { type: 'tool', taskId: 'task', id: 'c', tool: 'commandExecution', phase: 'end', input: 'ls missing', success: false, output: 'No such file' }]
      : [{ type: 'tool', taskId: 'task', id: 'tu1', tool: 'Read', phase: 'start' }, { type: 'tool', taskId: 'task', id: 'tu1', tool: 'Read', phase: 'start', input: 'notes.txt' }, { type: 'tool', taskId: 'task', id: 'tu1', tool: 'Read', phase: 'end', success: true, output: 'file body' }]);
    await processes.dispose();
  });
  it('sends pasted images through the official multimodal input', async () => {
    const { adapter, processes } = setup('images'); await adapter.detect();
    let text = ''; for await (const event of adapter.execute({ ...request, approvalMode: undefined, prompt: '這是什麼？', images: [{ mime: 'image/png', data: 'aGVsbG8=' }] })) if (event.type === 'text-delta') text += event.text;
    expect(JSON.parse(text)).toEqual(provider === 'codex' ? ['data:image/png;base64,', 'text'] : ['base64:image/png:8', '這是什麼？']);
    await processes.dispose();
  });
  it('reports official usage windows reported during a Claude run', async () => {
    if (provider !== 'claude') return;
    const { adapter, processes } = setup('usage'); await adapter.detect();
    const usage = []; for await (const event of adapter.execute({ ...request, approvalMode: undefined })) if (event.type === 'usage') usage.push(event.usage);
    expect(usage).toEqual([{ windows: [{ label: '5 小時', usedPercent: 25, resetsAt: 1794632400000 }, { label: '7 天', usedPercent: 90, resetsAt: 1794916800000 }, { label: '7 天（含額外用量）', usedPercent: 4, resetsAt: 1794916800000 }], updatedAt: expect.any(Number), source: 'last-run', blocked: false }]);
    await processes.dispose();
  });
  it('steers a running Codex turn through the official turn/steer and survives a rejected steer', async () => {
    if (provider !== 'codex') return;
    const { adapter, processes } = setup('steer'); const status = await adapter.detect();
    expect(status.capabilities.steer).toBe(true);
    const codex = adapter as CodexAppServerAdapter; let text = ''; let rejected: unknown;
    for await (const event of adapter.execute({ ...request, approvalMode: undefined })) {
      if (event.type !== 'text-delta') continue;
      text += event.text;
      // 實際由 Orchestrator 另外呼叫，這裡不等待以免卡住事件迴圈。
      if (event.text === 'working;') void codex.steer('task', 'reject').catch(error => { rejected = error; }).then(() => codex.steer('task', '也看測試'));
    }
    expect(rejected).toBeInstanceOf(Error); expect(String(rejected)).toContain('Codex 沒有接受補充');
    expect(text).toBe('working;steered:也看測試');
    await expect(codex.steer('task', 'late')).rejects.toThrow('請改為排隊送出');
    await processes.dispose();
  });
  it('shows each Codex file change as add, update or delete with the moved path', async () => {
    if (provider !== 'codex') return;
    const { adapter, processes } = setup('changes'); await adapter.detect();
    const inputs: string[] = [];
    for await (const event of adapter.execute({ ...request, approvalMode: undefined })) if (event.type === 'tool' && event.input) inputs.push(event.input);
    expect(inputs.at(-1)).toBe('新增 a.txt\n修改 b.txt → c.txt\n刪除 d.txt');
    await processes.dispose();
  });
  it('turns unknown Claude usage codes into readable labels', () => {
    expect([usageLabel('seven_day_opus'), usageLabel('seven_day_new_scope'), usageLabel('monthly_cap')]).toEqual(['7 天（Opus）', '7 天（new scope）', 'monthly cap']);
  });
  it('does not approve a write in read-only mode even with an allow callback', async () => {
    const { adapter, processes } = setup(); await adapter.detect(); const approve = vi.fn(async () => true);
    for await (const event of adapter.execute({ ...request, mode: 'read-only', approve })) void event;
    expect(approve).not.toHaveBeenCalled(); await processes.dispose();
  });
  it('keeps a native session only when asked and resumes it by id', async () => {
    const { adapter, processes } = setup('ok'); const status = await adapter.detect();
    expect(status.capabilities.resumeSession).toBe(true);
    const run = async (extra: Partial<AgentRequest>) => { let text = ''; for await (const event of adapter.execute({ ...request, approvalMode: 'auto-review', ...extra })) if (event.type === 'text-delta') text += event.text; return text; };
    if (provider === 'codex') {
      expect(JSON.parse(await run({}))).toMatchObject({ ephemeral: true });
      expect(JSON.parse(await run({ persist: true }))).toMatchObject({ ephemeral: false });
      expect(JSON.parse(await run({ persist: true, resumeSessionId: 'thread-1' }))).toMatchObject({ resumed: true, threadId: 'thread-1', excludeTurns: true });
      await expect(run({ persist: true, resumeSessionId: 'missing' })).rejects.toBeInstanceOf(SessionUnavailable);
    } else {
      const args = async (extra: Partial<AgentRequest>) => { await run(extra); return processes.requests.at(-1)!.args; };
      expect(await args({})).toContain('--no-session-persistence');
      expect(await args({ persist: true })).not.toContain('--no-session-persistence');
      const resumed = await args({ persist: true, resumeSessionId: 'session-1' });
      expect(resumed[resumed.indexOf('--resume') + 1]).toBe('session-1'); expect(resumed).not.toContain('--no-session-persistence');
    }
    await processes.dispose();
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
