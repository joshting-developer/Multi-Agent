import initSqlJs, { type Database } from 'sql.js';
import { copyFile, mkdir, readFile, rename, writeFile, open, unlink, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentId, AuditEvent, ConversationSummary, SearchFilters, Task, WorkspacePolicy } from '../bridge/messages';
import { agentIdSchema, taskSchema } from '../bridge/messages';

export interface StoredParticipant { id: string; provider: AgentId; role: string; nativeSessionId?: string }
export interface StoredRound { discussionId: string; roundNo: number; senderParticipantId: string; runId: string; messageId: string }
export interface StoredAudit extends AuditEvent { runId?: string }
/** 單一對話的完整匯出：保留各自的 ID、專案 scope、schema 版本與狀態，供人閱讀或另存。 */
export interface ConversationExport {
  format: 'multi-agent-conversation'; schemaVersion: number; exportedAt: string; root: string;
  conversation: { id: string; title: string; createdAt: number; updatedAt: number };
  runs: Task[]; messages: StoredMessage[]; participants: StoredParticipant[]; rounds: StoredRound[]; summaries: StoredSummary[];
}
export interface StoredSummary { discussionId: string; runId: string; messageId: string; throughRound: number }
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
    if (version > 5) throw new Error('歷史資料庫版本較新，請更新插件後再開啟。');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,root TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,started_at INTEGER NOT NULL,search_body TEXT NOT NULL,task_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_root_time ON conversations(root,updated_at DESC);
      CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,started_at);`);
    if (version < 2) this.schemaV2(db);
    if (version < 3) {
      db.exec(`CREATE TABLE discussion_rounds(discussion_id TEXT NOT NULL,round_no INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,participant_id TEXT NOT NULL REFERENCES participants(id),run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(discussion_id,round_no));
        PRAGMA user_version=3;`);
    }
    if (version < 4) {
      // v4：討論結論各自連回所屬討論與涵蓋到的輪次，來源訊息經 discussion_rounds 回溯。
      db.exec(`CREATE TABLE discussion_summaries(discussion_id TEXT NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,through_round INTEGER NOT NULL);
        CREATE INDEX discussion_summaries_discussion ON discussion_summaries(discussion_id);
        PRAGMA user_version=4;`);
    }
    if (version < 5) {
      // v5：稽核事件只存種類與簡短說明；工作區層級事件沒有 conversation／run。
      db.exec(`CREATE TABLE audit_events(root TEXT NOT NULL,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE INDEX audit_events_run ON audit_events(run_id);
        CREATE INDEX audit_events_root_time ON audit_events(root,created_at);
        PRAGMA user_version=5;`);
    }
    // 舊紀錄等所有資料表都建好後才回填，回填與一般寫入走同一條 writeRun。
    if (version < 2) {
      const now = Date.now();
      for (const row of this.rowsOf(db, 'SELECT conversation_id,task_json FROM runs ORDER BY started_at,rowid')) this.writeRun(db, String(row.conversation_id), taskSchema.parse(JSON.parse(String(row.task_json))), now);
    }
  }
  private schemaV2(db: Database) {
    // v2: Participant／Message 各有主鍵；原生 Session 屬於 Participant，不與 ConversationId 混用。
    db.exec(`CREATE TABLE participants(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,role TEXT NOT NULL,native_session_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX participants_conversation ON participants(conversation_id,provider);
      ALTER TABLE runs ADD COLUMN participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL;
      CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent')),content TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(run_id,sender_type));
      CREATE INDEX messages_conversation ON messages(conversation_id,created_at);
      PRAGMA user_version=2;`);
  }
  private mutate(operation: (db: Database) => void, replacement?: Uint8Array): Promise<void> {
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
        if (replacement) { this.db.close(); this.db = new this.sql.Database(replacement); }
        else {
          try { const bytes = await readFile(this.filename); this.db.close(); this.db = new this.sql.Database(bytes); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
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
    db.run('DELETE FROM audit_events WHERE run_id=?', [task.id]);
    for (const event of task.events ?? []) db.run('INSERT INTO audit_events VALUES(?,?,?,?,?,?)', [this.root, conversationId, task.id, event.kind, event.detail, event.at]);
    // 重試或改由其他 Provider 執行時，失敗的那次保留紀錄但不再占用輪次。
    if (task.discussionId && !task.roundNo) db.run('DELETE FROM discussion_rounds WHERE run_id=?', [task.id]);
    if (task.discussionId && task.participantRole === 'summarizer') {
      db.run(`INSERT OR IGNORE INTO discussion_summaries SELECT ?,?,?,id,? FROM messages WHERE run_id=? AND sender_type='agent'`,
        [task.discussionId, conversationId, task.id, this.roundsBefore(db, task), task.id]);
    }
  }
  /**
   * 只搜尋目前專案。allowed 是目前工作區允許的 Provider：搜尋時不返回其他 Provider 的紀錄。
   * 有篩選條件時必須有一次執行同時符合全部條件；只有純文字搜尋才接受標題命中。
   */
  list(query = '', filters: SearchFilters = {}, allowed?: AgentId[]): ConversationSummary[] {
    const pattern = query.trim().toLocaleLowerCase();
    const filtered = !!(filters.provider || filters.mode || filters.since !== undefined || filters.until !== undefined);
    const searching = !!pattern || filtered;
    const clauses: string[] = []; const values: Array<string | number> = [];
    if (pattern) { clauses.push('instr(lower(r.search_body),?)>0'); values.push(pattern); }
    if (filters.provider) { clauses.push('r.provider=?'); values.push(filters.provider); }
    if (filters.since !== undefined) { clauses.push('r.started_at>=?'); values.push(filters.since); }
    if (filters.until !== undefined) { clauses.push('r.started_at<?'); values.push(filters.until); }
    if (filters.mode) clauses.push(`json_extract(r.task_json,'$.discussionId') IS ${filters.mode === 'discussion' ? 'NOT ' : ''}NULL`);
    if (searching && allowed) { clauses.push(`r.provider IN (${allowed.map(() => '?').join(',') || "''"})`); values.push(...allowed); }
    const match = `SELECT r.id FROM runs r WHERE r.conversation_id=c.id${clauses.map(clause => ` AND ${clause}`).join('')} ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`;
    const title = pattern && !filtered ? ` OR (instr(lower(c.title),?)>0${allowed ? ` AND EXISTS(SELECT 1 FROM runs a WHERE a.conversation_id=c.id AND a.provider IN (${allowed.map(() => '?').join(',') || "''"}))` : ''})` : '';
    const where = searching ? ` AND ((${match}) IS NOT NULL${title})` : '';
    return this.rows(`SELECT c.*, (SELECT provider FROM runs WHERE conversation_id=c.id ORDER BY started_at DESC LIMIT 1) provider,
      m.id match_id, m.provider match_provider, m.started_at match_at, json_extract(m.task_json,'$.discussionId') match_discussion,
      substr(m.search_body, max(1, instr(lower(m.search_body),?)-60), 180) preview,
      (SELECT id FROM messages WHERE run_id=m.id AND (?='' OR instr(lower(content),?)>0) ORDER BY sender_type='agent' DESC LIMIT 1) match_message
      FROM conversations c LEFT JOIN runs m ON ${searching ? `m.id=(${match})` : '0'} WHERE c.root=?${where} ORDER BY c.updated_at DESC`,
    // 參數順序對應 SQL 中 ? 的出現順序：片段、JOIN 的命中條件、專案、WHERE 的命中條件、標題。
    [pattern, pattern, pattern, ...(searching ? values : []), this.root, ...(searching ? values : []), ...(title ? [pattern, ...(allowed ?? [])] : [])]).map(row => ({
        id: String(row.id), title: String(row.title), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        provider: row.provider === 'claude' || row.provider === 'codex' ? row.provider : undefined,
        ...(typeof row.match_id === 'string' && { preview: String(row.preview ?? ''), match: { runId: row.match_id, ...(typeof row.match_message === 'string' && { messageId: row.match_message }), at: Number(row.match_at), provider: agentIdSchema.parse(row.match_provider), discussion: row.match_discussion !== null } })
      }));
  }
  /** 預設載入全部；limit 時只取最新的幾次（可用 before 往前翻頁），回傳順序仍是由舊到新。 */
  load(id: string, page: { limit?: number; before?: number } = {}): Task[] {
    if (!this.rows('SELECT 1 FROM conversations WHERE id=? AND root=?', [id, this.root]).length) throw new Error('找不到目前專案的對話。');
    if (!page.limit) return this.rows('SELECT task_json FROM runs WHERE conversation_id=? ORDER BY started_at,rowid', [id]).map(row => taskSchema.parse(JSON.parse(String(row.task_json))));
    return this.rows(`SELECT task_json FROM (SELECT task_json,started_at,rowid FROM runs WHERE conversation_id=?${page.before !== undefined ? ' AND started_at<?' : ''} ORDER BY started_at DESC,rowid DESC LIMIT ?) ORDER BY started_at,rowid`,
      page.before !== undefined ? [id, page.before, page.limit] : [id, page.limit]).map(row => taskSchema.parse(JSON.parse(String(row.task_json))));
  }
  /** 指定時間範圍內的執行 ID（since 含、before 不含），用來翻頁與發現其他視窗寫入的新訊息。 */
  runIds(id: string, since?: number, before?: number): string[] {
    return this.rows(`SELECT id FROM runs WHERE conversation_id=?${since !== undefined ? ' AND started_at>=?' : ''}${before !== undefined ? ' AND started_at<?' : ''}`,
      [id, ...(since !== undefined ? [since] : []), ...(before !== undefined ? [before] : [])]).map(row => String(row.id));
  }
  policy(): WorkspacePolicy | undefined {
    const value = this.rows('SELECT value FROM metadata WHERE key=?', ['policy:' + this.root])[0]?.value;
    return typeof value === 'string' ? JSON.parse(value) as WorkspacePolicy : undefined;
  }
  /** 專案層級設定：是否保存這個專案的對話（預設保存）。 */
  persistent(): boolean { return this.rows('SELECT value FROM metadata WHERE key=?', ['persist:' + this.root])[0]?.value !== '0'; }
  setPersistent(enabled: boolean): Promise<void> { return this.mutate(db => { db.run('INSERT OR REPLACE INTO metadata VALUES(?,?)', ['persist:' + this.root, enabled ? '1' : '0']); }); }
  savePolicy(policy: WorkspacePolicy): Promise<void> { return this.mutate(db => { db.run('INSERT OR REPLACE INTO metadata VALUES(?,?)', ['policy:' + this.root, JSON.stringify(policy)]); }); }
  /** 只刪除目前 canonical 專案的對話（連帶執行、訊息、討論、結論）與稽核紀錄；其他專案與授權設定不受影響。 */
  clearProject(): Promise<void> {
    return this.mutate(db => { db.run('DELETE FROM conversations WHERE root=?', [this.root]); db.run('DELETE FROM audit_events WHERE root=?', [this.root]); });
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
  audit(event: AuditEvent): Promise<void> {
    return this.mutate(db => { db.run('INSERT INTO audit_events VALUES(?,?,?,?,?,?)', [this.root, null, null, event.kind, event.detail, event.at]); });
  }
  /** 指定對話時回傳該對話各次執行的事件，否則回傳目前專案的工作區層級事件。 */
  auditEvents(conversationId?: string): StoredAudit[] {
    return this.rows(conversationId ? 'SELECT * FROM audit_events WHERE root=? AND conversation_id=? ORDER BY created_at,rowid' : 'SELECT * FROM audit_events WHERE root=? AND conversation_id IS NULL ORDER BY created_at,rowid',
      conversationId ? [this.root, conversationId] : [this.root]).map(row => ({ at: Number(row.created_at), kind: row.kind as AuditEvent['kind'], detail: String(row.detail), ...(typeof row.run_id === 'string' && { runId: row.run_id }) }));
  }
  summaries(conversationId: string): StoredSummary[] {
    return this.rows(`SELECT s.* FROM discussion_summaries s JOIN conversations c ON c.id=s.conversation_id WHERE c.root=? AND s.conversation_id=? ORDER BY s.rowid`, [this.root, conversationId]).map(row => ({
      discussionId: String(row.discussion_id), runId: String(row.run_id), messageId: String(row.message_id), throughRound: Number(row.through_round)
    }));
  }
  /** 總結只涵蓋開始前已完成的輪次；延長後新增的輪次不算進舊總結。 */
  private roundsBefore(db: Database, task: Task): number {
    return Number(this.rowsOf(db, 'SELECT coalesce(max(round_no),0) n FROM discussion_rounds d JOIN runs r ON r.id=d.run_id WHERE d.discussion_id=? AND r.started_at<=?', [task.discussionId!, task.startedAt])[0]?.n ?? 0);
  }
  exportConversation(id: string): ConversationExport {
    const conversation = this.list().find(item => item.id === id);
    if (!conversation) throw new Error('找不到目前專案的對話。');
    return {
      format: 'multi-agent-conversation', schemaVersion: Number(this.db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0), exportedAt: new Date().toISOString(), root: this.root,
      conversation: { id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt },
      runs: this.load(id), messages: this.messages(id), participants: this.participants(id), rounds: this.rounds(id), summaries: this.summaries(id)
    };
  }
  /** 備份整個本機資料庫檔（含所有專案），只寫到使用者選的本機位置。 */
  async backup(target: string): Promise<void> {
    await this.writes.catch(() => undefined);
    try { await copyFile(this.filename, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await writeFile(target, this.db.export()); }
    await chmod(target, 0o600);
  }
  /**
   * 從備份還原：先確認是 Multi-Agent 資料庫且版本不比目前新，原檔另存一份 before-restore 再取代；
   * 舊版備份會照一般升級流程補齊資料表，ID 與專案 scope 原樣保留。
   */
  async restore(source: string): Promise<string> {
    const bytes = await readFile(source);
    let candidate: Database | undefined;
    try {
      candidate = new this.sql.Database(bytes);
      const version = Number(candidate.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
      if (version > 5) throw new Error('備份來自較新的版本，請更新插件後再還原。');
      if (!candidate.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('conversations','runs')")[0]?.values.length) throw new Error('這不是 Multi-Agent 的歷史資料庫備份。');
    } catch (error) { throw error instanceof Error && /備份|版本/.test(error.message) ? error : new Error('無法讀取備份檔，請確認檔案是 Multi-Agent 的歷史資料庫。'); }
    finally { candidate?.close(); }
    await this.writes.catch(() => undefined);
    const previous = `${this.filename}.before-restore-${Date.now()}`;
    try { await copyFile(this.filename, previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.mutate(db => this.migrate(db), bytes);
    return previous;
  }
  rename(id: string, title: string): Promise<void> { return this.mutate(db => { db.run('UPDATE conversations SET title=?,updated_at=? WHERE id=? AND root=?', [title, Date.now(), id, this.root]); }); }
  delete(id: string): Promise<void> { return this.mutate(db => { db.run('DELETE FROM conversations WHERE id=? AND root=?', [id, this.root]); }); }
  async close(): Promise<void> { await this.writes; this.db.close(); }
}
