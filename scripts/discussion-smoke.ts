import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

// Synthetic topic only. Never send this project's code or conversation during smoke tests.
const topic = 'Synthetic design question: for a tiny in-memory to-do list library, should items be stored in an array or a Map keyed by id? Answer in at most 80 words. Do not use any tools, read files, or access any project.';
const provider = (process.env.TEST_PROVIDER ?? 'codex') as AgentId;
const rounds = Number(process.env.TEST_ROUNDS ?? 2);
const directory = await mkdtemp(join(tmpdir(), 'multi-agent-discussion-'));
const processes = new ProcessManager();
try {
  const adapter = provider === 'claude' ? new ClaudeCodeAdapter(processes, () => '', directory) : new CodexAppServerAdapter(processes, () => '', directory);
  const model = provider === 'claude' ? 'sonnet' : (await new CodexModelCatalog(processes, () => '', directory).list()).find(item => item.isDefault)?.id;
  assert.ok(model, 'Codex model catalog is empty.');
  const db = await ConversationDatabase.open(join(directory, 'history.sqlite'), directory, resolve('node_modules/sql.js/dist/sql-wasm.wasm'));
  const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, directory, db), directory, () => true, () => 180000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: [provider] }); await orchestrator.checkProviders();
  const startedAt = Date.now();
  const result = await new DiscussionCoordinator(orchestrator).run(topic, [{ id: 'live-a', provider, role: 'architect' }, { id: 'live-b', provider, role: 'critic' }], rounds, { model, effort: 'low' });
  await orchestrator.flush();
  const conversationId = orchestrator.state.conversationId!;
  const participants = db.participants(conversationId); const stored = db.rounds(conversationId);
  console.log(JSON.stringify({ provider, model, ...result, elapsedMs: Date.now() - startedAt,
    participants: participants.map(p => ({ id: p.id, role: p.role, nativeSession: !!p.nativeSessionId })),
    rounds: orchestrator.state.tasks.map(task => ({ roundNo: task.roundNo, participant: task.participantId, status: task.status, error: task.error, output: task.output.slice(0, 160) })) }, null, 2));
  assert.equal(result.status, 'completed'); assert.equal(stored.length, rounds);
  assert.deepEqual(stored.map(round => round.senderParticipantId), Array.from({ length: rounds }, (_, index) => index % 2 ? 'live-b' : 'live-a'));
  assert.ok(participants.every(p => p.nativeSessionId), 'Each participant should record a native session.');
  assert.notEqual(participants[0]!.nativeSessionId, participants[1]!.nativeSessionId);
  await orchestrator.dispose();
  console.log(`${provider}: discussion smoke PASS`);
} finally { await rm(directory, { recursive: true, force: true }); }
