import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { ProviderFailure } from '../src/agents/CliAdapter';
import type { AgentId, ProviderStatus } from '../src/bridge/messages';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { HybridCoordinator, parsePlan, type HybridMemberInput } from '../src/orchestration/HybridCoordinator';
import { SessionRepository } from '../src/storage/SessionRepository';

const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
/** 依 prompt 的階段回應：規劃的 prompt 以 json 區塊結尾，這時回傳 plan（同一 Provider 的歷史會帶在前面，不能只找關鍵字）；failStage 命中時丟出額度用完；hold 時等到被停止。 */
class Scripted implements AgentAdapter {
  requests: AgentRequest[] = [];
  constructor(readonly id: AgentId, private readonly plan = '', private readonly fail?: (request: AgentRequest) => boolean, private readonly hold?: (request: AgentRequest) => boolean) {}
  capabilities() { return capabilities; }
  async detect(): Promise<ProviderStatus> { return { id: this.id, status: 'ready', capabilities }; }
  async *execute(request: AgentRequest) {
    this.requests.push(request);
    if (this.fail?.(request)) throw new ProviderFailure('額度不足', 'quota');
    if (this.hold?.(request)) await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    yield { type: 'text-delta' as const, taskId: request.taskId, text: request.prompt.trimEnd().endsWith('```') ? this.plan : `${this.id} done` };
    yield { type: 'complete' as const, taskId: request.taskId, sessionId: 's' };
  }
  async cancel() {}
}
async function setup(adapters: Scripted[]) {
  const orchestrator = new Orchestrator(new AgentRegistry(adapters), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/project'), '/project', () => true, () => 5000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex', 'claude'] }); await orchestrator.checkProviders();
  return { orchestrator, coordinator: new HybridCoordinator(orchestrator) };
}
const members: HybridMemberInput[] = [{ provider: 'codex', label: 'Codex · 工作', preferences: { model: 'gpt', effort: 'high' } }, { provider: 'claude', label: 'Claude Code · 個人', preferences: { model: 'sonnet', effort: 'medium' } }];
const plan = '我來拆兩步。\n```json\n{"steps":[{"title":"寫程式","member":1,"instruction":"實作功能"},{"title":"補測試","member":2,"instruction":"加測試"}]}\n```';
const stages = (orchestrator: Orchestrator) => orchestrator.state.tasks.map(task => `${task.provider}:${task.hybrid?.stage}${task.hybrid?.index ?? ''}:${task.mode}:${task.status}`);

