import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class ProcessError extends Error {
  constructor(message: string, readonly kind: 'spawn' | 'exit' | 'cancelled' | 'timeout' | 'output-limit', readonly exitCode?: number) { super(message); }
}
export interface ProcessRequest {
  command: string; args: string[]; cwd: string; input?: string; signal?: AbortSignal; timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onStdinReady?: (send: (value: string) => void) => void;
}
export type ProcessEvent = { type: 'line'; text: string } | { type: 'exit'; code: number; stderr: string };

/** No shell; bounded output queue; each invocation owns a process group on macOS/Linux. */
export class ProcessManager {
  private readonly active = new Set<{ stop: (reason: ProcessError) => void; closed: Promise<void> }>();
  async dispose(): Promise<void> {
    const active = [...this.active];
    for (const run of active) run.stop(new ProcessError('Extension 已關閉，程序已取消。', 'cancelled'));
    await Promise.all(active.map(run => run.closed));
  }
  async *run(request: ProcessRequest): AsyncGenerator<ProcessEvent> {
    if (request.signal?.aborted) throw new ProcessError('任務已取消。', 'cancelled');
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: request.env ?? process.env
    });
    const queue: string[] = [];
    let queueBytes = 0, pending = '', stderr = '', done = false, code = -1;
    let failure: ProcessError | undefined;
    let wake: (() => void) | undefined;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder('utf8');
    const notify = () => { wake?.(); wake = undefined; };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
          killer.on('error', () => child.kill(signal));
        } else process.kill(-child.pid, signal);
      } catch { /* Process group already exited. */ }
    };
    const stop = (reason: ProcessError) => {
      if (failure || done) return;
      failure = reason;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 500);
      notify();
    };
    const lifecycle = { stop, closed };
    this.active.add(lifecycle);
    const enqueue = (line: string) => {
      queueBytes += line.length;
      if (queueBytes > 4 * 1024 * 1024) { stop(new ProcessError('CLI 輸出過快，已停止以保護記憶體。', 'output-limit')); return; }
      queue.push(line); notify();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let index: number;
      while ((index = pending.indexOf('\n')) >= 0) {
        enqueue(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
      }
      if (pending.length > 1024 * 1024) stop(new ProcessError('CLI 單行輸出超過 1 MB。', 'output-limit'));
    });
    const errDecoder = new StringDecoder('utf8');
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + errDecoder.write(chunk)).slice(-8192); });
    child.on('error', error => { failure = new ProcessError(`無法啟動 CLI：${error.message}`, 'spawn'); done = true; notify(); });
    child.on('close', exitCode => {
      pending += decoder.end();
      if (pending) enqueue(pending);
      code = exitCode ?? -1; done = true;
      // Kill remaining members even when the leader exits before its descendants.
      kill('SIGKILL'); notify();
      resolveClosed();
    });
    child.stdin.on('error', () => { /* EPIPE is reported through the process exit. */ });
    const abort = () => stop(new ProcessError('任務已取消。', 'cancelled'));
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const timeout = setTimeout(() => stop(new ProcessError('任務逾時，已終止 CLI。可在設定增加時間限制。', 'timeout')), request.timeoutMs);
    try {
      if (request.onStdinReady) request.onStdinReady(value => { child.stdin.write(value); });
      else child.stdin.end(request.input ?? '');
      while (!done || queue.length) {
        if (queue.length) {
          const text = queue.shift()!; queueBytes -= text.length;
          yield { type: 'line', text };
        } else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
      yield { type: 'exit', code, stderr };
    } finally {
      clearTimeout(timeout); if (escalation) clearTimeout(escalation);
      request.signal?.removeEventListener('abort', abort);
      kill('SIGKILL');
      await closed;
      this.active.delete(lifecycle);
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  }

  async collect(request: ProcessRequest): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = '', stderr = '', code = -1;
    for await (const event of this.run(request)) {
      if (event.type === 'line') {
        stdout += event.text + '\n';
        if (stdout.length > 1024 * 1024) throw new ProcessError('CLI 偵測輸出過大。', 'output-limit');
      } else { stderr = event.stderr; code = event.code; }
    }
    return { stdout, stderr, code };
  }
}
