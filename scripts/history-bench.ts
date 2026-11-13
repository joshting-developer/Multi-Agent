// MA-45 量測：長對話的儲存與載入成本。執行：node --import tsx scripts/history-bench.ts [runs...]
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import type { Task } from '../src/bridge/messages';

const wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm');
const policy = { classification: 'personal' as const, allowedProviders: ['codex' as const] };
for (const count of (process.argv.slice(2).map(Number).filter(Boolean).length ? process.argv.slice(2).map(Number) : [1000, 5000])) {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-bench-'));
  try {
    const db = await ConversationDatabase.open(join(dir, 'history.sqlite'), '/project', wasm);
    const tasks: Task[] = Array.from({ length: count }, (_, index) => ({ id: `run-${index}`, provider: 'codex', mode: 'read-only', prompt: `問題 ${index} `.repeat(20), output: `回答 ${index} 內容 `.repeat(200), status: 'completed', startedAt: index }));
    let started = Date.now(); await db.save('long', '長對話', tasks, policy); const initial = Date.now() - started;
    const next: Task = { ...tasks[0]!, id: 'run-next', startedAt: count, status: 'running', output: '串流中' };
    started = Date.now(); await db.save('long', '長對話', [...tasks, next], policy); const fullFlush = Date.now() - started;
    started = Date.now(); await db.save('long', '長對話', [next], policy); const dirtyFlush = Date.now() - started;
    started = Date.now(); const loaded = db.load('long').length; const loadAll = Date.now() - started;
    started = Date.now(); const page = db.load('long', { limit: 100 }).length; const loadPage = Date.now() - started;
    const size = (await stat(join(dir, 'history.sqlite'))).size;
    console.log(JSON.stringify({ runs: count, dbMB: +(size / 2 ** 20).toFixed(1), initialSaveMs: initial, flushAllRunsMs: fullFlush, flushChangedRunMs: dirtyFlush, loadAllMs: loadAll, loaded, loadPageMs: loadPage, page }));
    await db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
}
