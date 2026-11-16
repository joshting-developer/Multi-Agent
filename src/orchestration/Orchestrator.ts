import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, parse } from 'node:path';
import { insideOf } from '../execution/ReadRoots';
import type { AgentId, ApprovalRequest, AuditEvent, ConversationSummary, SearchFilters, UsageSnapshot, ExecutionMode, ParticipantRole, Snapshot, Task, WorkspacePolicy } from '../bridge/messages';
import { AgentRegistry } from '../agents/AgentRegistry';
import { assertAuthorized } from '../execution/ExecutionPolicy';
import { ProcessError } from '../execution/ProcessManager';
import { ProviderFailure, SessionUnavailable } from '../agents/CliAdapter';
import { buildContext } from './ContextBuilder';
import { redact } from '../execution/Redact';
import type { AttachmentStore, StoredAttachment } from '../storage/AttachmentStore';
import type { AgentEvent } from '../agents/AgentAdapter';
import { SessionRepository } from '../storage/SessionRepository';
import type { ApprovalMode, ProviderPreferences } from '../bridge/settings';

export interface ParticipantRef { id: string; role: ParticipantRole; substitute?: boolean }
/** hybrid：混合任務的一次執行，沿用討論的鎖定（期間不接受其他送出），但可以寫入工作區。 */
export interface SendOptions { participant?: ParticipantRef; discussion?: { id: string; roundNo?: number }; hybrid?: NonNullable<Task['hybrid']>; outbound?: string; attachments?: StoredAttachment[] }
/** 單次執行最多保留的稽核事件數，避免長任務的工具事件撐大歷史。 */
const maxEvents = 200;
/** 單次執行最多保留的工具步驟數，以及 IN／OUT 的保存長度。 */
const maxTools = 100; const inputLimit = 2000; const outputLimit = 4000;
/** 排隊上限；同一 workspace 一次只執行一個任務，避免多個 writer。 */
const maxQueued = 3;
const roleInstructions: Record<ParticipantRole, string> = {
  architect: 'Your role in this discussion: Architect. Propose a concrete, well-reasoned approach and state its trade-offs.',
  critic: 'Your role in this discussion: Critic. Challenge the proposal on performance, testing, security and maintainability, and suggest corrections.',
  summarizer: 'Your role: neutral summarizer of a finished discussion. Do not add new opinions; attribute every point to A or B with its round number.'
};

