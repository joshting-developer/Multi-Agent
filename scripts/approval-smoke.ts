import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
const root = await mkdtemp(join(tmpdir(), 'multi-agent-approvals-'));
const cwd = join(root, 'workspace'); await mkdir(cwd); await mkdir(join(root, 'outside'));
const processes = new ProcessManager();
try {
  const models = await new CodexModelCatalog(processes, () => '', cwd).list();
  const model = models.find(item => item.isDefault) ?? models[0]!;
  for (const adapter of [new CodexAppServerAdapter(processes, () => '', cwd), new ClaudeCodeAdapter(processes, () => '', cwd)]) {
    if (process.env.TEST_PROVIDER && adapter.id !== process.env.TEST_PROVIDER) continue;
    const status = await adapter.detect(); assert.equal(status.status, 'ready');
    console.log(JSON.stringify({ provider: adapter.id, accountMetadata: !!status.account, emailProvided: !!status.account?.email }));
    for (const approvalMode of ['ask', 'auto-review', 'full-access'] as const) {
      if (process.env.TEST_APPROVAL && approvalMode !== process.env.TEST_APPROVAL) continue;
      const filename = join(adapter.id === 'codex' && approvalMode !== 'full-access' ? join(root, 'outside') : cwd, `${adapter.id}-${approvalMode}.txt`);
      let approvals = 0, reviews = 0, output = '';
      const request = { taskId: `${adapter.id}-${approvalMode}`, cwd, mode: 'workspace-write' as const, approvalMode,
        model: adapter.id === 'codex' ? model.id : 'sonnet', effort: 'medium' as const, timeoutMs: 90000, signal: AbortSignal.timeout(90000),
        prompt: `This is an authorized synthetic integration test in a temporary directory. Create exactly ${filename} containing APPROVAL_OK. Use only local file tools or a local command for this specific write. Do not read other files or use network. If the sandbox denies the write, request approval for this exact operation. Then reply APPROVAL_OK.`,
        approve: async (request: { title: string; detail: string }) => { approvals++; return request.detail.includes(filename); }
      };
      for await (const event of adapter.execute(request)) {
        if (event.type === 'text-delta') output += event.text;
        if (event.type === 'activity' && /審查/.test(event.text)) reviews++;
      }
      console.log(JSON.stringify({ provider: adapter.id, approvalMode, approvals, reviews, syntheticResponse: output }));
      assert.equal((await readFile(filename, 'utf8')).trim(), 'APPROVAL_OK', `${adapter.id} ${approvalMode} must write the synthetic file`);
      if (approvalMode === 'ask') assert.ok(approvals > 0, `${adapter.id} must round-trip human approval`);
      if (adapter.id === 'codex' && approvalMode === 'auto-review') assert.ok(reviews > 0, 'Codex must emit native auto-review events');
      console.log(JSON.stringify({ provider: adapter.id, approvalMode, approvals, reviews, write: 'PASS', response: output.includes('APPROVAL_OK') ? 'PASS' : 'CHECK' }));
    }
  }
} finally { await processes.dispose(); await rm(root, { recursive: true, force: true }); }
