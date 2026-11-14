import type { AgentId, ExecutionMode, ProviderStatus, UsageSnapshot } from '../bridge/messages';
import type { ApprovalMode, ReasoningEffort } from '../bridge/settings';
import type { ApprovalRequest } from '../bridge/messages';
export interface AgentRequest {
  taskId: string; prompt: string; cwd: string; mode: ExecutionMode; timeoutMs: number; signal: AbortSignal;
  model?: string; effort?: ReasoningEffort;
  approvalMode?: ApprovalMode;
  /** persist：保留原生 Session 供下次接續；resumeSessionId：接續這個原生 Session。討論一律不保留。 */
  persist?: boolean; resumeSessionId?: string;
  /** 指定帳號時帶入該帳號的官方 CLI 設定目錄（CLAUDE_CONFIG_DIR／CODEX_HOME），未指定用 CLI 預設帳號。 */
  env?: Record<string, string>;
  approve?: (request: Omit<ApprovalRequest, 'id' | 'taskId' | 'provider'>) => Promise<boolean>;
}
export type AgentEvent =
  | { type: 'text-delta'; taskId: string; text: string }
  | { type: 'activity'; taskId: string; text: string }
  | { type: 'usage'; taskId: string; usage: UsageSnapshot }
  | { type: 'tool'; taskId: string; id: string; tool: string; phase: 'start' | 'end'; success?: boolean; input?: string; output?: string }
  | { type: 'complete'; taskId: string; sessionId?: string };
export interface AccountState { loggedIn: boolean; account?: ProviderStatus['account'] }
export interface AgentAdapter {
  readonly id: AgentId;
  /** 每個帳號各自的官方 CLI 設定目錄環境變數。 */
  readonly accountEnvKey?: string;
  /** 查詢某個帳號的登入狀態；只回傳公開身分欄位，不讀認證檔。 */
  account?(env?: Record<string, string>): Promise<AccountState>;
  /** 官方登入／登出命令，由使用者在終端機完成。 */
  authCommand?(action: 'login' | 'logout'): string[] | undefined;
  /** 不建立模型推論即可讀取的官方用量；不支援時不實作。 */
  usage?(env?: Record<string, string>): Promise<UsageSnapshot | undefined>;
  detect(): Promise<ProviderStatus>;
  capabilities(): ProviderStatus['capabilities'];
  execute(request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
