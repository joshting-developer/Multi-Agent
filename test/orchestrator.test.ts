import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository, type StateStorage } from '../src/storage/SessionRepository';
import { assertAuthorized } from '../src/execution/ExecutionPolicy';
import type { AgentId, ProviderStatus } from '../src/bridge/messages';
const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
class MemoryStorage implements StateStorage {
  value: unknown;
  get<T>(): T | undefined { return this.value as T | undefined; }
  async update(_key: string, value: unknown) { this.value = value; }
}
class FakeAdapter implements AgentAdapter {
  requests: AgentRequest[] = [];
  constructor(readonly id: AgentId, readonly available = true, readonly wait = false) {}
  capabilities() { return capabilities; }
  async detect(): Promise<ProviderStatus> { return { id: this.id, status: this.available ? 'ready' : 'not-installed', capabilities }; }
  async *execute(request: AgentRequest) {
    this.requests.push(request);
    yield { type: 'text-delta' as const, taskId: request.taskId, text: `${this.id} reply` };
    if (this.wait) await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'complete' as const, taskId: request.taskId };
  }
  async cancel() {}
}
const setup = async (adapters = [new FakeAdapter('claude'), new FakeAdapter('codex')]) => {
  const storage = new MemoryStorage();
  const repository = new SessionRepository(storage, '/project');
  const orchestrator = new Orchestrator(new AgentRegistry(adapters), repository, '/project', () => true, () => 5000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['claude', 'codex'] });
  await orchestrator.checkProviders();
  return { orchestrator, repository, storage, adapters };
};
describe('Manual orchestration', () => {
  it.each(['claude', 'codex'] as const)('works when only %s is available', async provider => {
    const { orchestrator } = await setup([new FakeAdapter('claude', provider === 'claude'), new FakeAdapter('codex', provider === 'codex')]);
    await orchestrator.send(provider, 'hello', 'read-only');
    expect(orchestrator.state.tasks[0]?.status).toBe('completed');
    await orchestrator.dispose();
  });
  it('isolates history between providers and preserves same-provider context', async () => {
    const { orchestrator, adapters } = await setup();
    await orchestrator.send('claude', 'Claude private context', 'read-only');
    await orchestrator.send('codex', 'new context', 'read-only');
    expect(adapters[1]?.requests[0]?.prompt).toBe('new context');
    await orchestrator.send('claude', 'follow up', 'read-only');
    expect(adapters[0]?.requests[1]?.prompt).toContain('Claude private context');
    await orchestrator.dispose();
  });
  it('locks before awaiting and supports cancellation', async () => {
    const { orchestrator } = await setup([new FakeAdapter('claude', true, true)]);
    const running = orchestrator.send('claude', 'long task', 'workspace-write');
    await expect(orchestrator.send('claude', 'second writer', 'workspace-write')).rejects.toThrow(/已有任務/);
    await orchestrator.cancel(); await running;
    expect(orchestrator.state.tasks[0]?.status).toBe('cancelled');
    await orchestrator.dispose();
  });
  it('recovers running tasks as interrupted and binds grants to one root', async () => {
    const { storage } = await setup();
    storage.value = { version: 1, root: '/project', policy: { classification: 'personal', allowedProviders: ['codex'] }, tasks: [{ id: '1', provider: 'codex', mode: 'read-only', prompt: 'hi', output: 'partial', status: 'running', startedAt: 1 }] };
    expect(new SessionRepository(storage, '/project').load().tasks[0]?.status).toBe('interrupted');
    expect(new SessionRepository(storage, '/other').load().policy.allowedProviders).toEqual([]);
  });
  it('blocks new tasks when workspace folders change', async () => {
    const { orchestrator } = await setup();
    await orchestrator.invalidateWorkspace();
    await expect(orchestrator.send('claude', 'hello', 'read-only')).rejects.toThrow(/信任/);
    await orchestrator.dispose();
  });
});
describe('Data boundaries', () => {
  it.each(['unclassified', 'restricted'] as const)('blocks %s even with forged allowlist', classification => {
    expect(() => assertAuthorized({ classification, allowedProviders: ['codex'] }, 'codex', true)).toThrow();
  });
  it('requires trust and an explicit provider grant', () => {
    expect(() => assertAuthorized({ classification: 'company', allowedProviders: ['claude'] }, 'codex', true)).toThrow();
    expect(() => assertAuthorized({ classification: 'personal', allowedProviders: ['claude'] }, 'claude', false)).toThrow();
  });
});

describe('Conversation navigation and approval lifetime', () => {
  it('keeps independent conversations and continues only the selected history', async () => {
    const { orchestrator, adapters } = await setup();
    await orchestrator.send('codex', 'first conversation', 'read-only'); const first = orchestrator.state.conversationId!;
    await orchestrator.newConversation(); await orchestrator.send('codex', 'second conversation', 'read-only');
    expect(adapters[1]!.requests.at(-1)?.prompt).toBe('second conversation');
    await orchestrator.openConversation(first); await orchestrator.send('codex', 'continue first', 'read-only');
    expect(adapters[1]!.requests.at(-1)?.prompt).toContain('first conversation');
    expect(adapters[1]!.requests.at(-1)?.prompt).not.toContain('second conversation');
    expect(orchestrator.searchConversations('first')).toHaveLength(1); await orchestrator.dispose();
  });
  it('holds the conversation lock while asynchronous navigation persists', async () => {
    const { orchestrator } = await setup();
    const navigation = orchestrator.newConversation();
    await expect(orchestrator.send('codex', 'racing send', 'read-only')).rejects.toThrow(/切換/);
    await navigation; await orchestrator.dispose();
  });
  it('cancels a waiting approval, clears the card, and rejects a stale response', async () => {
    class ApprovingAdapter extends FakeAdapter {
      override async *execute(request: AgentRequest) {
        await request.approve!({ title: '核准測試', detail: 'synthetic operation' });
        yield { type: 'complete' as const, taskId: request.taskId };
      }
    }
    const { orchestrator } = await setup([new ApprovingAdapter('codex')]);
    const running = orchestrator.send('codex', 'approval task', 'workspace-write');
    for (let attempt = 0; !orchestrator.state.approvals?.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    const pending = orchestrator.state.approvals![0]!; expect(pending.title).toBe('核准測試');
    await expect(orchestrator.newConversation()).rejects.toThrow(/停止/);
    await orchestrator.cancel(); await running;
    expect(orchestrator.state.tasks[0]?.status).toBe('cancelled'); expect(orchestrator.state.approvals).toEqual([]);
    expect(() => orchestrator.answerApproval(pending.id, true)).toThrow(/失效/); await orchestrator.dispose();
  });
});
