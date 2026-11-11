import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import type { ReasoningEffort } from '../src/bridge/settings';

const root = await mkdtemp(join(tmpdir(), 'multi-agent-models-'));
const processes = new ProcessManager();
try {
  const models = await new CodexModelCatalog(processes, () => '', root).list();
  const defaultModel = models.find(model => model.isDefault) ?? models[0];
  console.log(JSON.stringify({ discovery: 'PASS', models: models.length }));
  for (const adapter of [new CodexAppServerAdapter(processes, () => '', root), new ClaudeCodeAdapter(processes, () => '', root)]) {
    const status = await adapter.detect();
    if (status.status !== 'ready') { console.log(`${adapter.id}: SKIP (${status.status})`); continue; }
    const model = adapter.id === 'codex' ? defaultModel?.id : 'sonnet';
    const effort: ReasoningEffort = adapter.id === 'claude' ? 'medium' : defaultModel?.efforts.includes('medium') ? 'medium' : defaultModel?.efforts[0] ?? 'medium';
    let text = '';
    for await (const event of adapter.execute({ taskId: 'model-smoke', prompt: 'Reply with exactly MODEL_OK. Do not use tools or read files.', cwd: root, approvalMode: 'ask', mode: 'read-only', model, effort, signal: AbortSignal.timeout(60000), timeoutMs: 60000 })) if (event.type === 'text-delta') text += event.text;
    const passed = text.trim() === 'MODEL_OK';
    console.log(JSON.stringify({ provider: adapter.id, model, effort, generation: passed ? 'PASS' : 'FAIL' }));
    if (!passed) process.exitCode = 1;
  }
} finally { await processes.dispose(); await rm(root, { recursive: true, force: true }); }
