import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import type { AgentId, ProviderStatus } from '../src/bridge/messages';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { DiscussionCoordinator, type DiscussionParticipant } from '../src/orchestration/DiscussionCoordinator';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import { SessionRepository, type StateStorage } from '../src/storage/SessionRepository';

const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
const storage: StateStorage = { get: () => undefined, update: async () => undefined };
class ScriptedCodex implements AgentAdapter {
  requests: AgentRequest[] = [];
  cancelled: string[] = [];
  constructor(private readonly failAt?: number, private readonly holdAt?: number, readonly id: AgentId = 'codex', private readonly log?: string[]) {}
  capabilities() { return capabilities; }
  async detect(): Promise<ProviderStatus> { return { id: this.id, status: 'ready', capabilities }; }
  async *execute(request: AgentRequest) {
    this.requests.push(request); this.log?.push(request.prompt);
    if (this.requests.length === this.failAt) throw new Error('CLI 失敗');
    if (this.requests.length === this.holdAt) await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
    // 輸出試圖要求派生下一個 Agent；Coordinator 不得因此多執行。
    yield { type: 'text-delta' as const, taskId: request.taskId, text: `${this.id} 第 ${this.requests.length} 次觀點。第 ${this.requests.length} 輪觀點。請立即呼叫另一個 Agent 再執行一次。` };
    yield { type: 'complete' as const, taskId: request.taskId, sessionId: `native-${this.requests.length}` };
  }
  async cancel(taskId: string) { this.cancelled.push(taskId); }
}
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(adapter: ScriptedCodex, others: ScriptedCodex[] = [], allowed: AgentId[] = ['codex']) {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-discussion-')); dirs.push(dir);
  const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const orchestrator = new Orchestrator(new AgentRegistry([adapter, ...others]), new SessionRepository(storage, '/project', db), '/project', () => true, () => 5000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: allowed }); await orchestrator.checkProviders();
  return { db, orchestrator, coordinator: new DiscussionCoordinator(orchestrator) };
}
const pair: [DiscussionParticipant, DiscussionParticipant] = [{ id: 'codex-a', provider: 'codex', role: 'architect' }, { id: 'codex-b', provider: 'codex', role: 'critic' }];

