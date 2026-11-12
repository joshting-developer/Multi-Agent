import initSqlJs, { type Database } from 'sql.js';
import { mkdir, readFile, rename, writeFile, open, unlink, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentId, ConversationSummary, Task, WorkspacePolicy } from '../bridge/messages';
import { agentIdSchema, taskSchema } from '../bridge/messages';

export interface StoredParticipant { id: string; provider: AgentId; role: string; nativeSessionId?: string }
export interface StoredRound { discussionId: string; roundNo: number; senderParticipantId: string; runId: string; messageId: string }
export interface StoredMessage { id: string; runId: string; participantId?: string; senderType: 'user' | 'agent'; content: string; status: string; createdAt: number }

/** SQLite WASM avoids native-addon ABI differences between Node and Electron. */
export class ConversationDatabase {
  private writes: Promise<void> = Promise.resolve();
  private constructor(private db: Database, private readonly filename: string, private readonly root: string, private readonly sql: Awaited<ReturnType<typeof initSqlJs>>) {}
  static async open(filename: string, root: string, wasmPath: string): Promise<ConversationDatabase> {
    const sql = await initSqlJs({ wasmBinary: new Uint8Array(await readFile(wasmPath)).buffer });
    let bytes: Buffer | undefined;
    try { bytes = await readFile(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const store = new ConversationDatabase(new sql.Database(bytes), filename, root, sql);
    await store.mutate(db => store.migrate(db));
    return store;
  }
  private migrate(db: Database) {
    const version = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
    if (version > 3) throw new Error('歷史資料庫版本較新，請更新插件後再開啟。');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,root TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,started_at INTEGER NOT NULL,search_body TEXT NOT NULL,task_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_root_time ON conversations(root,updated_at DESC);
      CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,started_at);`);
    if (version < 2) this.migrateV2(db);
    if (version < 3) {
      db.exec(`CREATE TABLE discussion_rounds(discussion_id TEXT NOT NULL,round_no INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,participant_id TEXT NOT NULL REFERENCES participants(id),run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(discussion_id,round_no));
        PRAGMA user_version=3;`);
    }
  }
  private migrateV2(db: Database) {
    // v2: Participant／Message 各有主鍵；原生 Session 屬於 Participant，不與 ConversationId 混用。
    db.exec(`CREATE TABLE participants(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,role TEXT NOT NULL,native_session_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX participants_conversation ON participants(conversation_id,provider);
      ALTER TABLE runs ADD COLUMN participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL;
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent')),content TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,sender_type));
      CREATE INDEX messages_conversation ON messages(conversation_id,created_at);`);
    const now = Date.now();
    for (const row of this.rowsOf(db, 'SELECT conversation_id,task_json FROM runs ORDER BY started_at,rowid')) this.writeRun(db, String(row.conversation_id), taskSchema.parse(JSON.parse(String(row.task_json))), now);
    db.exec('PRAGMA user_version=2');
  }
  private mutate(operation: (db: Database) => void): Promise<void> {
    const next = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
      // Short exclusive write lock prevents separate VS Code windows overwriting each other.
      let lock;
      for (let attempt = 0; !lock; attempt++) {
        try { lock = await open(this.filename + '.lock', 'wx', 0o600); await lock.writeFile(String(process.pid)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 30) throw new Error('歷史資料庫忙碌或鎖定；請關閉另一個視窗或檢查 storage 目錄的 .lock 檔。');
          try {
            const pid = Number(await readFile(this.filename + '.lock', 'utf8'));
            if (pid > 0) {
              try { process.kill(pid, 0); }
              catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(this.filename + '.lock'); continue; } }
            } else if (Date.now() - (await stat(this.filename + '.lock')).mtimeMs > 30000) { await unlink(this.filename + '.lock'); continue; }
          } catch { /* The owner may have released the lock. */ }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      const temp = this.filename + '.' + randomUUID() + '.tmp';
      try {
        try { const bytes = await readFile(this.filename); this.db.close(); this.db = new this.sql.Database(bytes); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
        try { operation(this.db); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        await writeFile(temp, this.db.export(), { mode: 0o600 });
        await rename(temp, this.filename); await chmod(this.filename, 0o600);
      } finally {
        await unlink(temp).catch(() => undefined); await lock.close(); await unlink(this.filename + '.lock');
      }
    });
    this.writes = next; return next;
  }
  private rows(sql: string, values: Array<string | number> = []): Record<string, unknown>[] { return this.rowsOf(this.db, sql, values); }
  private rowsOf(db: Database, sql: string, values: Array<string | number | null> = []): Record<string, unknown>[] {
    const statement = db.prepare(sql);
    try { statement.bind(values); const rows = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
    finally { statement.free(); }
  }
  /** 未指定 participantId 的舊流程歸到該 Provider 的預設 participant。 */
  private participantFor(db: Database, conversationId: string, task: Task, now: number): string {
    const id = task.participantId ?? String(this.rowsOf(db, "SELECT id FROM participants WHERE conversation_id=? AND provider=? AND role='solo' ORDER BY created_at,rowid LIMIT 1", [conversationId, task.provider])[0]?.id ?? randomUUID());
    const role = task.participantRole ?? 'solo';
    db.run(`INSERT INTO participants VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET native_session_id=coalesce(excluded.native_session_id,native_session_id),updated_at=excluded.updated_at
      WHERE participants.conversation_id=excluded.conversation_id AND participants.provider=excluded.provider AND participants.role=excluded.role`, [id, conversationId, task.provider, role, task.sessionId ?? null, task.startedAt, now]);
    if (!this.rowsOf(db, 'SELECT 1 FROM participants WHERE id=? AND conversation_id=? AND provider=? AND role=?', [id, conversationId, task.provider, role]).length) throw new Error('Participant 不屬於此對話、Provider 或角色。');
    return id;
  }
  private writeRun(db: Database, conversationId: string, task: Task, now: number) {
    const participantId = this.participantFor(db, conversationId, task, now);
    db.run(`INSERT INTO runs(id,conversation_id,provider,started_at,search_body,task_json,participant_id) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,started_at=excluded.started_at,search_body=excluded.search_body,task_json=excluded.task_json,participant_id=excluded.participant_id`,
    [task.id, conversationId, task.provider, task.startedAt, task.prompt + '\n' + task.output, JSON.stringify(task), participantId]);
    const upsert = `INSERT INTO messages VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(run_id,sender_type) DO UPDATE SET participant_id=excluded.participant_id,content=excluded.content,status=excluded.status,created_at=excluded.created_at`;
    db.run(upsert, [randomUUID(), conversationId, null, task.id, 'user', task.prompt, 'completed', task.startedAt]);
    db.run(upsert, [randomUUID(), conversationId, participantId, task.id, 'agent', task.output, task.status, task.endedAt ?? task.startedAt]);
    if (task.discussionId && task.roundNo) {
      db.run(`INSERT OR IGNORE INTO discussion_rounds SELECT ?,?,?,?,?,id FROM messages WHERE run_id=? AND sender_type='agent'`, [task.discussionId, task.roundNo, conversationId, participantId, task.id, task.id]);
      if (!this.rowsOf(db, 'SELECT 1 FROM discussion_rounds WHERE discussion_id=? AND round_no=? AND run_id=?', [task.discussionId, task.roundNo, task.id]).length) throw new Error('討論輪次已被其他執行占用。');
    }
  }
  list(query = ''): ConversationSummary[] {
    const pattern = query.trim().toLocaleLowerCase();
    return this.rows(`SELECT c.*, (SELECT provider FROM runs WHERE conversation_id=c.id ORDER BY started_at DESC LIMIT 1) provider,
      (SELECT substr(search_body,1,180) FROM runs WHERE conversation_id=c.id AND instr(lower(search_body),?)>0 ORDER BY started_at DESC LIMIT 1) preview
      FROM conversations c WHERE root=? AND (?='' OR instr(lower(title),?)>0 OR EXISTS(SELECT 1 FROM runs r WHERE r.conversation_id=c.id AND instr(lower(r.search_body),?)>0)) ORDER BY updated_at DESC`, [pattern, this.root, pattern, pattern, pattern]).map(row => ({
        id: String(row.id), title: String(row.title), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        provider: row.provider === 'claude' || row.provider === 'codex' ? row.provider : undefined, preview: typeof row.preview === 'string' ? row.preview : undefined
      }));
  }
  load(id: string): Task[] {
    if (!this.list().some(item => item.id === id)) throw new Error('找不到目前專案的對話。');
    return this.rows('SELECT task_json FROM runs WHERE conversation_id=? ORDER BY started_at,rowid', [id]).map(row => taskSchema.parse(JSON.parse(String(row.task_json))));
  }
  policy(): WorkspacePolicy | undefined {
    const value = this.rows('SELECT value FROM metadata WHERE key=?', ['policy:' + this.root])[0]?.value;
    return typeof value === 'string' ? JSON.parse(value) as WorkspacePolicy : undefined;
  }
  save(id: string, title: string, tasks: Task[], policy: WorkspacePolicy): Promise<void> {
    const snapshot = structuredClone(tasks);
    return this.mutate(db => {
      const now = Date.now();
      if (snapshot.length) db.run('INSERT INTO conversations VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at', [id, this.root, title, snapshot[0]?.startedAt ?? now, now]);
      db.run('INSERT OR REPLACE INTO metadata VALUES(?,?)', ['policy:' + this.root, JSON.stringify(policy)]);
      for (const task of snapshot) this.writeRun(db, id, task, now);
    });
  }
  participants(conversationId: string): StoredParticipant[] {
    return this.rows('SELECT p.* FROM participants p JOIN conversations c ON c.id=p.conversation_id WHERE c.root=? AND p.conversation_id=? ORDER BY p.created_at,p.rowid', [this.root, conversationId]).map(row => ({
      id: String(row.id), provider: agentIdSchema.parse(row.provider), role: String(row.role), nativeSessionId: typeof row.native_session_id === 'string' ? row.native_session_id : undefined
    }));
  }
  messages(conversationId: string): StoredMessage[] {
    return this.rows(`SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN runs r ON r.id=m.run_id WHERE c.root=? AND m.conversation_id=?
      ORDER BY r.started_at,r.rowid,m.sender_type='agent'`, [this.root, conversationId]).map(row => ({
      id: String(row.id), runId: String(row.run_id), participantId: typeof row.participant_id === 'string' ? row.participant_id : undefined,
      senderType: row.sender_type === 'agent' ? 'agent' : 'user', content: String(row.content), status: String(row.status), createdAt: Number(row.created_at)
    }));
  }
  rounds(conversationId: string): StoredRound[] {
    return this.rows(`SELECT d.* FROM discussion_rounds d JOIN conversations c ON c.id=d.conversation_id WHERE c.root=? AND d.conversation_id=? ORDER BY d.discussion_id,d.round_no`, [this.root, conversationId]).map(row => ({
      discussionId: String(row.discussion_id), roundNo: Number(row.round_no), senderParticipantId: String(row.participant_id), runId: String(row.run_id), messageId: String(row.message_id)
    }));
  }
  rename(id: string, title: string): Promise<void> { return this.mutate(db => { db.run('UPDATE conversations SET title=?,updated_at=? WHERE id=? AND root=?', [title, Date.now(), id, this.root]); }); }
  delete(id: string): Promise<void> { return this.mutate(db => { db.run('DELETE FROM conversations WHERE id=? AND root=?', [id, this.root]); }); }
  async close(): Promise<void> { await this.writes; this.db.close(); }
}
