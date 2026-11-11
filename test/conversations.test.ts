import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
});
