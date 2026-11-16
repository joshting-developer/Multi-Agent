import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import type { AgentAdapter, AgentEvent, AgentRequest } from '../src/agents/AgentAdapter';
import { SessionUnavailable } from '../src/agents/CliAdapter';
import { AttachmentStore } from '../src/storage/AttachmentStore';
import { readdir } from 'node:fs/promises';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository, type StateStorage } from '../src/storage/SessionRepository';
import { assertAuthorized } from '../src/execution/ExecutionPolicy';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    this.requests.push(request);
    yield { type: 'text-delta' as const, taskId: request.taskId, text: `${this.id} reply` };
    if (this.wait) await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'complete' as const, taskId: request.taskId, sessionId: `native-${request.taskId}` };
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
  it('adds a steer to the running task only when the provider supports it', async () => {
    class Steerable extends FakeAdapter { steered: string[] = []; override capabilities() { return { ...capabilities, steer: true }; } async steer(_taskId: string, text: string) { this.steered.push(text); } }
    const codex = new Steerable('codex', true, true); const claude = new FakeAdapter('claude', true, true);
    const { orchestrator } = await setup([claude, codex]);
    const running = orchestrator.send('codex', '修 bug', 'read-only');
    await vi.waitFor(() => expect(orchestrator.state.activeTaskId).toBeDefined());
    const id = orchestrator.state.activeTaskId!;
    await orchestrator.steer(id, '也補測試');
    expect(codex.steered).toEqual(['也補測試']); // 原訊息不變，補充存成對話裡的一則訊息，接在目前輸出後面。
    const steered = orchestrator.state.tasks.find(task => task.id === id)!;
    expect(steered.prompt).toBe('修 bug'); expect(steered.steps).toEqual([{ kind: 'text', text: 'codex reply' }, { kind: 'steer', text: '也補測試', at: expect.any(Number) }]);
    await expect(orchestrator.steer('other', 'x')).rejects.toThrow('請改為排隊送出');
    await orchestrator.cancel(); await running;
    await expect(orchestrator.steer(id, 'late')).rejects.toThrow('請改為排隊送出');
    const second = orchestrator.send('claude', 'hi', 'read-only');
    await vi.waitFor(() => expect(orchestrator.state.activeTaskId).toBeDefined());
    await expect(orchestrator.steer(orchestrator.state.activeTaskId!, 'x')).rejects.toThrow('不支援補充');
    await orchestrator.cancel(); await second;
  });
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
  it('records the context it sent and excludes answers the user rejected, only for the same participant', async () => {
    const { orchestrator, adapters } = await setup();
    await orchestrator.send('claude', 'first question', 'read-only');
    const first = orchestrator.state.tasks[0]!;
    await orchestrator.setRejected(first.id, true);
    await orchestrator.send('claude', 'second question', 'read-only');
    expect(adapters[0]!.requests[1]!.prompt).toContain('first question'); expect(adapters[0]!.requests[1]!.prompt).not.toContain('claude reply');
    expect(orchestrator.state.tasks[1]!.contextIds).toEqual([first.id]);
    await orchestrator.setRejected(first.id, false);
    await orchestrator.send('claude', 'third question', 'read-only');
    expect(adapters[0]!.requests[2]!.prompt).toContain('claude reply'); expect(orchestrator.state.tasks[2]!.contextIds).toHaveLength(2);
    await expect(orchestrator.setRejected('missing', true)).rejects.toThrow(/已完成/);
    await orchestrator.dispose();
  });
  it('keeps a trace of tools, approval decisions and workspace authorization in SQLite without raw payloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-agent-audit-'));
    try {
      const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
      class ToolAdapter extends FakeAdapter {
        override async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
          yield { type: 'tool' as const, taskId: request.taskId, id: 't1', tool: 'Bash', phase: 'start' as const, input: 'cat secret.txt # token=abcdef1234567890' };
          await request.approve?.({ title: '核准 Claude 工具：Bash', detail: '{"command":"cat secret-token-xyz"}' });
          yield { type: 'tool' as const, taskId: request.taskId, id: 't1', tool: 'Bash', phase: 'end' as const, success: false, output: 'denied' };
          yield* super.execute(request);
        }
      }
      const orchestrator = new Orchestrator(new AgentRegistry([new ToolAdapter('claude')]), new SessionRepository(new MemoryStorage(), '/project', db), '/project', () => true, () => 5000);
      await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['claude'] }); await orchestrator.checkProviders();
      const running = orchestrator.send('claude', 'run a tool', 'workspace-write');
      await vi.waitFor(() => expect(orchestrator.state.approvals).toHaveLength(1));
      orchestrator.answerApproval(orchestrator.state.approvals![0]!.id, false);
      await running; await orchestrator.flush();
      const task = orchestrator.state.tasks[0]!;
      expect(task.events?.map(event => [event.kind, event.detail])).toEqual([['tool-start', 'Bash'], ['approval-requested', '核准 Claude 工具：Bash'], ['approval-denied', '核准 Claude 工具：Bash'], ['tool-failed', 'Bash']]);
      const stored = db.auditEvents(orchestrator.state.conversationId!);
      expect(stored.map(event => [event.kind, event.runId])).toEqual(task.events!.map(event => [event.kind, task.id]));
      expect(db.auditEvents().map(event => [event.kind, event.detail])).toEqual([['policy-changed', 'personal: claude']]);
      expect(JSON.stringify([stored, db.auditEvents()])).not.toContain('secret-token');
      // 執行過程依序保存；IN 已遮罩秘密。
      expect(task.steps).toEqual([{ kind: 'tool', id: 't1', name: 'Bash', status: 'failed', input: 'cat secret.txt # token=[已遮罩]', output: 'denied' }, { kind: 'text', text: 'claude reply' }]);
      await orchestrator.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('marks a tool still running at Stop as stopped and keeps text before it in order', async () => {
    class HangingTool extends FakeAdapter {
      override async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
        yield { type: 'text-delta' as const, taskId: request.taskId, text: 'looking' };
        yield { type: 'tool' as const, taskId: request.taskId, id: 'x', tool: 'Bash', phase: 'start' as const, input: 'sleep 100' };
        await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
      }
    }
    const { orchestrator } = await setup([new HangingTool('claude')]);
    const running = orchestrator.send('claude', 'long tool', 'read-only');
    await vi.waitFor(() => expect(orchestrator.state.tasks[0]?.steps).toHaveLength(2));
    await orchestrator.cancel(); await running;
    expect(orchestrator.state.tasks[0]!.steps).toEqual([{ kind: 'text', text: 'looking' }, { kind: 'tool', id: 'x', name: 'Bash', status: 'stopped', input: 'sleep 100' }]);
    await orchestrator.dispose();
  });
  it('resumes the native session for ordinary chat and rebuilds from SQLite when it cannot', async () => {
    class Resumable extends FakeAdapter {
      missing = false;
      override capabilities() { return { ...capabilities, resumeSession: true }; }
      override async detect(): Promise<ProviderStatus> { return { id: this.id, status: 'ready', capabilities: this.capabilities() }; }
      override async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
        if (request.resumeSessionId && this.missing) { this.requests.push(request); throw new SessionUnavailable('gone'); }
        yield* super.execute(request);
      }
    }
    const adapter = new Resumable('claude'); const { orchestrator } = await setup([adapter]);
    await orchestrator.send('claude', 'first', 'read-only');
    expect(adapter.requests[0]).toMatchObject({ persist: true, resumeSessionId: undefined }); expect(orchestrator.state.tasks[0]).toMatchObject({ persisted: true });
    await orchestrator.send('claude', 'second', 'read-only');
    // 接續原生 Session 時只送這次的訊息，不重播歷史。
    expect(adapter.requests[1]).toMatchObject({ prompt: 'second', resumeSessionId: `native-${orchestrator.state.tasks[0]!.id}` }); expect(orchestrator.state.tasks[1]!.contextMode).toBe('native');
    adapter.missing = true;
    await orchestrator.send('claude', 'third', 'read-only');
    expect(adapter.requests.slice(2).map(request => request.resumeSessionId)).toEqual([`native-${orchestrator.state.tasks[1]!.id}`, undefined]);
    expect(adapter.requests[3]!.prompt).toContain('second'); expect(orchestrator.state.tasks[2]).toMatchObject({ status: 'completed', contextMode: 'rebuilt' });
    expect(orchestrator.state.tasks[2]!.events?.map(event => event.kind)).toContain('session-rebuilt');
    adapter.missing = false;
    await orchestrator.setRejected(orchestrator.state.tasks[2]!.id, true);
    await orchestrator.send('claude', 'fourth', 'read-only');
    // 有不採用的回答時不接續原生 Session，避免它又被當成事實。
    expect(adapter.requests.at(-1)!.resumeSessionId).toBeUndefined(); expect(adapter.requests.at(-1)!.prompt).toContain('answer rejected by the user');
    await orchestrator.dispose();
  });
  it('runs each task with its own account directory and never resumes a session across accounts', async () => {
    class Resumable extends FakeAdapter {
      override capabilities() { return { ...capabilities, resumeSession: true }; }
      override async detect(): Promise<ProviderStatus> { return { id: this.id, status: 'ready', capabilities: this.capabilities() }; }
    }
    const adapter = new Resumable('claude');
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository(new MemoryStorage(), '/project'), '/project', () => true, () => 5000, () => undefined,
      (_provider, accountId) => accountId ? { CLAUDE_CONFIG_DIR: `/accounts/${accountId}` } : undefined);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['claude'] }); await orchestrator.checkProviders();
    await orchestrator.send('claude', 'work 1', 'read-only', { model: 'sonnet', effort: 'low', accountId: 'work' });
    await orchestrator.send('claude', 'work 2', 'read-only', { model: 'sonnet', effort: 'low', accountId: 'work' });
    await orchestrator.send('claude', 'personal', 'read-only', { model: 'sonnet', effort: 'low', accountId: 'personal' });
    expect(adapter.requests.map(request => [request.env?.CLAUDE_CONFIG_DIR, request.resumeSessionId ? 'resume' : 'new'])).toEqual([['/accounts/work', 'new'], ['/accounts/work', 'resume'], ['/accounts/personal', 'new']]);
    expect(orchestrator.state.tasks.map(task => task.accountId)).toEqual(['work', 'work', 'personal']);
    await orchestrator.dispose();
  });
  it('stops saving a project on request, keeps it in memory only, and clears just this project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-agent-persist-'));
    try {
      class Resumable extends FakeAdapter {
        override capabilities() { return { ...capabilities, resumeSession: true }; }
        override async detect(): Promise<ProviderStatus> { return { id: this.id, status: 'ready', capabilities: this.capabilities() }; }
      }
      const adapter = new Resumable('claude'); const path = join(dir, 'history.sqlite'); const wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm');
      const other = await ConversationDatabase.open(path, '/other', wasm);
      await other.save('elsewhere', '其他專案', [{ id: 'x', provider: 'codex', mode: 'read-only', prompt: 'p', output: 'o', status: 'completed', startedAt: 1 }], { classification: 'personal', allowedProviders: ['codex'] }); await other.close();
      const db = await ConversationDatabase.open(path, '/project', wasm);
      const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository(new MemoryStorage(), '/project', db), '/project', () => true, () => 5000);
      await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['claude'] }); await orchestrator.checkProviders();
      await orchestrator.send('claude', 'saved', 'read-only'); await orchestrator.flush();
      const saved = orchestrator.state.conversationId!;
      await orchestrator.setPersistence(false); await orchestrator.newConversation();
      await orchestrator.send('claude', 'not saved', 'read-only'); await orchestrator.flush();
      const unsaved = orchestrator.state.conversationId!;
      expect(orchestrator.state.persistent).toBe(false); expect(adapter.requests.at(-1)!.persist).toBe(false);
      expect(db.list().map(item => item.id)).toEqual([saved]);
      expect(orchestrator.state.conversations?.map(item => item.id)).toEqual([unsaved, saved]);
      await orchestrator.openConversation(saved); await orchestrator.openConversation(unsaved);
      expect(orchestrator.state.tasks.map(task => task.prompt)).toEqual(['not saved']);
      await orchestrator.clearProject();
      expect(orchestrator.state.tasks).toEqual([]); expect(orchestrator.state.conversations).toEqual([]); expect(db.list()).toEqual([]);
      expect(db.policy()).toEqual({ classification: 'personal', allowedProviders: ['claude'] });
      const check = await ConversationDatabase.open(path, '/other', wasm); expect(check.list().map(item => item.id)).toEqual(['elsewhere']); await check.close();
      await orchestrator.setPersistence(true); await orchestrator.send('claude', 'saved again', 'read-only'); await orchestrator.flush();
      expect(db.list().map(item => item.title)).toEqual(['saved again']);
      await orchestrator.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('sends stored images with the task, notes them in later context, and deletes them with the conversation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-agent-images-'));
    try {
      const adapter = new FakeAdapter('claude'); const { orchestrator } = await setup([adapter]);
      orchestrator.attachmentStore = new AttachmentStore(dir);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString('base64');
      const conversation = orchestrator.state.conversationId!;
      const attachments = await orchestrator.attachmentStore.save(conversation, [{ mime: 'image/png', data: png }]);
      await orchestrator.send('claude', '這張圖是什麼？', 'read-only', undefined, 'ask', { attachments });
      expect(adapter.requests[0]!.images).toEqual([{ mime: 'image/png', data: png }]);
      expect(orchestrator.state.tasks[0]!.attachments).toEqual(attachments); expect(JSON.stringify(orchestrator.state.tasks)).not.toContain(png);
      await orchestrator.send('claude', '再說一次', 'read-only');
      expect(adapter.requests[1]!.images).toBeUndefined(); expect(adapter.requests[1]!.prompt).toContain('attached 1 image(s), not re-sent');
      await orchestrator.deleteConversation(conversation);
      expect(await readdir(dir)).toEqual([]);
      await orchestrator.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('queues later work behind the running task so only one writer runs, and cancels queued work without starting it', async () => {
    const adapter = new FakeAdapter('claude', true, true); const { orchestrator } = await setup([adapter]);
    const running = orchestrator.send('claude', 'long task', 'workspace-write');
    const second = orchestrator.send('claude', 'second writer', 'workspace-write');
    expect(orchestrator.state.tasks.map(task => task.status)).toEqual(['running', 'queued']);
    const third = orchestrator.send('claude', 'third', 'read-only'); const fourth = orchestrator.send('claude', 'fourth', 'read-only');
    await expect(orchestrator.send('claude', 'fifth', 'read-only')).rejects.toThrow(/排隊/);
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1));
    for (const task of orchestrator.state.tasks.slice(1)) await orchestrator.cancel(task.id);
    await orchestrator.cancel(); await Promise.all([running, second, third, fourth]);
    expect(orchestrator.state.tasks.map(task => task.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    expect(adapter.requests).toHaveLength(1);
    await orchestrator.dispose();
  });
  it('never replays a stopped task\'s partial output into the next prompt', async () => {
    const claude = new FakeAdapter('claude', true, true); const { orchestrator } = await setup([claude]);
    const running = orchestrator.send('claude', 'first', 'read-only');
    await vi.waitFor(() => expect(orchestrator.state.tasks[0]?.output).toBe('claude reply'));
    await orchestrator.cancel(); await running;
    expect(orchestrator.state.tasks[0]?.status).toBe('cancelled');
    const next = orchestrator.send('claude', 'second', 'read-only');
    await vi.waitFor(() => expect(claude.requests).toHaveLength(2));
    expect(claude.requests[1]!.prompt).toBe('second');
    await orchestrator.cancel(); await next; await orchestrator.dispose();
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
describe('Independent participants', () => {
  it('runs same-provider A／B with separate roles, contexts and native sessions without auto-launching the other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-agent-orch-'));
    try {
      const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
      const codex = new FakeAdapter('codex'); const repository = new SessionRepository(new MemoryStorage(), '/project', db);
      const orchestrator = new Orchestrator(new AgentRegistry([codex]), repository, '/project', () => true, () => 5000);
      await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
      const a = { id: 'codex-a', role: 'architect' as const }; const b = { id: 'codex-b', role: 'critic' as const };
      await orchestrator.send('codex', 'A 的方案草稿', 'read-only', undefined, 'ask', { participant: a });
      expect(codex.requests).toHaveLength(1);
      await orchestrator.send('codex', 'B 的審查題目', 'read-only', undefined, 'ask', { participant: b });
      await orchestrator.send('codex', 'A 的追問', 'read-only', undefined, 'ask', { participant: a });
      const [, toB, toA] = codex.requests.map(request => request.prompt);
      expect(toB).toContain('Critic'); expect(toB).not.toContain('A 的方案草稿');
      expect(toA).toContain('Architect'); expect(toA).toContain('A 的方案草稿'); expect(toA).not.toContain('B 的審查題目');
      await expect(orchestrator.send('codex', 'x', 'read-only', undefined, 'ask', { participant: { id: 'codex-a', role: 'critic' } })).rejects.toThrow(/Participant/);
      await orchestrator.flush();
      const participants = db.participants(orchestrator.state.conversationId!);
      expect(participants.map(p => [p.id, p.provider, p.role])).toEqual([['codex-a', 'codex', 'architect'], ['codex-b', 'codex', 'critic']]);
      expect(participants[0]!.nativeSessionId).toBe(`native-${orchestrator.state.tasks[2]!.id}`);
      expect(participants[1]!.nativeSessionId).toBe(`native-${orchestrator.state.tasks[1]!.id}`);
      await orchestrator.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
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
  it('keeps a background task writing to its own conversation while another conversation queues its own work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-agent-background-'));
    try {
      let release: () => void = () => undefined;
      class Gated extends FakeAdapter {
        override async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
          this.requests.push(request);
          yield { type: 'text-delta' as const, taskId: request.taskId, text: `partial ${request.prompt}` };
          if (this.requests.length === 1) await new Promise<void>(resolve => { release = resolve; });
          yield { type: 'text-delta' as const, taskId: request.taskId, text: ' done' };
          yield { type: 'complete' as const, taskId: request.taskId, sessionId: `native-${request.taskId}` };
        }
      }
      const adapter = new Gated('claude');
      const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
      const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository(new MemoryStorage(), '/project', db), '/project', () => true, () => 5000);
      await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['claude'] }); await orchestrator.checkProviders();
      const a = orchestrator.send('claude', 'A', 'read-only'); const conversationA = orchestrator.state.conversationId!;
      await vi.waitFor(() => expect(orchestrator.state.tasks[0]?.output).toBe('partial A'));
      await orchestrator.newConversation(); const conversationB = orchestrator.state.conversationId!;
      expect(orchestrator.state).toMatchObject({ activeConversationId: conversationA, tasks: [] });
      expect(orchestrator.state.conversations?.find(item => item.id === conversationA)?.activity).toBe('running');
      const b = orchestrator.send('claude', 'B', 'read-only');
      expect(orchestrator.state.tasks.map(task => [task.prompt, task.status])).toEqual([['B', 'queued']]);
      release(); await Promise.all([a, b]);
      // A 的完成只寫回 A；B 依序在 A 之後執行，且只帶 B 自己的歷史。
      expect(orchestrator.state.tasks.map(task => [task.prompt, task.output, task.status])).toEqual([['B', 'partial B done', 'completed']]);
      expect(adapter.requests.map(request => request.prompt)).toEqual(['A', 'B']);
      expect(db.load(conversationA).map(task => [task.prompt, task.output, task.status])).toEqual([['A', 'partial A done', 'completed']]);
      await orchestrator.openConversation(conversationA);
      expect(orchestrator.state.tasks.map(task => task.output)).toEqual(['partial A done']);
      expect(orchestrator.state.conversations?.find(item => item.id === conversationA)?.activity).toBeUndefined();
      expect(db.load(conversationB).map(task => task.prompt)).toEqual(['B']);
      await orchestrator.dispose();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('cancels a waiting approval, clears the card, and rejects a stale response', async () => {
    class ApprovingAdapter extends FakeAdapter {
      override async *execute(request: AgentRequest) {
        await request.approve!({ title: '核准測試', detail: 'synthetic operation' });
        yield { type: 'complete' as const, taskId: request.taskId, sessionId: `native-${request.taskId}` };
      }
    }
    const { orchestrator } = await setup([new ApprovingAdapter('codex')]);
    const running = orchestrator.send('codex', 'approval task', 'workspace-write');
    for (let attempt = 0; !orchestrator.state.approvals?.length && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    const pending = orchestrator.state.approvals![0]!; expect(pending.title).toBe('核准測試');
    // 背景任務等待核准時仍可切到新對話；核准卡標明所屬對話，歷史列表標示等待中。
    const original = orchestrator.state.conversationId!; const live = orchestrator.state.tasks;
    await orchestrator.newConversation();
    expect(orchestrator.state.tasks).toEqual([]); expect(pending.conversationId).toBe(original);
    expect(orchestrator.state.conversations?.find(item => item.id === original)?.activity).toBe('waiting');
    await expect(orchestrator.deleteConversation(original)).rejects.toThrow(/停止/);
    await orchestrator.openConversation(original);
    expect(orchestrator.state.tasks).toBe(live);
    await orchestrator.cancel(); await running;
    expect(orchestrator.state.tasks[0]?.status).toBe('cancelled'); expect(orchestrator.state.approvals).toEqual([]);
    expect(() => orchestrator.answerApproval(pending.id, true)).toThrow(/失效/); await orchestrator.dispose();
  });
});
