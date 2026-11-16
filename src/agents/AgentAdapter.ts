import type { AgentId, ExecutionMode, ProviderStatus, ResetCreditOutcome, UsageSnapshot, AgentFeature } from '../bridge/messages';
import type { ApprovalMode, ReasoningEffort } from '../bridge/settings';
import type { ApprovalRequest } from '../bridge/messages';
export interface AgentRequest {
  taskId: string; prompt: string; cwd: string; mode: ExecutionMode; timeoutMs: number; signal: AbortSignal;
  model?: string; effort?: ReasoningEffort;
  approvalMode?: ApprovalMode;
  /** persist：保留原生 Session 供下次接續；resumeSessionId：接續這個原生 Session。討論一律不保留。 */
  persist?: boolean; resumeSessionId?: string;
  /** 帶入帳號自己的官方 CLI 設定目錄（CLAUDE_CONFIG_DIR／CODEX_HOME）；Extension 一律指定帳號，不用 CLI 預設目錄。 */
  env?: Record<string, string>;
  /** 使用者貼上的圖片內容（base64），以各 Provider 官方的多模態輸入格式傳送。 */
  images?: Array<{ mime: string; data: string }>;
  /** 工作區外允許唯讀的資料夾（使用者在工作區授權中加入的 realpath）。 */
  readRoots?: string[];
  /** 工作區允許連網時為 true；沙盒內的命令才能連網，並開放網頁搜尋與讀取網頁工具。 */
  network?: boolean;
  /** 工作區另外開放的功能（外掛、MCP、子 Agent…）；沒有時全部關閉。 */
  features?: AgentFeature[];
  approve?: (request: Omit<ApprovalRequest, 'id' | 'taskId' | 'provider'>) => Promise<boolean>;
}
export type AgentEvent =
  | { type: 'text-delta'; taskId: string; text: string }
  | { type: 'activity'; taskId: string; text: string }
  | { type: 'usage'; taskId: string; usage: UsageSnapshot }
  | { type: 'tool'; taskId: string; id: string; tool: string; phase: 'start' | 'end'; success?: boolean; input?: string; output?: string; cwd?: string; exitCode?: number }
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
  /** 使用一張官方額度重置券；不支援時不實作。 */
  consumeResetCredit?(env?: Record<string, string>, creditId?: string): Promise<ResetCreditOutcome>;
  /** 以 API Key 登入：官方 CLI 有對應命令時由它保存（Codex）；否則以這個環境變數在執行時提供（Claude）。 */
  apiKeyLogin?(key: string, env: Record<string, string>): Promise<void>;
  readonly apiKeyEnvVar?: string;
  detect(): Promise<ProviderStatus>;
  capabilities(): ProviderStatus['capabilities'];
  execute(request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
  /** 把補充訊息送進執行中的任務；只有官方支援時才提供。 */
  steer?(taskId: string, text: string): Promise<void>;
}
