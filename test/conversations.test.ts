import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
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
