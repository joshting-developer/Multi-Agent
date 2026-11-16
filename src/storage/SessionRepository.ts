import { randomUUID } from 'node:crypto';
import { ConversationDatabase, type ConversationExport } from './ConversationDatabase';
import type { AgentId, AuditEvent, ConversationSummary, SearchFilters } from '../bridge/messages';
import { z } from 'zod';
import { agentFeatures, agentIdSchema, taskSchema, type Task, type WorkspacePolicy } from '../bridge/messages';

export interface StateStorage { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> }
const storedSchema = z.object({
  version: z.literal(1), root: z.string(), tasks: z.array(taskSchema).max(60),
  policy: z.object({ classification: z.enum(['unclassified', 'personal', 'company', 'restricted']), allowedProviders: z.array(agentIdSchema), readRoots: z.array(z.string().max(4096)).max(20).optional(), network: z.boolean().optional(), features: z.array(z.enum(agentFeatures)).max(agentFeatures.length).optional() })
});
/** 開啟對話時先載入的最新執行數；更早的訊息按需往前翻頁。 */
export const pageSize = 100;
export class SessionRepository {
  /** 每個對話已寫入或載入的執行快照：只把有變動的執行寫回，並用來發現其他視窗的新訊息。 */
  private readonly known = new Map<string, Map<string, string>>();
  private remember(conversationId: string, tasks: Task[]): Task[] {
    const known = this.known.get(conversationId) ?? new Map<string, string>();
    for (const task of tasks) known.set(task.id, JSON.stringify(task));
    this.known.set(conversationId, known); return tasks;
  }
  private writes: Promise<void> = Promise.resolve();
  conversationId = randomUUID() as string;
  private memory = new Map<string, { title: string; tasks: Task[]; createdAt: number }>();
  constructor(private readonly storage: StateStorage, private readonly root: string, private readonly database?: ConversationDatabase) {}
  load(): { tasks: Task[]; policy: WorkspacePolicy } {
    const latest = this.database?.list()[0];
    if (latest) { this.conversationId = latest.id; return { tasks: this.recover(this.remember(latest.id, this.database!.load(latest.id, { limit: pageSize }))), policy: this.database!.policy() ?? { classification: 'unclassified', allowedProviders: [] } }; }
    const parsed = storedSchema.safeParse(this.database && this.storage.get('multiAgent.sqliteMigrated') ? undefined : this.storage.get('multiAgent.session.v1'));
    if (!parsed.success || parsed.data.root !== this.root) return { tasks: [], policy: this.database?.policy() ?? { classification: 'unclassified', allowedProviders: [] } };
    const tasks = this.recover(parsed.data.tasks);
    return { tasks, policy: parsed.data.policy };
  }
  /** 預設存到目前檢視的對話；背景執行中的對話以 conversationId 指定。 */
  /** 停用保存時對話只留在記憶體，不寫入任何檔案；工作區授權仍保存，避免每次重新授權。 */
  get persistent(): boolean { return this.database?.persistent() ?? true; }
  private savedPolicy?: string;
  save(tasks: Task[], policy: WorkspacePolicy, conversationId = this.conversationId): Promise<void> {
    if (this.database && !this.persistent) {
      this.memory.set(conversationId, { title: tasks[0]?.prompt.slice(0, 80) || '新對話', tasks: structuredClone(tasks), createdAt: tasks[0]?.startedAt ?? Date.now() });
      const value = JSON.stringify(policy);
      if (value === this.savedPolicy) return Promise.resolve();
      this.savedPolicy = value; return this.database.savePolicy(policy);
    }
    // 重新開始保存時，記憶體中的對話改寫入資料庫。
    if (this.database) this.memory.delete(conversationId);
    if (this.database) {
      // 只寫回有變動的執行；長對話每次存檔不必重寫全部歷史。
      const known = this.known.get(conversationId);
      const snapshots = tasks.map(task => [task, JSON.stringify(task)] as const).filter(([task, json]) => known?.get(task.id) !== json);
      const policyJson = JSON.stringify(policy);
      if (!snapshots.length && policyJson === this.savedPolicy) return Promise.resolve();
      return this.database.save(conversationId, tasks[0]?.prompt.slice(0, 80) || '新對話', snapshots.map(([task]) => task), policy).then(async () => {
        this.savedPolicy = policyJson;
        const map = this.known.get(conversationId) ?? new Map<string, string>();
        for (const [task, json] of snapshots) map.set(task.id, json);
        this.known.set(conversationId, map);
        if (!this.storage.get('multiAgent.sqliteMigrated')) await this.storage.update('multiAgent.sqliteMigrated', true);
      });
    }
    this.memory.set(conversationId, { title: tasks[0]?.prompt.slice(0, 80) || '新對話', tasks: structuredClone(tasks), createdAt: tasks[0]?.startedAt ?? Date.now() });
    // Snapshot before enqueueing so later streaming mutations cannot corrupt an earlier write.
    const value = JSON.parse(JSON.stringify({ version: 1, root: this.root, tasks, policy })) as unknown;
    this.writes = this.writes.catch(() => undefined).then(() => this.storage.update('multiAgent.session.v1', value));
    return this.writes;
  }
  private recover(tasks: Task[]): Task[] { return tasks.map(task => task.status === 'running' || task.status === 'queued' ? { ...task, status: 'interrupted', endedAt: Date.now(), error: task.status === 'queued' ? '上次 VS Code 關閉時任務仍在排隊；沒有執行。' : '上次 VS Code 關閉時任務仍在執行；未判定為成功。' } : task); }
  list(query = '', filters: SearchFilters = {}, allowed?: AgentId[]): ConversationSummary[] {
    if (this.database && this.memory.size) {
      // 停用保存期間的對話只在記憶體，列在最前面（只做標題比對）。
      const unsaved = [...this.memory].filter(([, value]) => !query || value.title.toLowerCase().includes(query.toLowerCase())).map(([id, value]) => ({ id, title: value.title, createdAt: value.createdAt, updatedAt: value.tasks.at(-1)?.startedAt ?? value.createdAt })).sort((a, b) => b.updatedAt - a.updatedAt);
      return [...unsaved, ...this.database.list(query, filters, allowed).filter(item => !this.memory.has(item.id))];
    }
    return this.database?.list(query, filters, allowed) ?? [...this.memory].filter(([, value]) => JSON.stringify(value).toLowerCase().includes(query.toLowerCase())).map(([id, value]) => ({ id, title: value.title, createdAt: value.createdAt, updatedAt: value.createdAt }));
  }
  select(id: string): Task[] {
    const tasks = this.memory.get(id)?.tasks ?? (this.database && this.remember(id, this.database.load(id, { limit: pageSize })));
    if (!tasks) throw new Error('找不到對話。');
    this.conversationId = id; return this.recover(structuredClone(tasks));
  }
  create(): void { this.conversationId = randomUUID(); }
  /** 往前載入一頁更早的執行。 */
  loadEarlier(id: string, before: number): Task[] { return this.database ? this.recover(this.remember(id, this.database.load(id, { limit: pageSize, before }))) : []; }
  hasEarlier(id: string, before?: number): boolean { return before !== undefined && !!this.database && !this.memory.has(id) && this.database.runIds(id, undefined, before).length > 0; }
  /** 其他視窗在這個對話寫入、而本視窗沒有的執行。 */
  externalRuns(id: string, since?: number): number {
    const known = this.known.get(id);
    if (!this.database || this.memory.has(id) || !known) return 0;
    return this.database.runIds(id, since).filter(run => !known.has(run)).length;
  }
  /** 切換到仍在記憶體中執行的對話，不從儲存重新載入。 */
  use(id: string): void { this.conversationId = id; }
  async rename(id: string, title: string): Promise<void> { if (this.database) await this.database.rename(id, title); else { const value = this.memory.get(id); if (value) value.title = title; } }
  async delete(id: string): Promise<void> { this.memory.delete(id); this.known.delete(id); await this.database?.delete(id); }
  async setPersistent(enabled: boolean): Promise<void> { await this.requireDatabase().setPersistent(enabled); }
  /** 清除目前專案在資料庫與記憶體中的所有對話。 */
  async clearProject(): Promise<void> { this.memory.clear(); this.known.clear(); await this.requireDatabase().clearProject(); }
  async audit(event: AuditEvent): Promise<void> { await this.database?.audit(event); }
  private requireDatabase(): ConversationDatabase { if (!this.database) throw new Error('目前沒有可用的歷史資料庫。'); return this.database; }
  exportConversation(id: string): ConversationExport { return this.requireDatabase().exportConversation(id); }
  backup(target: string): Promise<void> { return this.requireDatabase().backup(target); }
  restore(source: string): Promise<string> { this.known.clear(); this.savedPolicy = undefined; return this.requireDatabase().restore(source); }
  async close(): Promise<void> { await this.database?.close(); }
}
