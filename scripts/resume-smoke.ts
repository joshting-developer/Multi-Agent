import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { AgentId } from '../src/bridge/messages';

// Synthetic codeword only. Never send this project's code or conversation during smoke tests.
const provider = (process.env.TEST_PROVIDER ?? 'codex') as AgentId;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-resume-')));
const codeword = `RESUME-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const processes = new ProcessManager();
const startedAt = Date.now();
/** 測試建立的原生 Session 只屬於這個臨時工作區，結束後刪除，不動使用者其他紀錄。 */
async function cleanup() {
  await rm(join(homedir(), '.claude', 'projects', directory.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await stat(path)).mtimeMs >= startedAt && (await readFile(path, 'utf8')).includes(directory)) await rm(path);
    }
  };
  await walk(join(homedir(), '.codex', 'sessions'));
}
try {
  const sent: AgentRequest[] = [];
  const inner = provider === 'claude' ? new ClaudeCodeAdapter(processes, () => '', directory) : new CodexAppServerAdapter(processes, () => '', directory);
  const adapter: AgentAdapter = { id: inner.id, detect: () => inner.detect(), capabilities: () => inner.capabilities(), cancel: id => inner.cancel(id), execute: request => { sent.push(request); return inner.execute(request); } };
  const model = provider === 'claude' ? 'sonnet' : (await new CodexModelCatalog(processes, () => '', directory).list()).find(item => item.isDefault)?.id;
  assert.ok(model);
  const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, directory), directory, () => true, () => 180000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: [provider] }); await orchestrator.checkProviders();
  const first = await orchestrator.send(provider, `Remember this codeword: ${codeword}. Reply with exactly OK. Do not use tools.`, 'read-only', { model, effort: 'low' });
  const second = await orchestrator.send(provider, 'What codeword did I give you? Reply with only the codeword. Do not use tools.', 'read-only', { model, effort: 'low' });
  console.log(JSON.stringify({ provider, first: { status: first.status, persisted: first.persisted, error: first.error }, second: { status: second.status, contextMode: second.contextMode, output: second.output.slice(0, 80), error: second.error }, resumed: sent[1]?.resumeSessionId === first.sessionId }, null, 2));
  assert.equal(first.status, 'completed'); assert.equal(first.persisted, true);
  assert.equal(second.status, 'completed'); assert.equal(second.contextMode, 'native');
  assert.equal(sent[1]?.resumeSessionId, first.sessionId);
  assert.ok(!sent[1]!.prompt.includes(codeword), 'The resumed turn must not replay history.');
  assert.ok(second.output.includes(codeword), 'The native session should remember the codeword.');
  await orchestrator.dispose();
  console.log(`${provider}: native resume smoke PASS`);
} finally { await cleanup(); await rm(directory, { recursive: true, force: true }); }
