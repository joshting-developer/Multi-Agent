import type { AgentId, ProviderStatus } from '../bridge/messages';
import { ProcessError, ProcessManager } from '../execution/ProcessManager';
import type { AgentAdapter, AgentEvent, AgentRequest } from './AgentAdapter';
import { resolveExecutable } from './ExecutableResolver';

/** 額度類失敗的結構化分類，討論流程依此決定能提供哪些選項，不比對中文訊息。 */
export type FailureKind = 'quota' | 'rate-limit';
export class ProviderFailure extends Error {
  constructor(message: string, readonly kind?: FailureKind) { super(message); }
}
const loginPattern = /not.?logged|not.?authenticated|login|log in|sign.?in|unauthorized|authentication|401|invalid.?api.?key/i;
export function failureKind(text: string): FailureKind | undefined {
  if (loginPattern.test(text)) return undefined;
  // 用量上限通常附「稍後再試」時間，仍屬帳號額度；只有明確的頻率限制才算暫時性。
  if (/quota|usage.limit|credit|budget|insufficient|billing/i.test(text)) return 'quota';
  if (/rate.?limit|too many requests|429|limit.reached|overloaded/i.test(text)) return 'rate-limit';
  return undefined;
}
export function providerFailure(text: string, code?: number): ProviderFailure {
  return new ProviderFailure(friendlyFailure(text, code), failureKind(text));
}
export function friendlyFailure(text: string, code?: number): string {
  if (loginPattern.test(text)) return '官方 CLI 尚未登入或登入已失效。請在終端完成官方登入，再按 Check connection。';
  const kind = failureKind(text);
  if (kind === 'quota') return 'Provider 額度已用完。請檢查官方帳號額度，或改用其他 Provider。';
  if (kind === 'rate-limit') return 'Provider 請求頻率受限。請稍後重試。';
  if (/network|connection|dns|fetch failed|timed out|stream disconnected/i.test(text)) return '無法連線到 Provider。請檢查網路、Proxy 與官方服務狀態。';
  if (/model.*(?:not found|does not exist|not supported|not available)|unsupported.*model|invalid.*model|reasoning.effort.*(?:unsupported|not supported)/i.test(text)) return '此模型或推理強度不適用於目前帳號。請在設定重新選擇模型與強度。';
  if (/unknown|unexpected|unrecognized|unsupported|invalid.*(argument|config|permission)|configuration.*error|loading config|FilesystemPermissionToml/i.test(text)) return 'CLI 參數或安全設定不相容。請更新官方 CLI，並重新檢查連線。';
  return `CLI 執行失敗${code === undefined ? '' : `（exit ${code}）`}。請在終端檢查官方 CLI、帳號及管理政策。`;
}

export abstract class CliAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  protected command?: string;
  protected detected?: ProviderStatus;
  protected help = '';
  private readonly active = new Map<string, AbortController>();
  constructor(protected readonly processes: ProcessManager, private readonly path: () => string, protected readonly detectionCwd: string) {}
  capabilities(): ProviderStatus['capabilities'] {
    return this.detected?.capabilities ?? { streaming: false, readOnly: false, workspaceWrite: false, resumeSession: false, toolApproval: false, structuredOutput: false };
  }
  protected abstract inspect(command: string): Promise<ProviderStatus>;
  protected probe(command: string, args: string[]) {
    return this.processes.collect({ command, args, cwd: this.detectionCwd, timeoutMs: 12000 });
  }
  async detect(): Promise<ProviderStatus> {
    try {
      this.command = await resolveExecutable(this.id, this.path());
      this.detected = this.command ? await this.inspect(this.command) : { id: this.id, status: 'not-installed', reason: '找不到官方 CLI，請安裝或指定絕對路徑。', capabilities: this.capabilities() };
    } catch (error) {
      this.detected = { id: this.id, status: 'error', reason: error instanceof ProcessError ? error.message : 'CLI 偵測失敗。請檢查執行檔路徑。', capabilities: this.capabilities() };
    }
    return this.detected;
  }
  protected abstract arguments(request: AgentRequest): string[];
  protected abstract parse(line: Record<string, unknown>, state: StreamState): Omit<AgentEvent, 'taskId'>[];

  protected inputStream(_request: AgentRequest): ((send: (value: string) => void) => void) | undefined { void _request; return undefined; }
  protected async handleControl(_line: Record<string, unknown>, _request: AgentRequest, _send: (value: string) => void): Promise<boolean> { void _line; void _request; void _send; return false; }

  async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const status = this.detected ?? await this.detect();
    if (!this.command || status.status !== 'ready') throw new Error(status.reason ?? 'Provider 尚未準備完成。');
    if (!this.capabilities().readOnly || (request.mode === 'workspace-write' && !this.capabilities().workspaceWrite)) throw new Error('此 CLI 版本無法強制所選權限，任務未執行。');
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    this.active.set(request.taskId, controller);
    const state: StreamState = { text: '', itemText: new Map(), completed: false, emitted: false };
    let send: (value: string) => void = () => undefined;
    const inputStream = this.inputStream(request);
    try {
      for await (const event of this.processes.run({
        command: this.command, args: this.arguments(request), cwd: request.cwd, input: request.prompt,
        timeoutMs: request.timeoutMs, signal: controller.signal,
        onStdinReady: inputStream ? write => { send = write; inputStream(write); } : undefined
      })) {
        if (event.type === 'exit') {
          if (event.code !== 0) throw providerFailure(event.stderr, event.code);
          if (!state.completed) throw new Error('CLI 在完成事件前結束，請更新 CLI 或重新執行。');
        } else if (event.text.trim()) {
          let value: unknown;
          try { value = JSON.parse(event.text); } catch { throw new Error('CLI 傳回無效的 JSONL，已停止任務。請更新 CLI。'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          if (await this.handleControl(value as Record<string, unknown>, request, send)) continue;
          for (const converted of this.parse(value as Record<string, unknown>, state)) {
            yield { ...converted, taskId: request.taskId } as AgentEvent;
          }
          if (inputStream && state.completed) break;
        }
      }
      yield { type: 'complete', taskId: request.taskId, sessionId: state.sessionId };
    } finally {
      request.signal.removeEventListener('abort', abort);
      this.active.delete(request.taskId);
    }
  }
  async cancel(taskId: string): Promise<void> { this.active.get(taskId)?.abort(); }
}
export interface StreamState {
  text: string; itemText: Map<string, string>; completed: boolean; emitted: boolean; sessionId?: string; tools?: Map<string, string>;
}
export type ParsedEvent = { type: 'text-delta'; text: string } | { type: 'activity'; text: string } | { type: 'tool'; id: string; tool: string; phase: 'start' | 'end'; success?: boolean; input?: string; output?: string };
/** 工具輸入／結果轉成可讀文字；遮罩與截斷由 Orchestrator 統一處理。 */
export function toolText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value.slice(0, 20000);
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : String(record(item).text ?? JSON.stringify(item))).join('\n').slice(0, 20000);
  return JSON.stringify(value, null, 2).slice(0, 20000);
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