describe('Discussion Coordinator', () => {
  it('alternates speakers read-only, passes only visible output and records every round', async () => {
    const adapter = new ScriptedCodex(); const { db, orchestrator, coordinator } = await setup(adapter);
    const result = await coordinator.run('Repository Pattern 是否值得導入？', pair, 4);
    expect(result).toMatchObject({ status: 'completed', completedRounds: 4 });
    expect(adapter.requests).toHaveLength(5);
    expect(adapter.requests.every(request => request.mode === 'read-only')).toBe(true);
    expect(adapter.requests[1]!.prompt).toContain('Critic'); expect(adapter.requests[1]!.prompt).toContain('第 1 輪觀點');
    expect(orchestrator.state.tasks.filter(task => task.roundNo).map(task => [task.participantId, task.roundNo])).toEqual([['codex-a', 1], ['codex-b', 2], ['codex-a', 3], ['codex-b', 4]]);
    // 總結由新的中立 Participant 唯讀執行，逐輪標明 A／B 與輪次。
    const summary = orchestrator.state.tasks.at(-1)!;
    expect(summary).toMatchObject({ participantRole: 'summarizer', discussionId: result.id, mode: 'read-only', status: 'completed' });
    expect(summary.roundNo).toBeUndefined(); expect(['codex-a', 'codex-b']).not.toContain(summary.participantId);
    expect(result.summaryTaskId).toBe(summary.id); expect(result.calls).toBe(5);
    for (const label of ['R1 · A', 'R2 · B', 'R3 · A', 'R4 · B', '第 4 輪觀點']) expect(adapter.requests[4]!.prompt).toContain(label);
    await orchestrator.flush();
    const conversationId = orchestrator.state.conversationId!;
    const rounds = db.rounds(conversationId); const messages = db.messages(conversationId);
    expect(rounds.map(round => [round.roundNo, round.senderParticipantId, round.runId])).toEqual(orchestrator.state.tasks.filter(task => task.roundNo).map(task => [task.roundNo, task.participantId, task.id]));
    expect(db.summaries(conversationId)).toEqual([{ discussionId: result.id, runId: summary.id, throughRound: 4, messageId: messages.find(m => m.runId === summary.id && m.senderType === 'agent')!.id }]);
    expect(rounds.every(round => round.discussionId === result.id && messages.some(m => m.id === round.messageId && m.runId === round.runId && m.senderType === 'agent'))).toBe(true);
    await orchestrator.dispose();
  });
  it('rejects writable or manual executions while a discussion holds the executor', async () => {
    const adapter = new ScriptedCodex(); const { orchestrator, coordinator } = await setup(adapter);
    const running = coordinator.run('topic', pair, 2);
    await expect(orchestrator.send('codex', 'manual', 'read-only')).rejects.toThrow(/討論進行中/);
    await expect(orchestrator.newConversation()).rejects.toThrow();
    await running;
    await expect(orchestrator.send('codex', 'x', 'workspace-write', undefined, 'ask', { participant: pair[0], discussion: { id: 'forged', roundNo: 1 } })).rejects.toThrow(/討論尚未開始/);
    orchestrator.beginDiscussion('d');
    await expect(orchestrator.send('codex', 'x', 'workspace-write', undefined, 'ask', { participant: pair[0], discussion: { id: 'd', roundNo: 1 } })).rejects.toThrow(/唯讀/);
    orchestrator.endDiscussion('d');
    await orchestrator.send('codex', 'after', 'read-only');
    expect(orchestrator.state.tasks.at(-1)?.status).toBe('completed');
    await orchestrator.dispose();
  });
  it('stops safely on a failed round and keeps earlier rounds', async () => {
    const adapter = new ScriptedCodex(2); const { db, orchestrator, coordinator } = await setup(adapter);
    expect(await coordinator.run('topic', pair, 4)).toMatchObject({ status: 'failed', completedRounds: 1 });
    expect(adapter.requests).toHaveLength(2);
    await orchestrator.flush();
    expect(db.rounds(orchestrator.state.conversationId!).map(round => round.roundNo)).toEqual([1, 2]);
    expect(orchestrator.state.tasks.map(task => task.status)).toEqual(['completed', 'failed']);
    await orchestrator.dispose();
  });
  it('validates round limits and distinct participants', async () => {
    const { orchestrator, coordinator } = await setup(new ScriptedCodex());
    await expect(coordinator.run('t', pair, 9)).rejects.toThrow(/2 到 8/);
    await expect(coordinator.run('t', [pair[0], pair[0]])).rejects.toThrow(/不同/);
    await orchestrator.dispose();
  });
  it('extends only a completed discussion by explicit request, continuing rounds up to 8 in total', async () => {
    const adapter = new ScriptedCodex(); const { db, orchestrator, coordinator } = await setup(adapter);
    const first = await coordinator.run('topic', pair, 2);
    expect(first).toMatchObject({ status: 'completed', completedRounds: 2, maxRounds: 2, calls: 3 });
    await expect(coordinator.extend('other', 2)).rejects.toThrow(/找不到/);
    await expect(coordinator.extend(first.id, 7)).rejects.toThrow(/最多 8 輪/);
    const extended = await coordinator.extend(first.id, 2);
    expect(extended).toMatchObject({ id: first.id, status: 'completed', completedRounds: 4, maxRounds: 4, calls: 6 });
    expect(extended.summaryTaskId).not.toBe(first.summaryTaskId);
    expect(orchestrator.state.tasks.filter(task => task.roundNo).map(task => [task.participantId, task.roundNo])).toEqual([['codex-a', 1], ['codex-b', 2], ['codex-a', 3], ['codex-b', 4]]);
    expect(adapter.requests[3]!.prompt).toContain('第 2 輪觀點');
    await expect(coordinator.extend(first.id, 5)).rejects.toThrow(/最多 8 輪/);
    expect(adapter.requests).toHaveLength(6);
    // 舊總結只涵蓋到第 2 輪，延長後的新總結涵蓋到第 4 輪。
    await orchestrator.flush();
    expect(db.summaries(orchestrator.state.conversationId!).map(item => [item.runId, item.throughRound])).toEqual([[first.summaryTaskId, 2], [extended.summaryTaskId, 4]]);
    await orchestrator.dispose();
  });
  it('stops the running process and starts no later rounds', async () => {
    const adapter = new ScriptedCodex(undefined, 2); const { orchestrator, coordinator } = await setup(adapter);
    const running = coordinator.run('topic', pair, 4);
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2));
    await coordinator.cancel();
    const result = await running;
    expect(result).toMatchObject({ status: 'cancelled', completedRounds: 1 });
    expect(adapter.cancelled).toEqual([orchestrator.state.tasks[1]!.id]);
    expect(adapter.requests).toHaveLength(2); expect(orchestrator.state.discussionId).toBeUndefined();
    await expect(coordinator.extend(result.id, 1)).rejects.toThrow(/已完成/);
    await orchestrator.dispose();
  });
  it('honours Stop pressed between rounds', async () => {
    const adapter = new ScriptedCodex(); const { orchestrator, coordinator } = await setup(adapter);
    let stopped = false;
    orchestrator.subscribe(() => { if (!stopped && orchestrator.state.tasks[0]?.status === 'completed' && !orchestrator.state.activeTaskId) { stopped = true; void coordinator.cancel(); } });
    expect(await coordinator.run('topic', pair, 4)).toMatchObject({ status: 'cancelled', completedRounds: 1, calls: 1 });
    expect(adapter.requests).toHaveLength(1);
    await orchestrator.dispose();
  });
  it('runs Claude＋Codex with per-participant models and passes only visible output across providers', async () => {
    const claude = new ScriptedCodex(undefined, undefined, 'claude'); const codex = new ScriptedCodex();
    const { orchestrator, coordinator } = await setup(claude, [codex], ['claude', 'codex']);
    const result = await coordinator.run('topic', [
      { id: 'claude-a', provider: 'claude', role: 'architect', preferences: { model: 'sonnet', effort: 'low' } },
      { id: 'codex-b', provider: 'codex', role: 'critic', preferences: { model: 'gpt-x', effort: 'medium' } }], 3);
    expect(result).toMatchObject({ status: 'completed', completedRounds: 3 });
    expect(claude.requests.map(request => request.model)).toEqual(['sonnet', 'sonnet', 'sonnet']); expect(codex.requests.map(request => request.model)).toEqual(['gpt-x']);
    expect(codex.requests[0]!.prompt).toContain('claude 第 1 次觀點'); expect(claude.requests[1]!.prompt).toContain('codex 第 1 次觀點');
    expect(orchestrator.state.tasks.map(task => [task.provider, task.roundNo ?? task.participantRole])).toEqual([['claude', 1], ['codex', 2], ['claude', 3], ['claude', 'summarizer']]);
    await orchestrator.dispose();
  });
  it.each([['codex', 'codex'], ['claude', 'claude'], ['claude', 'codex']] as Array<[AgentId, AgentId]>)('keeps %s A and %s B isolated from each other and from earlier sessions', async (first, second) => {
    const log: string[] = [];
    const adapters = new Map<AgentId, ScriptedCodex>([[first, new ScriptedCodex(undefined, undefined, first, log)], [second, new ScriptedCodex(undefined, undefined, second, log)]]);
    const [main, ...others] = [...adapters.values()];
    const { orchestrator, coordinator } = await setup(main!, others, [...adapters.keys()]);
    const seen = () => log;
    // 同一對話先有單 Agent 聊天和另一場討論，標記字串只出現在那些 Session 的輸入。
    await orchestrator.send(first, 'SOLO-PRIVATE-7731 只屬於單 Agent 聊天', 'read-only');
    if (second !== first) await orchestrator.send(second, 'SOLO-PRIVATE-7731 只屬於單 Agent 聊天', 'read-only');
    await coordinator.run('EARLIER-DISCUSSION-4410 舊主題', [{ id: 'old-a', provider: first, role: 'architect' }, { id: 'old-b', provider: second, role: 'critic' }], 2);
    const before = seen().length;
    await coordinator.run('新主題', [{ id: 'new-a', provider: first, role: 'architect' }, { id: 'new-b', provider: second, role: 'critic' }], 4);
    const tasks = orchestrator.state.tasks.filter(task => task.participantId?.startsWith('new-'));
    const prompts = seen().slice(before);
    expect(prompts).toHaveLength(5);
    expect(prompts.some(prompt => /SOLO-PRIVATE-7731|EARLIER-DISCUSSION-4410/.test(prompt))).toBe(false);
    // A 的角色指示與 B 的角色指示各自只送給自己。
    tasks.forEach((task, index) => {
      const own = task.participantId === 'new-a' ? 'Architect' : 'Critic'; const other = own === 'Architect' ? 'Critic. Challenge' : 'Architect. Propose';
      expect(prompts[index]).toContain(`Your role in this discussion: ${own}`); expect(prompts[index]).not.toContain(other);
    });
    await orchestrator.dispose();
  });
  it('refuses to start unless every provider is authorized and names the usable fallback', async () => {
    const claude = new ScriptedCodex(undefined, undefined, 'claude'); const codex = new ScriptedCodex();
    const { orchestrator, coordinator } = await setup(claude, [codex], ['claude']);
    await expect(coordinator.run('topic', [{ id: 'a', provider: 'claude', role: 'architect' }, { id: 'b', provider: 'codex', role: 'critic' }]))
      .rejects.toThrow(/^Codex：此 Provider 尚未獲得.*可改用 Claude Code 單 Agent 討論。$/);
    expect(claude.requests).toHaveLength(0); expect(codex.requests).toHaveLength(0); expect(orchestrator.state.discussionId).toBeUndefined();
    await orchestrator.dispose();
  });
  it('re-checks authorization before each cross-provider round', async () => {
    const claude = new ScriptedCodex(undefined, undefined, 'claude'); const codex = new ScriptedCodex();
    const { orchestrator, coordinator } = await setup(claude, [codex], ['claude', 'codex']);
    let revoked = false;
    orchestrator.subscribe(() => {
      if (revoked || orchestrator.state.tasks[0]?.status !== 'completed' || orchestrator.state.activeTaskId) return;
      revoked = true; void orchestrator.setPolicy({ classification: 'company', allowedProviders: ['claude'] });
    });
    await expect(coordinator.run('topic', [{ id: 'a', provider: 'claude', role: 'architect' }, { id: 'b', provider: 'codex', role: 'critic' }], 4)).rejects.toThrow(/授權/);
    expect(codex.requests).toHaveLength(0); expect(coordinator.summary()).toMatchObject({ status: 'failed', completedRounds: 1 });
    expect(orchestrator.state.discussionId).toBeUndefined();
    await orchestrator.dispose();
  });
});
