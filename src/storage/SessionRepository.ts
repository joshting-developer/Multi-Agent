import { randomUUID } from 'node:crypto';
import { ConversationDatabase } from './ConversationDatabase';
import type { AuditEvent, ConversationSummary } from '../bridge/messages';
import { z } from 'zod';
import { agentIdSchema, taskSchema, type Task, type WorkspacePolicy } from '../bridge/messages';

export interface StateStorage { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> }
const storedSchema = z.object({
  version: z.literal(1), root: z.string(), tasks: z.array(taskSchema).max(60),
  policy: z.object({ classification: z.enum(['unclassified', 'personal', 'company', 'restricted']), allowedProviders: z.array(agentIdSchema) })
});
export class SessionRepository {
  private writes: Promise<void> = Promise.resolve();
  conversationId = randomUUID() as string;
  private memory = new Map<string, { title: string; tasks: Task[]; createdAt: number }>();
  constructor(private readonly storage: StateStorage, private readonly root: string, private readonly database?: ConversationDatabase) {}
  load(): { tasks: Task[]; policy: WorkspacePolicy } {
    const latest = this.database?.list()[0];
    if (latest) { this.conversationId = latest.id; return { tasks: this.recover(this.database!.load(latest.id)), policy: this.database!.policy() ?? { classification: 'unclassified', allowedProviders: [] } }; }
    const parsed = storedSchema.safeParse(this.database && this.storage.get('multiAgent.sqliteMigrated') ? undefined : this.storage.get('multiAgent.session.v1'));
    if (!parsed.success || parsed.data.root !== this.root) return { tasks: [], policy: this.database?.policy() ?? { classification: 'unclassified', allowedProviders: [] } };
    const tasks = this.recover(parsed.data.tasks);
    return { tasks, policy: parsed.data.policy };
  }
  save(tasks: Task[], policy: WorkspacePolicy): Promise<void> {
    if (this.database) return this.database.save(this.conversationId, tasks[0]?.prompt.slice(0, 80) || '新對話', tasks, policy).then(async () => { if (!this.storage.get('multiAgent.sqliteMigrated')) await this.storage.update('multiAgent.sqliteMigrated', true); });
    this.memory.set(this.conversationId, { title: tasks[0]?.prompt.slice(0, 80) || '新對話', tasks: structuredClone(tasks), createdAt: tasks[0]?.startedAt ?? Date.now() });
    // Snapshot before enqueueing so later streaming mutations cannot corrupt an earlier write.
    const value = JSON.parse(JSON.stringify({ version: 1, root: this.root, tasks, policy })) as unknown;
    this.writes = this.writes.catch(() => undefined).then(() => this.storage.update('multiAgent.session.v1', value));
    return this.writes;
  }
  private recover(tasks: Task[]): Task[] { return tasks.map(task => task.status === 'running' ? { ...task, status: 'interrupted', endedAt: Date.now(), error: '上次 VS Code 關閉時任務仍在執行；未判定為成功。' } : task); }
  list(query = ''): ConversationSummary[] {
    return this.database?.list(query) ?? [...this.memory].filter(([, value]) => JSON.stringify(value).toLowerCase().includes(query.toLowerCase())).map(([id, value]) => ({ id, title: value.title, createdAt: value.createdAt, updatedAt: value.createdAt }));
  }
  select(id: string): Task[] {
    const tasks = this.database ? this.database.load(id) : this.memory.get(id)?.tasks;
    if (!tasks) throw new Error('找不到對話。');
    this.conversationId = id; return this.recover(structuredClone(tasks));
  }
  create(): void { this.conversationId = randomUUID(); }
  async rename(id: string, title: string): Promise<void> { if (this.database) await this.database.rename(id, title); else { const value = this.memory.get(id); if (value) value.title = title; } }
  async delete(id: string): Promise<void> { if (this.database) await this.database.delete(id); else this.memory.delete(id); }
  async audit(event: AuditEvent): Promise<void> { await this.database?.audit(event); }
  async close(): Promise<void> { await this.database?.close(); }
}
