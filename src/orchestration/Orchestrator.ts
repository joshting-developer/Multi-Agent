import { randomUUID } from 'node:crypto';
import type { AgentId, ApprovalRequest, ExecutionMode, ParticipantRole, Snapshot, Task, WorkspacePolicy } from '../bridge/messages';
import { AgentRegistry } from '../agents/AgentRegistry';
import { assertAuthorized } from '../execution/ExecutionPolicy';
import { ProcessError } from '../execution/ProcessManager';
import { ProviderFailure } from '../agents/CliAdapter';
import { buildContext } from './ContextBuilder';
import { SessionRepository } from '../storage/SessionRepository';
import type { ApprovalMode, ProviderPreferences } from '../bridge/settings';

export interface ParticipantRef { id: string; role: ParticipantRole; substitute?: boolean }
export interface SendOptions { participant?: ParticipantRef; discussion?: { id: string; roundNo?: number } }
const roleInstructions: Record<ParticipantRole, string> = {
  architect: 'Your role in this discussion: Architect. Propose a concrete, well-reasoned approach and state its trade-offs.',
  critic: 'Your role in this discussion: Critic. Challenge the proposal on performance, testing, security and maintainability, and suggest corrections.',
  summarizer: 'Your role: neutral summarizer of a finished discussion. Do not add new opinions; attribute every point to A or B with its round number.'
};

