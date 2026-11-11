import initSqlJs, { type Database } from 'sql.js';
import { mkdir, readFile, rename, writeFile, open, unlink, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConversationSummary, Task, WorkspacePolicy } from '../bridge/messages';
import { taskSchema } from '../bridge/messages';

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
    if (version > 1) throw new Error('歷史資料庫版本較新，請更新插件後再開啟。');
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,root TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,started_at INTEGER NOT NULL,search_body TEXT NOT NULL,task_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS conversations_root_time ON conversations(root,updated_at DESC);
      CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id,started_at);
      PRAGMA user_version=1;`);
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
  private rows(sql: string, values: Array<string | number> = []): Record<string, unknown>[] {
    const statement = this.db.prepare(sql);
    try { statement.bind(values); const rows = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
    finally { statement.free(); }
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
      for (const task of snapshot) db.run('INSERT OR REPLACE INTO runs VALUES(?,?,?,?,?,?)', [task.id, id, task.provider, task.startedAt, task.prompt + '\n' + task.output, JSON.stringify(task)]);
    });
  }
  rename(id: string, title: string): Promise<void> { return this.mutate(db => { db.run('UPDATE conversations SET title=?,updated_at=? WHERE id=? AND root=?', [title, Date.now(), id, this.root]); }); }
  delete(id: string): Promise<void> { return this.mutate(db => { db.run('DELETE FROM conversations WHERE id=? AND root=?', [id, this.root]); }); }
  async close(): Promise<void> { await this.writes; this.db.close(); }
}
