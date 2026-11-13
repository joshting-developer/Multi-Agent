import { ConversationDatabase } from '../../src/storage/ConversationDatabase';
/** Only called by the isolated Host smoke harness, before VS Code starts. */
export async function seed(filename: string, root: string, wasmPath: string) {
  const db = await ConversationDatabase.open(filename, root, wasmPath);
  await db.save('host-history-fixture', '歷史對話驗證', [{
    id: 'host-history-run', provider: 'codex', mode: 'read-only', model: 'fixture-model', effort: 'medium',
    prompt: '驗證 SQLite 的注入失敗紀錄', output: 'HISTORY_REOPEN_OK：這是隔離測試的合成資料。',
    status: 'completed', startedAt: Date.now() - 9000, endedAt: Date.now() - 8000
  }, {
    // 工具過程、不採用、討論回合（含代替）與結論，供截圖檢查聊天畫面。
    id: 'host-tools-run', provider: 'claude', mode: 'read-only', model: 'fixture-model', prompt: '讀 notes.txt 回報數字',
    output: '先讀檔案。4217', rejected: true, status: 'completed', startedAt: Date.now() - 7000, endedAt: Date.now() - 6500,
    steps: [{ kind: 'text', text: '先讀檔案。' }, { kind: 'tool', id: 't1', name: 'Read', status: 'done', input: 'notes.txt', output: '1\tsynthetic value: 4217' },
      { kind: 'tool', id: 't2', name: 'Bash', status: 'failed', input: 'ls /a/very/long/path/that/should/wrap/inside/the/narrow/sidebar/without/horizontal/scrolling/at/all', output: 'No such file or directory' }, { kind: 'text', text: '4217' }]
  }, ...[1, 2].map(roundNo => ({
    id: `host-round-${roundNo}`, provider: roundNo === 1 ? 'codex' as const : 'claude' as const, mode: 'read-only' as const, model: 'fixture-model', prompt: '陣列還是 Map？',
    output: roundNo === 1 ? '建議用 Map。' : '陣列就夠了。', status: 'completed' as const, startedAt: Date.now() - 6000 + roundNo * 1000, endedAt: Date.now() - 5500 + roundNo * 1000,
    participantId: `host-p${roundNo}`, participantRole: roundNo === 1 ? 'architect' as const : 'critic' as const, discussionId: 'host-discussion', roundNo, ...(roundNo === 2 && { substitute: true })
  })), {
    id: 'host-summary', provider: 'codex', mode: 'read-only', model: 'fixture-model', prompt: '整串輪次', output: '**共識**：規模很小（A, R1；B, R2）。\n\n**分歧**：A 建議 Map（A, R1），B 認為陣列就夠（B, R2）。',
    status: 'completed', startedAt: Date.now() - 2000, endedAt: Date.now() - 1000, participantId: 'host-summary-p', participantRole: 'summarizer', discussionId: 'host-discussion'
  }], { classification: 'personal', allowedProviders: ['codex', 'claude'] });
  await db.close();
}
