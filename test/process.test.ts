import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { mkdtemp, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
const fixture = resolve('test/fixtures/agent.cjs');
const manager = new ProcessManager();
const request = (scenario: string, extra: Partial<ProcessRequest> = {}): ProcessRequest => ({ command: process.execPath, args: [fixture, 'codex', scenario], cwd: process.cwd(), timeoutMs: 3000, ...extra });

describe('ProcessManager', () => {
  it('preserves split UTF-8 and unterminated JSON lines', async () => {
    expect((await manager.collect(request('utf8'))).stdout).toBe('你好\n');
    expect((await manager.collect(request('partial'))).stdout).toBe('{"type":"turn.completed"}\n');
  });
  it('passes prompts via stdin and arguments literally without a shell', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'multi-agent-test-'));
    try {
      const marker = resolve(directory, 'injected');
      const injection = `$(touch ${marker}); echo hacked`;
      const result = await manager.collect(request('arguments', { args: [fixture, 'codex', 'arguments', injection], input: injection, cwd: directory }));
      const output = JSON.parse(result.stdout) as { args: string[]; text: string; cwd: string };
      expect(output.args).toEqual([injection]); expect(output.text).toBe(injection); expect(output.cwd).toBe(await realpath(directory));
      await expect(access(marker)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reports spawn errors and nonzero exit codes', async () => {
    await expect(manager.collect(request('ok', { command: '/nonexistent/multi-agent' }))).rejects.toMatchObject({ kind: 'spawn' });
    expect((await manager.collect(request('exit'))).code).toBe(7);
  });
  it('enforces timeout even when SIGTERM is ignored', async () => {
    await expect(manager.collect(request('timeout', { timeoutMs: 100 }))).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('cancels idempotently and kills descendants', async () => {
    const controller = new AbortController();
    let descendant = 0;
    const execution = (async () => {
      for await (const event of manager.run(request('tree', { signal: controller.signal }))) {
        if (event.type === 'line') { descendant = Number(event.text); controller.abort(); controller.abort(); }
      }
    })();
    await expect(execution).rejects.toMatchObject({ kind: 'cancelled' });
    if (process.platform !== 'win32') expect(() => process.kill(descendant, 0)).toThrow();
  });
  it('does not spawn when already cancelled', async () => {
    await expect(manager.collect(request('ok', { signal: AbortSignal.abort() }))).rejects.toMatchObject({ kind: 'cancelled' });
  });
  it('disposes running detection processes and awaits their closure', async () => {
    const detector = new ProcessManager();
    const execution = detector.collect(request('tree'));
    // Wait for stdout to prove the process started, then dispose the manager.
    const promise = execution.catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 100));
    await detector.dispose();
    expect(await promise).toMatchObject({ kind: 'cancelled' });
  });
});
