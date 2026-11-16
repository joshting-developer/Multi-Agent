import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import { toMarkdown } from '../src/storage/Export';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { Task } from '../src/bridge/messages';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const policy = { classification: 'personal' as const, allowedProviders: ['codex' as const] };
const task = (id: string, prompt: string): Task => ({ id, prompt, output: 'Laravel Container ERROR42 注入失敗已修正', provider: 'codex', mode: 'read-only', status: 'completed', startedAt: 1 });
const wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm');
async function setup() { const root = await mkdtemp(join(tmpdir(), 'multi-agent-db-')); roots.push(root); const path = join(root, 'history.sqlite'); return { path, db: await ConversationDatabase.open(path, '/project', wasm) }; }
describe('SQLite conversation history', () => {
  it('persists exact messages in a real SQLite file and reopens with Chinese/English search', async () => {
    const { db, path } = await setup();
    await db.save('one', 'DI 問題', [task('run-one', '訂單模組')], policy); await db.close();
    expect((await readFile(path)).subarray(0, 16).toString()).toBe('SQLite format 3\0');
    const reopened = await ConversationDatabase.open(path, '/project', wasm);
    expect(reopened.load('one')[0]).toEqual(task('run-one', '訂單模組'));
    expect(reopened.list('注入失敗').map(item => item.id)).toEqual(['one']);
    expect(reopened.list('error42')[0]).toMatchObject({ id: 'one', provider: 'codex' });
    expect(reopened.policy()).toEqual(policy); await reopened.close();
  });
  it('combines provider, solo／discussion and time filters, reports the matching run and hides providers that are not allowed', async () => {
    const { db } = await setup();
    const at = (day: number) => Date.UTC(2026, 10, day);
    await db.save('solo', '單 Agent', [{ ...task('s1', '快取失效'), startedAt: at(1) }, { ...task('s2', '快取'), provider: 'claude', startedAt: at(10) }], policy);
    await db.save('talk', '討論', [{ ...task('d1', '快取策略'), discussionId: 'd', roundNo: 1, participantId: 'a', participantRole: 'architect', startedAt: at(12) }], policy);
    await db.save('title', '快取 標題', [{ ...task('t1', '無關'), output: '無關', provider: 'claude', startedAt: at(2) }], policy);
    const ids = (query: string, filters = {}, allowed?: Array<'codex' | 'claude'>) => db.list(query, filters, allowed).map(item => item.id).sort();
    expect(ids('快取')).toEqual(['solo', 'talk', 'title']);
    expect(ids('快取', { mode: 'discussion' })).toEqual(['talk']);
    expect(ids('快取', { mode: 'solo', provider: 'codex' })).toEqual(['solo']);
    expect(ids('', { since: at(5) })).toEqual(['solo', 'talk']); expect(ids('', { since: at(5), until: at(11) })).toEqual(['solo']);
    // 結果顯示實際命中的那一次執行：Claude 在 11/10。
    expect(db.list('', { provider: 'claude', since: at(5) })[0]).toMatchObject({ id: 'solo', match: { runId: 's2', provider: 'claude', at: at(10), discussion: false } });
    expect(db.list('快取', { mode: 'discussion' })[0]?.match).toMatchObject({ runId: 'd1', discussion: true });
    // 不允許的 Provider：不返回它的執行，也不因標題命中而返回只有它紀錄的對話。
    expect(ids('快取', {}, ['codex'])).toEqual(['solo', 'talk']);
    expect(db.list('快取', {}, ['codex']).find(item => item.id === 'solo')?.match?.provider).toBe('codex');
    expect(ids('', {}, ['codex'])).toEqual(['solo', 'talk', 'title']);
    expect(db.list('失效')[0]?.preview).toContain('失效');
    await db.close();
  });
  it('pages long histories newest first, writes back only changed runs, and reports runs another window added', async () => {
    const { db, path } = await setup();
    const tasks = Array.from({ length: 250 }, (_, index) => ({ ...task(`r${index}`, `第 ${index} 則`), startedAt: index }));
    await db.save('long', '長對話', tasks, policy);
    const repository = new SessionRepository({ get: () => undefined, update: async () => undefined }, '/project', db);
    const page = repository.select('long');
    expect(page.map(item => item.startedAt)).toEqual(Array.from({ length: 100 }, (_, index) => 150 + index));
    expect(repository.hasEarlier('long', page[0]!.startedAt)).toBe(true);
    const earlier = repository.loadEarlier('long', page[0]!.startedAt);
    expect(earlier.map(item => item.startedAt)).toEqual(Array.from({ length: 100 }, (_, index) => 50 + index));
    expect(repository.hasEarlier('long', repository.loadEarlier('long', 50)[0]!.startedAt)).toBe(false);
    // 只寫回有變動的執行：未載入的舊訊息不會被覆寫或刪除。
    const changed = { ...page.at(-1)!, output: '更新後' }; const added = { ...task('new', '新問題'), startedAt: 300 };
    let written: Task[] = []; const original = db.save.bind(db);
    db.save = async (id, title, list, value) => { written = list; return original(id, title, list, value); };
    await repository.save([...page.slice(0, -1), changed, added], policy, 'long');
    expect(written.map(item => item.id)).toEqual(['r249', 'new']);
    await repository.save([...page.slice(0, -1), changed, added], policy, 'long'); expect(written.map(item => item.id)).toEqual(['r249', 'new']);
    expect(db.load('long').length).toBe(251); expect(db.load('long').find(item => item.id === 'r0')?.prompt).toBe('第 0 則');
    // 另一個視窗（另一個連線）在同一對話新增訊息：本視窗看得到數量，不會覆蓋它。
    const other = await ConversationDatabase.open(path, '/project', wasm);
    await other.save('long', '長對話', [{ ...task('other-window', '別的視窗'), startedAt: 400 }], policy); await other.close();
    await repository.save([...page.slice(0, -1), changed, added, { ...task('mine', '我的'), startedAt: 401 }], policy, 'long');
    expect(repository.externalRuns('long', page[0]!.startedAt)).toBe(1);
    expect(db.load('long').map(item => item.id)).toEqual(expect.arrayContaining(['other-window', 'mine']));
    await db.close();
  });
  it('exports a conversation as JSON and Markdown with stable ids, scope, schema version and status', async () => {
    const { db } = await setup();
    await db.save('one', '快取設計', [task('r1', '要用哪種快取？'), { ...task('r2', '再想想'), status: 'failed', error: '額度不足', rejected: true, steps: [{ kind: 'tool', id: 't', name: 'Read', status: 'done' }] }], policy);
    const data = db.exportConversation('one');
    expect(data).toMatchObject({ format: 'multi-agent-conversation', schemaVersion: 5, root: '/project', conversation: { id: 'one', title: '快取設計' } });
    expect(data.runs.map(run => [run.id, run.status])).toEqual([['r1', 'completed'], ['r2', 'failed']]);
    expect(data.messages.map(message => [message.runId, message.senderType])).toEqual([['r1', 'user'], ['r1', 'agent'], ['r2', 'user'], ['r2', 'agent']]);
    expect(data.messages.every(message => message.id.length > 10)).toBe(true);
    const markdown = toMarkdown(data);
    for (const text of ['# 快取設計', '對話 ID：one', 'run：`r1`', '要用哪種快取？', '· 失敗', '已不採用', 'Read（done）', '> 錯誤：額度不足']) expect(markdown).toContain(text);
    expect(() => db.exportConversation('missing')).toThrow(/找不到/);
    await db.close();
  });
  it('backs up and restores the whole database with ids and scope, keeping the replaced file and refusing foreign files', async () => {
    const { db, path } = await setup();
    await db.save('one', '保留', [task('r1', '備份前')], policy);
    const backup = path + '.backup.sqlite'; await db.backup(backup);
    await db.save('two', '之後才有', [task('r2', '備份後')], policy); await db.delete('one');
    expect(db.list().map(item => item.id)).toEqual(['two']);
    const previous = await db.restore(backup);
    expect(db.list().map(item => item.id)).toEqual(['one']); expect(db.load('one')[0]?.id).toBe('r1');
    const replaced = await ConversationDatabase.open(previous, '/project', wasm);
    expect(replaced.list().map(item => item.id)).toEqual(['two']); await replaced.close();
    const foreign = path + '.foreign.sqlite'; const SQL = await initSqlJs(); const other = new SQL.Database(); other.exec('CREATE TABLE notes(x)'); await writeFile(foreign, other.export());
    await expect(db.restore(foreign)).rejects.toThrow(/不是 Multi-Agent/);
    const newer = new SQL.Database(); newer.exec('CREATE TABLE conversations(id); PRAGMA user_version=9'); await writeFile(foreign, newer.export());
    await expect(db.restore(foreign)).rejects.toThrow(/較新/);
    await writeFile(foreign, 'not sqlite'); await expect(db.restore(foreign)).rejects.toThrow(/無法讀取/);
    expect(db.list().map(item => item.id)).toEqual(['one']);
    await db.close();
  });
  it('preserves more than 60 tasks, isolates workspace roots, renames and cascades deletion', async () => {
    const { db, path } = await setup();
    const tasks = Array.from({ length: 65 }, (_, index) => task(String(index), `hello ${index}`));
    await db.save('one', 'original', tasks, policy); await db.rename('one', '已命名');
    await db.save('one', 'original', tasks, policy); expect(db.list()[0]?.title).toBe('已命名');
    expect(db.load('one')).toHaveLength(65);
    const other = await ConversationDatabase.open(path, '/other-project', wasm);
    expect(other.list()).toEqual([]); expect(() => other.load('one')).toThrow(); await other.close();
    await db.delete('one'); expect(db.list()).toEqual([]); expect(() => db.load('one')).toThrow(); await db.close();
  });
  it('serializes separate writers without losing different conversations', async () => {
    const { db, path } = await setup(); const second = await ConversationDatabase.open(path, '/project', wasm);
    await Promise.all([db.save('one', 'first', [task('1', 'one')], policy), second.save('two', 'second', [task('2', 'two')], policy)]);
    await db.close(); await second.close(); const reopened = await ConversationDatabase.open(path, '/project', wasm);
    expect(reopened.list().map(item => item.id).sort()).toEqual(['one', 'two']); await reopened.close();
  });
  it('migrates previous workspace history once and restores running tasks as interrupted', async () => {
    const { db } = await setup(); const values = new Map<string, unknown>();
    values.set('multiAgent.session.v1', { version: 1, root: '/project', policy, tasks: [{ ...task('legacy', '舊對話'), status: 'running' }] });
    const storage = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { values.set(key, value); } };
    const repository = new SessionRepository(storage, '/project', db); const loaded = repository.load();
    expect(loaded.tasks[0]?.status).toBe('interrupted'); await repository.save(loaded.tasks, loaded.policy);
    expect(db.list()).toHaveLength(1); await repository.delete(repository.conversationId);
    const next = new SessionRepository(storage, '/project', db); expect(next.load().tasks).toEqual([]);
    await db.close();
  });
  it('upgrades a 0.1.4 (v1) database file without losing runs and backfills participants and messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-agent-db-')); roots.push(root); const path = join(root, 'history.sqlite');
    const sql = await initSqlJs({ wasmBinary: new Uint8Array(await readFile(wasm)).buffer }); const legacy = new sql.Database();
    legacy.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE conversations(id TEXT PRIMARY KEY,root TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE runs(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,provider TEXT NOT NULL,started_at INTEGER NOT NULL,search_body TEXT NOT NULL,task_json TEXT NOT NULL);
      PRAGMA user_version=1;`);
    const old = [{ ...task('r1', '第一題'), sessionId: 'codex-s1' }, { ...task('r2', '第二題'), startedAt: 2, endedAt: 3, sessionId: 'codex-s2' }, { ...task('r3', 'claude 題'), provider: 'claude' as const, startedAt: 4 }];
    legacy.run("INSERT INTO conversations VALUES('one','/project','舊',1,4)");
    for (const item of old) legacy.run('INSERT INTO runs VALUES(?,?,?,?,?,?)', [item.id, 'one', item.provider, item.startedAt, item.prompt + '\n' + item.output, JSON.stringify(item)]);
    await writeFile(path, legacy.export()); legacy.close();
    const db = await ConversationDatabase.open(path, '/project', wasm);
    expect(db.load('one')).toEqual(old);
    const participants = db.participants('one');
    expect(participants.map(p => [p.provider, p.role, p.nativeSessionId])).toEqual([['codex', 'solo', 'codex-s2'], ['claude', 'solo', undefined]]);
    const messages = db.messages('one');
    expect(messages.map(m => [m.runId, m.senderType, m.content])).toEqual([['r1', 'user', '第一題'], ['r1', 'agent', old[0]!.output], ['r2', 'user', '第二題'], ['r2', 'agent', old[1]!.output], ['r3', 'user', 'claude 題'], ['r3', 'agent', old[2]!.output]]);
    expect(messages.filter(m => m.senderType === 'agent').map(m => m.participantId)).toEqual([participants[0]!.id, participants[0]!.id, participants[1]!.id]);
    await db.close();
    const reopened = await ConversationDatabase.open(path, '/project', wasm);
    expect(reopened.messages('one').map(m => m.id)).toEqual(messages.map(m => m.id));
    await reopened.close();
  });
  it('keeps independent same-provider participants and stable message ids across saves', async () => {
    const { db } = await setup();
    const a = { ...task('a1', '架構'), participantId: 'codex-a', sessionId: 'sess-a' }; const b = { ...task('b1', '挑戰'), participantId: 'codex-b', sessionId: 'sess-b', startedAt: 2 };
    await db.save('one', 'A/B', [a, b], policy);
    const first = db.messages('one');
    await db.save('one', 'A/B', [a, { ...b, output: '更新後', status: 'completed' }], policy);
    expect(db.participants('one').map(p => [p.id, p.provider, p.nativeSessionId])).toEqual([['codex-a', 'codex', 'sess-a'], ['codex-b', 'codex', 'sess-b']]);
    const second = db.messages('one');
    expect(second.map(m => m.id)).toEqual(first.map(m => m.id)); expect(new Set(second.map(m => m.id)).size).toBe(4);
    expect(second.at(-1)).toMatchObject({ participantId: 'codex-b', content: '更新後' });
    await expect(db.save('two', 'other', [{ ...task('c1', 'x'), participantId: 'codex-a' }], policy)).rejects.toThrow('Participant');
    await db.delete('one'); expect(db.participants('one')).toEqual([]); expect(db.messages('one')).toEqual([]);
    await db.close();
  });
});
describe('Steer messages in exports', () => {
  it('exports a message added during the run as its own user line', () => {
    const run = { id: 'r', provider: 'codex', mode: 'read-only', prompt: '修 bug', output: 'ok', status: 'completed', startedAt: 0, steps: [{ kind: 'text', text: 'ok' }, { kind: 'steer', text: '也補測試', at: 1 }] } as Task;
    const markdown = toMarkdown({ conversation: { id: 'c', title: 't', createdAt: 0, updatedAt: 0 }, root: '/w', exportedAt: 'now', schemaVersion: 5, runs: [run] } as unknown as Parameters<typeof toMarkdown>[0]);
    expect(markdown).toContain('**使用者**\n\n修 bug'); expect(markdown).toContain('**使用者補充**\n\n也補測試');
  });
});
