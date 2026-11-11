import { ConversationDatabase } from '../../src/storage/ConversationDatabase';
/** Only called by the isolated Host smoke harness, before VS Code starts. */
export async function seed(filename: string, root: string, wasmPath: string) {
  const db = await ConversationDatabase.open(filename, root, wasmPath);
  await db.save('host-history-fixture', '歷史對話驗證', [{
    id: 'host-history-run', provider: 'codex', mode: 'read-only', model: 'fixture-model', effort: 'medium',
    prompt: '驗證 SQLite 的注入失敗紀錄', output: 'HISTORY_REOPEN_OK：這是隔離測試的合成資料。',
    status: 'completed', startedAt: Date.now() - 1000, endedAt: Date.now()
  }], { classification: 'personal', allowedProviders: ['codex', 'claude'] });
  await db.close();
}