/** V0.1 serial manual executor. Planning and routing remain separate future concerns. */
export class Orchestrator {
  readonly state: Snapshot;
  /** 執行中官方回報的額度狀態，交給帳號管理記錄（依執行時的帳號）。 */
  onUsage?: (provider: AgentId, accountId: string | undefined, usage: UsageSnapshot) => void;
  /** 每次執行時讀取的回覆語言指示（設定 → 回覆語言）；沒有時不加。 */
  languageInstruction?: () => string | undefined;
  /** 使用者貼上圖片的本機儲存；未設定時不接受附件。 */
  attachmentStore?: AttachmentStore;
  private active?: { task: Task; controller: AbortController; finished: Promise<void>; conversationId: string };
  /** 有執行中或排隊任務的對話，切走後仍留在記憶體並持續寫回原對話。 */
  private readonly live = new Map<string, Task[]>();
  private executor: Promise<void> = Promise.resolve();
  private listed: ConversationSummary[] = [];
  private readonly taskConversations = new Map<string, string>();
  private navigating = false;
  private readonly listeners = new Set<() => void>();
  private readonly approvalAnswers = new Map<string, (allow: boolean) => void>();
  private persistTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly registry: AgentRegistry, private readonly repository: SessionRepository,
    private readonly cwd: string, private readonly isTrusted: () => boolean, private readonly timeoutMs: () => number,
    private readonly storageError: (error: unknown) => void = () => undefined,
    private readonly accountEnv: (provider: AgentId, accountId?: string) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined = () => undefined) {
    const stored = repository.load();
    this.listed = repository.list();
    this.state = { persistent: repository.persistent, hasEarlier: repository.hasEarlier(repository.conversationId, stored.tasks[0]?.startedAt) || undefined, workspace: cwd, tasks: stored.tasks, policy: stored.policy, providers: [], checking: false, trusted: isTrusted(), conversationId: repository.conversationId, conversations: this.listed, approvals: [] };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(persist = false): void {
    this.state.conversations = this.decorate(this.listed);
    for (const listener of this.listeners) listener();
    if (persist && !this.persistTimer) this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined; void this.flush().catch(this.storageError);
    }, 500);
  }
  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.repository.save(this.state.tasks, this.state.policy);
    for (const [id, tasks] of this.live) if (id !== this.repository.conversationId) await this.repository.save(tasks, this.state.policy, id);
    for (const [id, tasks] of this.live) if (!tasks.some(task => task.status === 'running' || task.status === 'queued')) this.live.delete(id);
    this.listed = this.repository.list();
    const external = this.live.has(this.repository.conversationId) ? 0 : this.repository.externalRuns(this.repository.conversationId, this.state.tasks[0]?.startedAt);
    this.state.externalChanges = external || undefined;
    this.changed();
  }
  private paging(): void { this.state.hasEarlier = this.repository.hasEarlier(this.repository.conversationId, this.state.tasks[0]?.startedAt) || undefined; }
  /** 往前載入一頁更早的訊息，接在目前清單前面。 */
  async loadEarlier(): Promise<void> {
    const first = this.state.tasks[0];
    if (!first) return;
    const earlier = this.repository.loadEarlier(this.repository.conversationId, first.startedAt).filter(task => !this.state.tasks.some(item => item.id === task.id));
    this.state.tasks.unshift(...earlier); this.paging(); this.changed();
  }
  /** 歷史列表標示背景對話的執行、排隊或等待核准狀態。 */
  private decorate(list: ConversationSummary[]): ConversationSummary[] {
    return list.map(item => {
      const tasks = this.live.get(item.id);
      if (!tasks) return item;
      const activity = this.state.approvals?.some(request => request.conversationId === item.id) ? 'waiting' : tasks.some(task => task.status === 'running') ? 'running' : tasks.some(task => task.status === 'queued') ? 'queued' : undefined;
      return activity ? { ...item, activity } : item;
    });
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
    await this.auditWorkspace('policy-changed', `${policy.classification}: ${policy.allowedProviders.join(', ') || '無'}`);
  }
  /** 允許 Agent 唯讀工作區外的資料夾；只收已存在的絕對路徑資料夾，不收工作區內、根目錄或家目錄本身。 */
  async addReadRoot(path: string): Promise<string> {
    if (this.active) throw new Error('請先停止目前任務，再修改工作區授權。');
    if (!isAbsolute(path)) throw new Error('請選擇資料夾的完整路徑。');
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error('只能允許讀取資料夾。');
    if (root === '/' || root === homedir() || root === parse(root).root) throw new Error('不能允許讀取整個磁碟或家目錄，請選擇更明確的資料夾。');
    if (insideOf(root, this.cwd) || insideOf(this.cwd, root)) throw new Error('這個資料夾和工作區重疊，請選擇工作區外的資料夾。');
    const roots = this.state.policy.readRoots ?? [];
    if (roots.includes(root)) return root;
    if (roots.length >= 20) throw new Error('最多允許 20 個資料夾。');
    this.state.policy = { ...this.state.policy, readRoots: [...roots, root] }; this.changed(); await this.flush();
    await this.auditWorkspace('policy-changed', `允許唯讀：${root}`);
    return root;
  }
  /** 允許或關閉這個工作區的 Agent 連網；只在沒有任務執行時改，並寫入稽核紀錄。 */
  async setNetwork(enabled: boolean): Promise<void> {
    if (this.active) throw new Error('請先停止目前任務，再修改工作區授權。');
    if (!!this.state.policy.network === enabled) return;
    const { network: _previous, ...policy } = this.state.policy; void _previous;
    this.state.policy = enabled ? { ...policy, network: true } : policy;
    this.changed(); await this.flush();
    await this.auditWorkspace('policy-changed', enabled ? '允許 Agent 使用網路' : '關閉 Agent 網路');
  }
  async removeReadRoot(path: string): Promise<void> {
    if (this.active) throw new Error('請先停止目前任務，再修改工作區授權。');
    const { readRoots = [], ...policy } = this.state.policy; const roots = readRoots.filter(item => item !== path);
    this.state.policy = roots.length ? { ...policy, readRoots: roots } : policy;
    this.changed(); await this.flush();
    await this.auditWorkspace('policy-changed', `取消唯讀：${path}`);
  }
  assertCanSend(provider: AgentId, mode: ExecutionMode, discussionId?: string): void {
    if (this.navigating) throw new Error('正在切換對話，請稍候。');
    if (this.state.discussionId !== discussionId) throw new Error(this.state.discussionId ? '討論進行中，請等待完成或停止討論。' : '討論尚未開始。');
    if (this.active && discussionId) throw new Error('目前已有任務執行中。請等待完成或按 Stop。');
    if (this.pending() >= maxQueued + 1) throw new Error(`最多 ${maxQueued} 個任務排隊，請等前面的任務完成。`);
    if (this.state.checking) throw new Error('正在檢查 Provider，請稍候。');
    assertAuthorized(this.state.policy, provider, this.state.trusted && this.isTrusted());
    const status = this.state.providers.find(item => item.id === provider);
    if (status?.status !== 'ready') throw new Error(status?.reason ?? '請先檢查 Provider 連線。');
    if (mode === 'workspace-write' && !status.capabilities.workspaceWrite) throw new Error('此 CLI 版本不支援工作區寫入。');
  }
  /** 每次只執行一個 Participant；不會自動接續另一方，下一輪由呼叫端（Coordinator）決定。 */
  async send(provider: AgentId, text: string, mode: ExecutionMode, preferences?: ProviderPreferences, approvalMode: ApprovalMode = 'ask', { participant, discussion, hybrid, outbound, attachments }: SendOptions = {}): Promise<Task> {
    this.assertCanSend(provider, mode, discussion?.id ?? hybrid?.id);
    if (discussion && (mode !== 'read-only' || !participant)) throw new Error('討論輪次必須為唯讀且指定 Participant。');
    if (participant && this.state.tasks.some(item => item.participantId === participant.id && (item.provider !== provider || item.participantRole !== participant.role))) throw new Error('Participant 已綁定其他 Provider 或角色。');
    const task: Task = { id: randomUUID(), provider, mode, prompt: text, output: '', status: 'running', startedAt: Date.now(), activity: '啟動官方 CLI…', approvalMode, ...preferences, ...(participant && { participantId: participant.id, participantRole: participant.role, ...(participant.substitute && { substitute: true }) }), ...(discussion && { discussionId: discussion.id, ...(discussion.roundNo && { roundNo: discussion.roundNo }) }) };
    if (hybrid) task.hybrid = hybrid;
    if (outbound) this.audit(task, 'data-outbound', outbound);
    if (attachments?.length) task.attachments = attachments;
    // 任務屬於送出當下的對話；之後切換檢視也繼續寫回這個對話。同步排入佇列，順序與送出順序相同。
    const conversationId = this.repository.conversationId; const tasks = this.state.tasks;
    if (this.active || this.pending()) { task.status = 'queued'; task.activity = '排隊中'; }
    tasks.push(task); this.live.set(conversationId, tasks);
    const run = this.executor.then(() => this.start(task, conversationId, tasks));
    this.executor = run.catch(() => undefined);
    this.changed();
    await run;
    return task;
  }
  private pending(): number { return [...this.live.values()].reduce((count, tasks) => count + tasks.filter(task => task.status === 'queued' || task.status === 'running').length, 0); }
  private async start(task: Task, conversationId: string, tasks: Task[]): Promise<void> {
    this.taskConversations.set(task.id, conversationId);
    if (task.status === 'cancelled') return;
    const controller = new AbortController();
    task.status = 'running'; task.startedAt = Date.now(); task.activity = '啟動官方 CLI…';
    const active = { task, controller, finished: Promise.resolve(), conversationId };
    this.active = active; this.state.activeTaskId = task.id; this.state.activeConversationId = conversationId;
    this.changed();
    active.finished = this.execute(task, controller, tasks);
    await active.finished;
  }
  /** 討論期間只接受該討論的輪次；一般送出與切換對話都會被拒絕。 */
  beginDiscussion(id: string): void {
    if (this.active || this.pending() || this.navigating || this.state.discussionId) throw new Error('目前已有任務或討論執行中。');
    this.state.discussionId = id; this.changed();
  }
  endDiscussion(id: string): void { if (this.state.discussionId === id) { this.state.discussionId = undefined; this.changed(); } }
  private async execute(task: Task, controller: AbortController, tasks: Task[]): Promise<void> {
    try {
      await this.flush();
      if (controller.signal.aborted) throw new ProcessError('任務已取消。', 'cancelled');
      // Only the same participant's completed history is included (solo = same provider without participant).
      // No implicit sharing across providers or between participants A／B.
      const history = tasks.filter(item => item.id !== task.id && item.provider === task.provider && item.participantId === task.participantId && item.status === 'completed');
      // 一般聊天才保留並接續原生 Session；討論一律一次性，避免 A／B 透過原生 Session 混用記憶。
      // 使用者不採用過的回答仍在原生 Session 裡，有不採用時改以 SQLite 上下文重建。
      const native = !task.participantId && this.repository.persistent && !!this.state.providers.find(item => item.id === task.provider)?.capabilities.resumeSession;
      const previous = history.at(-1);
      // 原生 Session 存在各帳號自己的 CLI 目錄，換帳號時不接續。
      const resume = native && previous?.persisted && previous.sessionId && previous.accountId === task.accountId && !history.some(item => item.rejected) ? previous.sessionId : undefined;
      try { await this.run(task, history, controller, native, resume); }
      catch (error) {
        if (!resume || !(error instanceof SessionUnavailable) || task.output || task.steps) throw error;
        this.audit(task, 'session-rebuilt', '原生 Session 無法接續，改以上下文重建');
        await this.run(task, history, controller, native);
      }
      task.persisted = native || undefined;
      task.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      task.status = controller.signal.aborted || (error instanceof ProcessError && error.kind === 'cancelled') ? 'cancelled' : 'failed';
      if (task.status === 'cancelled') this.audit(task, 'cancelled', '使用者停止');
      task.error = error instanceof Error ? error.message : '未知的執行錯誤。';
      if (task.status === 'failed' && error instanceof ProviderFailure && error.kind) task.failureKind = error.kind;
    } finally {
      // 失敗、拒絕或 Stop 後不留下一直「執行中」的工具。
      for (const step of task.steps ?? []) if (step.kind === 'tool' && step.status === 'running') step.status = task.status === 'completed' ? 'done' : 'stopped';
      task.endedAt = Date.now(); task.activity = undefined;
      for (const resolve of this.approvalAnswers.values()) resolve(false);
      this.active = undefined; this.state.activeTaskId = undefined; this.state.activeConversationId = undefined; this.taskConversations.delete(task.id);
      this.changed(); await this.flush().catch(this.storageError);
    }
  }
  /** 工作區層級的授權事件（授權變更、完整存取）不屬於單次執行，直接寫入稽核紀錄。 */
  auditWorkspace(kind: AuditEvent['kind'], detail: string): Promise<void> { return this.repository.audit({ at: Date.now(), kind, detail: detail.slice(0, 200) }); }
  private async run(task: Task, history: Task[], controller: AbortController, persist: boolean, resumeSessionId?: string): Promise<void> {
    const { prompt: message, contextIds } = resumeSessionId ? { prompt: task.prompt, contextIds: [] } : buildContext(history, task.prompt);
    if (contextIds.length) task.contextIds = contextIds; else delete task.contextIds;
    if (resumeSessionId) task.contextMode = 'native'; else if (contextIds.length) task.contextMode = 'rebuilt'; else delete task.contextMode;
    const language = this.languageInstruction?.();
    const prompt = [task.participantRole && roleInstructions[task.participantRole], language, message].filter(Boolean).join('\n\n');
    const env = await this.accountEnv(task.provider, task.accountId);
    const conversationId = this.taskConversations.get(task.id) ?? this.repository.conversationId;
    if (task.attachments?.length && !this.attachmentStore) throw new Error('目前無法讀取圖片附件。');
    const images = task.attachments?.length ? await Promise.all(task.attachments.map(async item => ({ mime: item.mime, data: await this.attachmentStore!.read(conversationId, item.id) }))) : undefined;
    for await (const event of this.registry.get(task.provider).execute({ taskId: task.id, prompt, cwd: this.cwd, mode: task.mode, model: task.model, effort: task.effort, approvalMode: task.approvalMode, persist, resumeSessionId, ...(this.state.policy.readRoots?.length && { readRoots: this.state.policy.readRoots }), ...(this.state.policy.network && { network: true }), ...(env && { env }), ...(images && { images }), approve: request => this.requestApproval(task, request, controller.signal), signal: controller.signal, timeoutMs: this.timeoutMs() })) {
      if (event.type === 'text-delta') {
        if (task.output.length + event.text.length > 512 * 1024) throw new Error('回應超過 512 KB 上限，已停止任務。');
        task.output += event.text;
        const last = task.steps?.at(-1);
        if (last?.kind === 'text') last.text += event.text; else task.steps?.push({ kind: 'text', text: event.text });
      } else if (event.type === 'activity') task.activity = event.text;
      else if (event.type === 'tool') this.toolStep(task, event);
      else if (event.type === 'usage') this.onUsage?.(task.provider, task.accountId, event.usage);
      else task.sessionId = event.sessionId;
      this.changed(true);
    }
  }
  /** 第一次出現工具時才建立步驟清單，先放入目前為止的文字，之後文字與工具依實際順序交錯。 */
  private toolStep(task: Task, event: Extract<AgentEvent, { type: 'tool' }>): void {
    const steps = task.steps ??= task.output ? [{ kind: 'text', text: task.output }] : [];
    let step = steps.find(item => item.kind === 'tool' && item.id === event.id);
    if (!step) {
      if (steps.filter(item => item.kind === 'tool').length >= maxTools) return;
      step = { kind: 'tool', id: event.id, name: event.tool, status: 'running' }; steps.push(step);
      this.audit(task, 'tool-start', event.tool);
    }
    if (step.kind !== 'tool') return;
    if (event.input) step.input = redact(event.input, inputLimit);
    if (event.phase === 'end') {
      step.status = event.success === false ? 'failed' : 'done';
      if (event.output) step.output = redact(event.output, outputLimit);
      this.audit(task, event.success === false ? 'tool-failed' : 'tool-end', event.tool);
    }
  }
  private audit(task: Task, kind: AuditEvent['kind'], detail: string): void {
    const events = task.events ??= [];
    if (events.length < maxEvents) events.push({ at: Date.now(), kind, detail: detail.slice(0, 200) });
  }
  /** 使用者標成不採用的回答保留在紀錄裡，但之後組上下文時不再當成事實帶入。 */
  async setRejected(taskId: string, rejected: boolean): Promise<void> {
    const task = this.state.tasks.find(item => item.id === taskId);
    if (!task || task.status !== 'completed' || task.discussionId) throw new Error('只能標記已完成的一般回答。');
    if (rejected) task.rejected = true; else delete task.rejected;
    this.changed(); await this.flush();
  }
  /** 把補充訊息送進執行中的任務；成功後記在該則使用者訊息後面，回放歷史時也看得到。 */
  async steer(taskId: string, text: string): Promise<void> {
    const active = this.active;
    if (!active || active.task.id !== taskId || active.task.status !== 'running') throw new Error('這個任務已經結束，請改為排隊送出。');
    const adapter = this.registry.get(active.task.provider);
    if (!adapter.steer || !adapter.capabilities().steer) throw new Error('這個 Agent 不支援補充給執行中的任務，訊息會等任務完成再送出。');
    await adapter.steer(taskId, text);
    active.task.prompt = `${active.task.prompt}\n\n補充：${text}`; this.changed();
  }
  async cancel(taskId?: string): Promise<void> {
    // 排隊中的任務直接取消，不會啟動。
    const queued = taskId ? [...this.live.values()].flat().find(task => task.id === taskId && task.status === 'queued') : undefined;
    if (queued) { queued.status = 'cancelled'; queued.endedAt = Date.now(); queued.activity = undefined; this.changed(); await this.flush(); return; }
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
      // 不限時間時核准卡一直等到使用者回答或停止任務。
      const limit = this.timeoutMs();
      const timer = limit > 0 ? setTimeout(() => finish(false), Math.max(1, limit - (Date.now() - task.startedAt))) : undefined;
      const finish = (allow: boolean) => {
        this.audit(task, allow ? 'approval-allowed' : 'approval-denied', request.title);
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        this.approvalAnswers.delete(id); this.state.approvals = this.state.approvals?.filter(item => item.id !== id);
        this.changed(); resolve(allow);
      };
      this.approvalAnswers.set(id, finish);
      signal.addEventListener('abort', abort, { once: true });
      this.audit(task, 'approval-requested', request.title);
      this.state.approvals!.push({ id, taskId: task.id, provider: task.provider, ...request, conversationId: this.active?.conversationId }); this.changed();
    });
  }
  answerApproval(id: string, allow: boolean): void {
    const answer = this.approvalAnswers.get(id);
    if (!answer) throw new Error('此核准請求已失效。');
    answer(allow);
  }
  /** 一般任務在背景繼續執行時可以切換或新增對話；討論進行中仍需等待或停止。 */
  private async navigate(operation: () => Promise<void>): Promise<void> {
    if (this.navigating || this.state.discussionId) throw new Error(this.state.discussionId ? '討論進行中，請等待完成或停止討論。' : '請等候切換完成。');
    this.navigating = true;
    try { await operation(); } finally { this.navigating = false; this.changed(); }
  }
  async newConversation(): Promise<void> {
    await this.navigate(async () => {
      await this.flush(); this.repository.create();
      this.state.conversationId = this.repository.conversationId; this.state.tasks = []; this.state.hasEarlier = undefined; this.state.externalChanges = undefined;
    });
  }
  async openConversation(id: string): Promise<void> {
    await this.navigate(async () => {
      await this.flush();
      const live = this.live.get(id);
      if (live) this.repository.use(id);
      this.state.tasks = live ?? this.repository.select(id);
      this.state.conversationId = id; this.state.externalChanges = undefined; this.paging();
    });
  }
  /** 搜尋只返回目前工作區允許的 Provider 紀錄。 */
  searchConversations(query: string, filters: SearchFilters = {}) { return this.repository.list(query, filters, this.state.policy.allowedProviders); }
  async renameConversation(id: string, title: string): Promise<void> {
    await this.navigate(async () => { await this.repository.rename(id, title); this.listed = this.repository.list(); });
  }
  async deleteConversation(id: string): Promise<void> {
    if (this.live.has(id)) throw new Error('此對話仍有執行中或排隊的任務，請先停止。');
    await this.navigate(async () => {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
      await this.repository.delete(id); await this.attachmentStore?.removeConversation(id).catch(() => undefined);
      if (id === this.repository.conversationId) {
        const next = this.repository.list()[0];
        this.state.tasks = next ? this.repository.select(next.id) : [];
        if (!next) this.repository.create();
        this.state.conversationId = this.repository.conversationId;
      }
      this.listed = this.repository.list();
    });
  }
  /** 停用保存後新的訊息只在記憶體，也不保留官方原生 Session；已保存的紀錄要另外清除。 */
  async setPersistence(enabled: boolean): Promise<void> {
    await this.flush(); await this.repository.setPersistent(enabled); this.state.persistent = enabled; this.changed();
  }
  async clearProject(): Promise<void> {
    if (this.live.size || this.state.discussionId) throw new Error('請先停止目前任務或討論，再清除專案紀錄。');
    await this.navigate(async () => {
      if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = undefined; }
      const ids = this.repository.list().map(item => item.id);
      await this.repository.clearProject(); this.repository.create();
      await Promise.all(ids.map(id => this.attachmentStore?.removeConversation(id).catch(() => undefined)));
      this.state.tasks = []; this.state.conversationId = this.repository.conversationId; this.listed = this.repository.list();
    });
  }
  exportConversation(id: string) { return this.repository.exportConversation(id); }
  backupHistory(target: string): Promise<void> { return this.repository.backup(target); }
  /** 還原備份會取代整個資料庫，只能在沒有任何執行、排隊或討論時進行；完成後重新載入目前專案最新的對話。 */
  async restoreHistory(source: string): Promise<string> {
    if (this.active || this.pending() || this.state.discussionId || this.navigating) throw new Error('請先停止目前任務或討論，再還原備份。');
    let previous = '';
    await this.navigate(async () => {
      await this.flush(); previous = await this.repository.restore(source);
      const stored = this.repository.load();
      this.state.tasks = stored.tasks; this.state.policy = stored.policy; this.state.conversationId = this.repository.conversationId;
      this.listed = this.repository.list();
    });
    return previous;
  }
  async invalidateWorkspace(): Promise<void> { this.state.trusted = false; this.changed(); await this.cancel(); }
  async dispose(): Promise<void> {
    for (const task of [...this.live.values()].flat()) if (task.status === 'queued') { task.status = 'cancelled'; task.endedAt = Date.now(); }
    await this.cancel(); await this.flush(); await this.repository.close(); this.listeners.clear();
  }
}