describe('Hybrid Coordinator', () => {
  it('lets the lead plan, runs each step with its assigned member, then reviews and concludes', async () => {
    const codex = new Scripted('codex', plan); const claude = new Scripted('claude');
    const { orchestrator, coordinator } = await setup([codex, claude]);
    const result = await coordinator.run('加上匯出功能', members, 0, 'workspace-write');
    expect(result).toMatchObject({ status: 'completed', steps: [{ title: '寫程式', member: 0, status: 'done' }, { title: '補測試', member: 1, status: 'done' }] });
    expect(stages(orchestrator)).toEqual(['codex:plan:read-only:completed', 'codex:step1:workspace-write:completed', 'claude:step2:workspace-write:completed', 'claude:review:read-only:completed', 'codex:conclusion:read-only:completed']);
    // 使用者的原始要求只附在第一則；後面的環節拿到前面成果，跨 Provider 轉交有稽核紀錄。
    expect(orchestrator.state.tasks.map(task => task.hybrid?.text)).toEqual(['加上匯出功能', undefined, undefined, undefined, undefined]);
    expect(claude.requests[0]!.prompt).toContain('codex done');
    expect(orchestrator.state.tasks[2]!.events?.some(event => event.kind === 'data-outbound' && event.detail === 'Codex 的成果轉交給 Claude Code')).toBe(true);
    expect(orchestrator.state.tasks[1]!.hybrid).toMatchObject({ member: 'Codex · 工作', title: '寫程式' });
    // 任務結束後解除鎖定，可以正常送出。
    expect(orchestrator.state.discussionId).toBeUndefined();
  });
  it('skips a member that runs out of quota, hands its step to the lead and reports who left', async () => {
    const codex = new Scripted('codex', plan); const claude = new Scripted('claude', '', () => true);
    const { orchestrator, coordinator } = await setup([codex, claude]);
    const result = await coordinator.run('加上匯出功能', members, 0, 'workspace-write');
    expect(result.status).toBe('completed');
    expect(result.members).toEqual([{ label: 'Codex · 工作', provider: 'codex', lead: true }, { label: 'Claude Code · 個人', provider: 'claude', left: '環節「補測試」：額度用完' }]);
    expect(result.steps[1]).toMatchObject({ member: 0, status: 'done' });
    expect(stages(orchestrator)).toEqual(['codex:plan:read-only:completed', 'codex:step1:workspace-write:completed', 'claude:step2:workspace-write:failed', 'codex:step2:workspace-write:completed', 'codex:conclusion:read-only:completed']);
    // 接手的人被提醒可能有做到一半的修改；結論被要求寫出誰離開。
    expect(codex.requests[2]!.prompt).toContain('partial changes');
    expect(codex.requests.at(-1)!.prompt).toContain('Members who left midway: Claude Code · 個人 (環節「補測試」：額度用完)');
  });
  it('promotes another member when the lead is unavailable and falls back to one step on a bad plan', async () => {
    const codex = new Scripted('codex', '', () => true); const claude = new Scripted('claude', '沒有 JSON 的規劃');
    const { orchestrator, coordinator } = await setup([codex, claude]);
    const result = await coordinator.run('修 bug', members, 0, 'read-only');
    expect(result).toMatchObject({ status: 'completed', steps: [{ title: '完成任務', member: 1, status: 'done' }] });
    expect(result.members[0]).toMatchObject({ left: '規劃：額度用完' }); expect(result.members[1]).toMatchObject({ lead: true });
    expect(stages(orchestrator).at(-1)).toBe('claude:conclusion:read-only:completed');
  });
  it('stops on cancel, fails when everyone left, and validates members', async () => {
    const codex = new Scripted('codex', plan, undefined, request => request.prompt.trimEnd().endsWith('needs to know.')); const claude = new Scripted('claude');
    const first = await setup([codex, claude]);
    const running = first.coordinator.run('加上匯出功能', members, 0, 'workspace-write');
    await expect.poll(() => first.coordinator.summary()?.steps[0]?.status).toBe('running');
    await first.coordinator.cancel();
    expect((await running).status).toBe('cancelled'); expect(first.orchestrator.state.tasks).toHaveLength(2);
    const second = await setup([new Scripted('codex', '', () => true), new Scripted('claude', '', () => true)]);
    expect((await second.coordinator.run('x', members, 0, 'read-only')).status).toBe('failed');
    await expect(second.coordinator.run('x', members.slice(0, 1), 0, 'read-only')).rejects.toThrow('2 到 4 個成員');
    await expect(second.coordinator.run('x', members, 5, 'read-only')).rejects.toThrow('請指定主帳號');
  });
  it('runs each step with that member own approval mode and never full access', async () => {
    const codex = new Scripted('codex', plan); const claude = new Scripted('claude');
    const { coordinator } = await setup([codex, claude]);
    await coordinator.run('加上匯出功能', [{ ...members[0]!, approvalMode: 'auto-review' }, { ...members[1]!, approvalMode: 'full-access' }], 0, 'workspace-write');
    expect(codex.requests[1]!.approvalMode).toBe('auto-review'); expect(claude.requests[0]!.approvalMode).toBe('ask');
  });
  it('parses only a valid plan and caps the number of steps', () => {
    expect(parsePlan(plan, 2)?.map(step => [step.title, step.member])).toEqual([['寫程式', 0], ['補測試', 1]]);
    expect(parsePlan('{"steps":[{"title":"a","member":3,"instruction":"x"}]}', 2)).toBeUndefined();
    expect(parsePlan('no plan', 2)).toBeUndefined();
    expect(parsePlan(JSON.stringify({ steps: Array.from({ length: 9 }, (_, index) => ({ title: `s${index}`, member: 1, instruction: 'x' })) }), 2)).toHaveLength(6);
  });
});
