import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { removeSmokeSessions } from './smoke-cleanup';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { AgentId } from '../src/bridge/messages';

// Synthetic file only. Never send this project's code or conversation during smoke tests.
const provider = (process.env.TEST_PROVIDER ?? 'codex') as AgentId;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-tools-')));
const startedAt = Date.now();
const processes = new ProcessManager();
try {
  await writeFile(join(directory, 'notes.txt'), 'synthetic value: 4217\n');
  const adapter = provider === 'claude' ? new ClaudeCodeAdapter(processes, () => '', directory) : new CodexAppServerAdapter(processes, () => '', directory);
  const model = provider === 'claude' ? 'sonnet' : (await new CodexModelCatalog(processes, () => '', directory).list()).find(item => item.isDefault)?.id;
  assert.ok(model, 'No model available.');
  const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, directory), directory, () => true, () => 180000);
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: [provider] }); await orchestrator.checkProviders();
  const task = await orchestrator.send(provider, 'Read the file notes.txt in the current directory with a tool, then reply with only the number it contains.', 'read-only', { model, effort: 'low' });
  console.log(JSON.stringify({ provider, status: task.status, error: task.error, steps: task.steps?.map(step => step.kind === 'tool' ? { tool: step.name, status: step.status, input: step.input?.slice(0, 120), output: step.output?.slice(0, 120) } : { text: step.text.slice(0, 120) }) }, null, 2));
  assert.equal(task.status, 'completed');
  const tools = task.steps?.filter(step => step.kind === 'tool') ?? [];
  assert.ok(tools.length > 0, 'Expected at least one tool step.');
  assert.ok(tools.every(step => step.status === 'done' || step.status === 'failed'), 'No tool should stay running.');
  assert.equal(task.steps!.at(-1)!.kind, 'text', 'The final answer should come after the tools.');
  assert.ok(task.output.includes('4217'));
  await orchestrator.dispose();
  console.log(`${provider}: tool timeline smoke PASS`);
} finally { await removeSmokeSessions(directory, startedAt); await rm(directory, { recursive: true, force: true }); }
