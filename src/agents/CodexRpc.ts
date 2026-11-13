import { ProcessManager, type ProcessRequest } from '../execution/ProcessManager';
import { providerFailure, record } from './CliAdapter';

/** One isolated official App Server, JSONL over stdin/stdout. Never reads auth files. */
export class CodexRpc {
  private send: (line: string) => void = () => { throw new Error('Codex 尚未連線。'); };
  constructor(private readonly processes: ProcessManager) {}
  request(id: number, method: string, params: unknown): void { this.write({ id, method, params }); }
  notify(method: string, params: unknown = {}): void { this.write({ method, params }); }
  respond(id: unknown, result: unknown): void { this.write({ id, result }); }
  reject(id: unknown): void { this.write({ id, error: { code: -32601, message: 'Unsupported client request' } }); }
  private write(message: unknown): void { this.send(JSON.stringify(message) + '\n'); }
  async *messages(options: Omit<ProcessRequest, 'args' | 'onStdinReady'> & { config?: string[] }) {
    for await (const event of this.processes.run({ ...options,
      args: ['app-server', '--listen', 'stdio://', ...['model_provider="openai"', 'mcp_servers={}', 'features.apps=false', 'features.plugins=false', 'features.hooks=false', 'analytics.enabled=false', ...(options.config ?? [])].flatMap(value => ['-c', value])],
      onStdinReady: send => { this.send = send; this.request(1, 'initialize', { clientInfo: { name: 'multi_agent_workspace', version: '0.1.4' }, capabilities: { experimentalApi: true } }); }
    })) {
      if (event.type === 'exit') throw event.code ? providerFailure(event.stderr, event.code) : new Error('Codex 在完成事件前結束。');
      let message: Record<string, unknown>;
      try { message = record(JSON.parse(event.text)); } catch { throw new Error('Codex 傳回無效 JSONL。'); }
      if (message.id === 1) {
        if (message.error) throw new Error('Codex App Server 初始化失敗，請更新官方 CLI。');
        this.notify('initialized');
      }
      yield message;
    }
  }
}
export async function readCodexAccount(processes: ProcessManager, command: string, cwd: string, env?: Record<string, string>) {
  const rpc = new CodexRpc(processes);
  for await (const message of rpc.messages({ command, cwd, timeoutMs: 15000, ...(env && { env: { ...process.env, ...env } }) })) {
    if (message.id === 1) rpc.request(2, 'account/read', { refreshToken: false });
    if (message.id !== 2) continue;
    if (message.error) throw new Error('無法查詢 Codex 帳號。');
    const account = record(record(message.result).account);
    if (!account.type) return undefined;
    // Whitelist public identity fields. Tokens and raw RPC payload never leave the adapter.
    return { type: String(account.type), email: typeof account.email === 'string' ? account.email : undefined, plan: typeof account.planType === 'string' ? account.planType : undefined };
  }
}
