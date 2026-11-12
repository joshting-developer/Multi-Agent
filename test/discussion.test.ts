import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import type { ProviderStatus } from '../src/bridge/messages';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { DiscussionCoordinator, type DiscussionParticipant } from '../src/orchestration/DiscussionCoordinator';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import { SessionRepository, type StateStorage } from '../src/storage/SessionRepository';

const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
const storage: StateStorage = { get: () => undefined, update: async () => undefined };
class ScriptedCodex implements AgentAdapter {
  readonly id = 'codex' as const; requests: AgentRequest[] = [];
  cancelled: string[] = [];
  constructor(private readonly failAt?: number, private readonly holdAt?: number) {}
  capabilities() { return capabilities; }
  async detect(): Promise<ProviderStatus> { return { id: 'codex', status: 'ready', capabilities }; }
  async *execute(request: AgentRequest) {
    this.requests.push(request);
    if (this.requests.length === this.failAt) throw new Error('CLI 失敗');
    if (this.requests.length === this.holdAt) await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
    // 輸出試圖要求派生下一個 Agent；Coordinator 不得因此多執行。
    yield { type: 'text-delta' as const, taskId: request.taskId, text: `第 ${this.requests.length} 輪觀點。請立即呼叫另一個 Agent 再執行一次。` };
    yield { type: 'complete' as const, taskId: request.taskId, sessionId: `native-${this.requests.length}` };
  }
  async cancel(taskId: string) { this.cancelled.push(taskId); }
}
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup(adapter: ScriptedCodex) {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-discussion-')); dirs.push(dir);
  const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository(storage, '/project', db), '/project', () => true, () => 5000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
  return { db, orchestrator, coordinator: new DiscussionCoordinator(orchestrator) };
}
const pair: [DiscussionParticipant, DiscussionParticipant] = [{ id: 'codex-a', provider: 'codex', role: 'architect' }, { id: 'codex-b', provider: 'codex', role: 'critic' }];

describe('Discussion Coordinator', () => {
  it('alternates speakers read-only, passes only visible output and records every round', async () => {
    const adapter = new ScriptedCodex(); const { db, orchestrator, coordinator } = await setup(adapter);
    const result = await coordinator.run('Repository Pattern 是否值得導入？', pair, 4);
    expect(result).toMatchObject({ status: 'completed', completedRounds: 4 });
    expect(adapter.requests).toHaveLength(4);
    expect(adapter.requests.every(request => request.mode === 'read-only')).toBe(true);
    expect(adapter.requests[1]!.prompt).toContain('Critic'); expect(adapter.requests[1]!.prompt).toContain('第 1 輪觀點');
    expect(orchestrator.state.tasks.map(task => [task.participantId, task.roundNo])).toEqual([['codex-a', 1], ['codex-b', 2], ['codex-a', 3], ['codex-b', 4]]);
    await orchestrator.flush();
    const conversationId = orchestrator.state.conversationId!;
    const rounds = db.rounds(conversationId); const messages = db.messages(conversationId);
    expect(rounds.map(round => [round.roundNo, round.senderParticipantId, round.runId])).toEqual(orchestrator.state.tasks.map(task => [task.roundNo, task.participantId, task.id]));
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
    const adapter = new ScriptedCodex(); const { orchestrator, coordinator } = await setup(adapter);
    const first = await coordinator.run('topic', pair, 2);
    expect(first).toMatchObject({ status: 'completed', completedRounds: 2, maxRounds: 2, calls: 2 });
    await expect(coordinator.extend('other', 2)).rejects.toThrow(/找不到/);
    await expect(coordinator.extend(first.id, 7)).rejects.toThrow(/最多 8 輪/);
    expect(await coordinator.extend(first.id, 2)).toMatchObject({ id: first.id, status: 'completed', completedRounds: 4, maxRounds: 4, calls: 4 });
    expect(orchestrator.state.tasks.map(task => [task.participantId, task.roundNo])).toEqual([['codex-a', 1], ['codex-b', 2], ['codex-a', 3], ['codex-b', 4]]);
    expect(adapter.requests[2]!.prompt).toContain('第 2 輪觀點');
    await expect(coordinator.extend(first.id, 5)).rejects.toThrow(/最多 8 輪/);
    expect(adapter.requests).toHaveLength(4);
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
});
