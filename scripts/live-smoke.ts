import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager } from '../src/execution/ProcessManager';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAdapter } from '../src/agents/CodexAdapter';

// Synthetic prompt only. Never send this project's code or conversation during smoke tests.
const directory = await mkdtemp(join(tmpdir(), 'multi-agent-live-'));
const processes = new ProcessManager();
try {
  for (const adapter of [new ClaudeCodeAdapter(processes, () => '', directory), new CodexAdapter(processes, () => '', directory)]) {
    const status = await adapter.detect();
    console.log(JSON.stringify({ provider: adapter.id, status: status.status, version: status.version, reason: status.reason }));
    if (status.status !== 'ready') { console.log(`${adapter.id}: SKIP live generation; official login or compatible CLI required.`); continue; }
    let text = '';
    const startedAt = Date.now();
    try {
      for await (const event of adapter.execute({ taskId: `smoke-${adapter.id}`, prompt: 'Reply with exactly MVP_OK. Do not use any tools, read any files, or access any project.', cwd: directory, mode: 'read-only', signal: new AbortController().signal, timeoutMs: 60000 })) {
        if (event.type === 'text-delta') text += event.text;
      }
      console.log(JSON.stringify({ provider: adapter.id, liveGeneration: text.includes('MVP_OK') ? 'PASS' : 'FAIL', elapsedMs: Date.now() - startedAt, output: text.slice(0, 120) }));
      if (!text.includes('MVP_OK')) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ provider: adapter.id, liveGeneration: 'FAIL', error: error instanceof Error ? error.message : 'Unknown error' })); process.exitCode = 1;
    }
  }
} finally { await rm(directory, { recursive: true, force: true }); }
