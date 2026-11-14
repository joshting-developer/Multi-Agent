import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { DiscussionCoordinator } from '../src/orchestration/DiscussionCoordinator';
import { ConversationDatabase } from '../src/storage/ConversationDatabase';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { AgentId } from '../src/bridge/messages';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { removeSmokeSessions } from './smoke-cleanup';

// Synthetic topic only. Never send this project's code or conversation during smoke tests.
const topic = 'Synthetic design question: for a tiny in-memory to-do list library, should items be stored in an array or a Map keyed by id? Answer in at most 80 words. Do not use any tools, read files, or access any project.';
const provider = (process.env.TEST_PROVIDER ?? 'codex') as AgentId;
const partner = (process.env.TEST_PARTNER ?? provider) as AgentId;
const rounds = Number(process.env.TEST_ROUNDS ?? 2);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-discussion-')));
// MA-98：在討論前放入只屬於單 Agent 聊天的標記字串，討論的實際輸入與輸出都不能出現。
const marker = `SOLO-MARKER-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const claudeMemory = join(homedir(), '.claude', 'projects', directory.replace(/[^A-Za-z0-9]/g, '-'));
/** 列出這次臨時工作區的 Codex 持久紀錄（使用者其他 Codex 程序的紀錄不算），用來確認 ephemeral thread 沒有寫入。 */
async function codexFiles(since: number): Promise<string[]> {
  const root = join(homedir(), '.codex', 'sessions'); const found: string[] = [];
  const walk = async (dir: string) => { for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) { const path = join(dir, entry.name); if (entry.isDirectory()) await walk(path); else if ((await stat(path)).mtimeMs >= since && (await readFile(path, 'utf8')).includes(directory)) found.push(path); } };
  await walk(root); return found;
}
/** 記錄每個 Participant 實際收到的完整輸入（含 Orchestrator 組好的上下文）。 */
function recording(adapter: AgentAdapter, log: AgentRequest[]): AgentAdapter {
  return { id: adapter.id, detect: () => adapter.detect(), capabilities: () => adapter.capabilities(), cancel: id => adapter.cancel(id), execute: request => { log.push(request); return adapter.execute(request); } };
}
const processes = new ProcessManager();
const smokeStartedAt = Date.now();
try {
  const providers = [...new Set([provider, partner])];
  const sent: AgentRequest[] = [];
  const adapters = providers.map(id => recording(id === 'claude' ? new ClaudeCodeAdapter(processes, () => '', directory) : new CodexAppServerAdapter(processes, () => '', directory), sent));
  const codexModel = providers.includes('codex') ? (await new CodexModelCatalog(processes, () => '', directory).list()).find(item => item.isDefault)?.id : undefined;
  if (providers.includes('codex')) assert.ok(codexModel, 'Codex model catalog is empty.');
  const preferencesFor = (id: AgentId) => ({ model: id === 'claude' ? 'sonnet' : codexModel!, effort: 'low' as const });
  const db = await ConversationDatabase.open(join(directory, 'history.sqlite'), directory, resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const orchestrator = new Orchestrator(new AgentRegistry(adapters), new SessionRepository({ get: () => undefined, update: async () => undefined }, directory, db), directory, () => true, () => 180000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: providers }); await orchestrator.checkProviders();
  const startedAt = Date.now();
  for (const id of providers) await orchestrator.send(id, `Remember this private codeword for later: ${marker}. Reply with exactly OK.`, 'read-only', preferencesFor(id));
  const before = sent.length;
  const result = await new DiscussionCoordinator(orchestrator).run(topic, [{ id: 'live-a', provider, role: 'architect', preferences: preferencesFor(provider) }, { id: 'live-b', provider: partner, role: 'critic', preferences: preferencesFor(partner) }], rounds);
  await orchestrator.flush();
  const conversationId = orchestrator.state.conversationId!;
  const participants = db.participants(conversationId); const stored = db.rounds(conversationId);
  console.log(JSON.stringify({ provider, partner, ...result, elapsedMs: Date.now() - startedAt,
    participants: participants.map(p => ({ id: p.id, provider: p.provider, role: p.role, nativeSession: !!p.nativeSessionId })),
    rounds: orchestrator.state.tasks.map(task => ({ roundNo: task.roundNo, participant: task.participantId, status: task.status, error: task.error, output: task.output.slice(0, 160) })) }, null, 2));
  assert.equal(result.status, 'completed'); assert.equal(stored.length, rounds);
  assert.deepEqual(stored.map(round => round.senderParticipantId), Array.from({ length: rounds }, (_, index) => index % 2 ? 'live-b' : 'live-a'));
  assert.ok(participants.every(p => p.nativeSessionId), 'Each participant should record a native session.');
  assert.notEqual(participants[0]!.nativeSessionId, participants[1]!.nativeSessionId);
  const discussionInputs = sent.slice(before).map(request => request.prompt);
  const discussionOutputs = orchestrator.state.tasks.filter(task => task.discussionId === result.id).map(task => task.output);
  assert.equal(discussionInputs.length, rounds + 1);
  assert.ok(!discussionInputs.some(prompt => prompt.includes(marker)), 'A discussion input contained the solo-chat marker.');
  assert.ok(!discussionOutputs.some(output => output.includes(marker)), 'A discussion output leaked the solo-chat marker.');
  assert.ok(sent.slice(0, before).every(request => request.prompt.includes(marker)), 'The solo chat should have received the marker.');
  await assert.rejects(stat(join(claudeMemory, 'memory')), 'Claude auto-memory must not be written for the workspace.');
  assert.deepEqual(await codexFiles(startedAt), [], 'Codex must not persist ephemeral discussion threads.');
  const summaries = db.summaries(conversationId);
  assert.equal(summaries.length, 1); assert.equal(summaries[0]!.throughRound, rounds); assert.equal(summaries[0]!.runId, result.summaryTaskId);
  const summary = orchestrator.state.tasks.find(task => task.id === result.summaryTaskId)!;
  assert.equal(summary.status, 'completed'); assert.ok(/R1/.test(summary.output), 'Summary should cite rounds.');
  console.log(`summary: ${summary.output.slice(0, 600)}`);
  await orchestrator.dispose();
  // 重新開啟資料庫：輪次與結論仍在。
  const reopened = await ConversationDatabase.open(join(directory, 'history.sqlite'), directory, resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  assert.equal(reopened.rounds(conversationId).length, rounds); assert.equal(reopened.summaries(conversationId)[0]?.runId, result.summaryTaskId);
  assert.ok(reopened.load(conversationId).some(task => task.id === result.summaryTaskId && task.output.length > 0));
  await reopened.close();
  console.log(`${provider}+${partner}: discussion smoke PASS (marker ${marker} isolated, no CLI memory written, reopen OK)`);
} finally { await removeSmokeSessions(directory, smokeStartedAt); await rm(directory, { recursive: true, force: true }); }