/** V0.1 serial manual executor. Planning and routing remain separate future concerns. */
export class Orchestrator {
  readonly state: Snapshot;
  private active?: { task: Task; controller: AbortController; finished: Promise<void> };
  private navigating = false;
  private readonly listeners = new Set<() => void>();
  private readonly approvalAnswers = new Map<string, (allow: boolean) => void>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly registry: AgentRegistry, private readonly repository: SessionRepository,
    private readonly cwd: string, private readonly isTrusted: () => boolean, private readonly timeoutMs: () => number,
    private readonly storageError: (error: unknown) => void = () => undefined) {
    const stored = repository.load();
    this.state = { workspace: cwd, tasks: stored.tasks, policy: stored.policy, providers: [], checking: false, trusted: isTrusted(), conversationId: repository.conversationId, conversations: repository.list(), approvals: [] };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(persist = false): void {
    for (const listener of this.listeners) listener();
    if (persist && !this.persistTimer) this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined; void this.flush().catch(this.storageError);
    }, 500);
  }
  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.repository.save(this.state.tasks, this.state.policy);
    this.state.conversations = this.repository.list(); this.changed();
  }
  async checkProviders(): Promise<void> {
    if (this.state.checking || this.active) return;
    this.state.checking = true; this.changed();
    try { this.state.providers = await this.registry.detect(); }
    finally { this.state.checking = false; this.changed(); }
  }
  async setPolicy(policy: WorkspacePolicy): Promise<void> {
    if (this.active) throw new Error('請先停止目前任務，再修改工作區授權。');
    this.state.policy = policy; this.changed(); await this.flush();
  }
  assertCanSend(provider: AgentId, mode: ExecutionMode, discussionId?: string): void {
    if (this.navigating) throw new Error('正在切換對話，請稍候。');
    if (this.state.discussionId !== discussionId) throw new Error(this.state.discussionId ? '討論進行中，請等待完成或停止討論。' : '討論尚未開始。');
    if (this.active) throw new Error('目前已有任務執行中。請等待完成或按 Stop。');
    if (this.state.checking) throw new Error('正在檢查 Provider，請稍候。');
    assertAuthorized(this.state.policy, provider, this.state.trusted && this.isTrusted());
    const status = this.state.providers.find(item => item.id === provider);
    if (status?.status !== 'ready') throw new Error(status?.reason ?? '請先檢查 Provider 連線。');
    if (mode === 'workspace-write' && !status.capabilities.workspaceWrite) throw new Error('此 CLI 版本不支援工作區寫入。');
  }
  /** 每次只執行一個 Participant；不會自動接續另一方，下一輪由呼叫端（Coordinator）決定。 */
  async send(provider: AgentId, text: string, mode: ExecutionMode, preferences?: ProviderPreferences, approvalMode: ApprovalMode = 'ask', { participant, discussion }: SendOptions = {}): Promise<Task> {
    this.assertCanSend(provider, mode, discussion?.id);
    if (discussion && (mode !== 'read-only' || !participant)) throw new Error('討論輪次必須為唯讀且指定 Participant。');
    if (participant && this.state.tasks.some(item => item.participantId === participant.id && (item.provider !== provider || item.participantRole !== participant.role))) throw new Error('Participant 已綁定其他 Provider 或角色。');
    const task: Task = { id: randomUUID(), provider, mode, prompt: text, output: '', status: 'running', startedAt: Date.now(), activity: '啟動官方 CLI…', approvalMode, ...preferences, ...(participant && { participantId: participant.id, participantRole: participant.role, ...(participant.substitute && { substitute: true }) }), ...(discussion && { discussionId: discussion.id, ...(discussion.roundNo && { roundNo: discussion.roundNo }) }) };
    const controller = new AbortController();
    // Set the lock before the first await, including persistence and CLI detection.
    const active = { task, controller, finished: Promise.resolve() };
    this.active = active;
    this.state.activeTaskId = task.id;
    this.state.tasks.push(task);
    this.changed();
    active.finished = this.execute(task, controller);
    await active.finished;
    return task;
  }
  /** 討論期間只接受該討論的輪次；一般送出與切換對話都會被拒絕。 */
  beginDiscussion(id: string): void {
    if (this.active || this.navigating || this.state.discussionId) throw new Error('目前已有任務或討論執行中。');
    this.state.discussionId = id; this.changed();
  }
  endDiscussion(id: string): void { if (this.state.discussionId === id) { this.state.discussionId = undefined; this.changed(); } }
  private async execute(task: Task, controller: AbortController): Promise<void> {
    try {
      await this.flush();
      if (controller.signal.aborted) throw new ProcessError('任務已取消。', 'cancelled');
      // Only the same participant's completed history is included (solo = same provider without participant).
      // No implicit sharing across providers or between participants A／B.
      const history = this.state.tasks.filter(item => item.id !== task.id && item.provider === task.provider && item.participantId === task.participantId && item.status === 'completed');
      const { prompt: message, contextIds } = buildContext(history, task.prompt);
      if (contextIds.length) task.contextIds = contextIds;
      const prompt = task.participantRole ? `${roleInstructions[task.participantRole]}\n\n${message}` : message;
      for await (const event of this.registry.get(task.provider).execute({ taskId: task.id, prompt, cwd: this.cwd, mode: task.mode, model: task.model, effort: task.effort, approvalMode: task.approvalMode, approve: request => this.requestApproval(task, request, controller.signal), signal: controller.signal, timeoutMs: this.timeoutMs() })) {
        if (event.type === 'text-delta') {
          if (task.output.length + event.text.length > 512 * 1024) throw new Error('回應超過 512 KB 上限，已停止任務。');
          task.output += event.text;
        } else if (event.type === 'activity') task.activity = event.text;
        else task.sessionId = event.sessionId;
        this.changed(true);
      }
      task.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      task.status = controller.signal.aborted || (error instanceof ProcessError && error.kind === 'cancelled') ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : '未知的執行錯誤。';
      if (task.status === 'failed' && error instanceof ProviderFailure && error.kind) task.failureKind = error.kind;
    } finally {
      task.endedAt = Date.now(); task.activity = undefined;
      for (const resolve of this.approvalAnswers.values()) resolve(false);
      this.active = undefined; this.state.activeTaskId = undefined;
      this.changed(); await this.flush().catch(this.storageError);
    }
  }
  /** 使用者標成不採用的回答保留在紀錄裡，但之後組上下文時不再當成事實帶入。 */
  async setRejected(taskId: string, rejected: boolean): Promise<void> {
    const task = this.state.tasks.find(item => item.id === taskId);
    if (!task || task.status !== 'completed' || task.discussionId) throw new Error('只能標記已完成的一般回答。');
    if (rejected) task.rejected = true; else delete task.rejected;
    this.changed(); await this.flush();
  }
  async cancel(taskId?: string): Promise<void> {
    if (!this.active || (taskId && this.active.task.id !== taskId)) return;
    const active = this.active;
    active.task.activity = '正在停止程序…'; this.changed();
    active.controller.abort(); await this.registry.get(active.task.provider).cancel(active.task.id);
    await active.finished;
  }
  async clear(): Promise<void> {
    if (this.active) throw new Error('請先停止目前任務。');
    await this.deleteConversation(this.repository.conversationId);
  }
  private requestApproval(task: Task, request: Pick<ApprovalRequest, 'title' | 'detail'>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise(resolve => {
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(1, this.timeoutMs() - (Date.now() - task.startedAt)));
      const finish = (allow: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        this.approvalAnswers.delete(id); this.state.approvals = this.state.approvals?.filter(item => item.id !== id);
        this.changed(); resolve(allow);
      };
      this.approvalAnswers.set(id, finish);
      signal.addEventListener('abort', abort, { once: true });
      this.state.approvals!.push({ id, taskId: task.id, provider: task.provider, ...request }); this.changed();
    });
  }
  answerApproval(id: string, allow: boolean): void {
    const answer = this.approvalAnswers.get(id);
    if (!answer) throw new Error('此核准請求已失效。');
    answer(allow);
  }
  private async navigate(operation: () => Promise<void>): Promise<void> {
    if (this.active || this.navigating || this.state.discussionId) throw new Error('請先停止目前任務或等候切換完成。');
    this.navigating = true;
    try { await operation(); } finally { this.navigating = false; this.changed(); }
  }
  async newConversation(): Promise<void> {
    await this.navigate(async () => {
      await this.flush(); this.repository.create();
      this.state.conversationId = this.repository.conversationId; this.state.tasks = [];
    });
  }
  async openConversation(id: string): Promise<void> {
    await this.navigate(async () => {
      await this.flush(); this.state.tasks = this.repository.select(id);
      this.state.conversationId = id;
    });
  }
  searchConversations(query: string) { return this.repository.list(query); }
  async renameConversation(id: string, title: string): Promise<void> {
    await this.navigate(async () => { await this.repository.rename(id, title); this.state.conversations = this.repository.list(); });
  }
  async deleteConversation(id: string): Promise<void> {
    await this.navigate(async () => {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
      await this.repository.delete(id);
      if (id === this.repository.conversationId) {
        const next = this.repository.list()[0];
        this.state.tasks = next ? this.repository.select(next.id) : [];
        if (!next) this.repository.create();
        this.state.conversationId = this.repository.conversationId;
      }
      this.state.conversations = this.repository.list();
    });
  }
  async invalidateWorkspace(): Promise<void> { this.state.trusted = false; this.changed(); await this.cancel(); }
  async dispose(): Promise<void> { await this.cancel(); await this.flush(); await this.repository.close(); this.listeners.clear(); }
}
