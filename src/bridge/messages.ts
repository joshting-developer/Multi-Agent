import { z } from 'zod';
import type { AccountPreferences } from './preferences';
import { effortSchema, modelIdSchema, providerPreferencesSchema, settingsSchema, approvalModes, type ModelCatalog, type WorkspaceSettings } from './settings';

export const agentIdSchema = z.enum(['claude', 'codex']);
export type AgentId = z.infer<typeof agentIdSchema>;
export const modeSchema = z.enum(['read-only', 'workspace-write']);
export type ExecutionMode = z.infer<typeof modeSchema>;
export const participantRoleSchema = z.enum(['architect', 'critic', 'summarizer']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
/** 稽核事件只存種類與簡短說明（工具名稱、核准標題、Provider），不存命令內容、檔案差異或認證資料。 */
export const auditKinds = ['tool-start', 'tool-end', 'tool-failed', 'approval-requested', 'approval-allowed', 'approval-denied', 'cancelled', 'data-outbound', 'policy-changed', 'full-access-granted', 'session-rebuilt'] as const;
export const auditEventSchema = z.object({ at: z.number(), kind: z.enum(auditKinds), detail: z.string().max(200) });
export type AuditEvent = z.infer<typeof auditEventSchema>;
/** 執行過程依實際順序保存：Agent 文字與工具交錯；工具 IN／OUT 已遮罩並截斷。 */
export const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('tool'), id: z.string(), name: z.string(), status: z.enum(['running', 'done', 'failed', 'stopped']), input: z.string().optional(), output: z.string().optional() })
]);
export type Step = z.infer<typeof stepSchema>;
export const taskSchema = z.object({
  id: z.string(), provider: agentIdSchema, mode: modeSchema, prompt: z.string(), output: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.number(), endedAt: z.number().optional(), error: z.string().optional(),
  activity: z.string().optional(), sessionId: z.string().optional(), participantId: z.string().optional(), participantRole: participantRoleSchema.optional(),
  discussionId: z.string().optional(), roundNo: z.number().int().positive().optional(),
  model: modelIdSchema.optional(), effort: z.union([effortSchema, z.literal('default')]).optional().transform(value => value === 'default' ? undefined : value).optional(),
  approvalMode: z.enum(approvalModes).optional(),
  failureKind: z.enum(['quota', 'rate-limit']).optional(), substitute: z.boolean().optional(),
  rejected: z.boolean().optional(), contextIds: z.array(z.string()).optional(),
  attachments: z.array(z.object({ id: z.string(), mime: z.string(), bytes: z.number() })).optional(), events: z.array(auditEventSchema).optional(), steps: z.array(stepSchema).optional(),
  /** native：接續官方原生 Session；rebuilt：由 SQLite 上下文重建。persisted：這次的原生 Session 有保留，可供下次接續。 */
  contextMode: z.enum(['native', 'rebuilt']).optional(), persisted: z.boolean().optional(), accountId: z.string().optional(),
  /** 混合任務的一次執行：stage 為規劃、環節、review 或結論；text 只在第一則帶使用者的原始要求。 */
  hybrid: z.object({ id: z.string(), stage: z.enum(['plan', 'step', 'review', 'conclusion']), index: z.number().int().positive().optional(), title: z.string().max(200).optional(), member: z.string().max(200), text: z.string().optional() }).optional()
});
export type Task = z.infer<typeof taskSchema>;
export type Classification = 'unclassified' | 'personal' | 'company' | 'restricted';
/** readRoots：使用者允許 Agent 唯讀的工作區外資料夾（realpath）。 */
/** 工作區可另外開放的 Agent 功能（MA-140）；沒列在 features 裡的一律關閉。 */
export const agentFeatures = ['apps', 'mcp', 'subagents', 'browser', 'memory', 'hooks', 'commands'] as const;
export type AgentFeature = typeof agentFeatures[number];
/** network：允許 Agent 的命令連網、使用網頁搜尋與讀取網頁；預設關閉（MA-135）。features：另外開放的 Agent 功能。 */
export interface WorkspacePolicy { classification: Classification; allowedProviders: AgentId[]; readRoots?: string[]; network?: boolean; features?: AgentFeature[] }
export interface ProviderStatus {
  id: AgentId;
  status: 'not-installed' | 'installed' | 'authenticated' | 'ready' | 'error' | 'unknown';
  version?: string; reason?: string;
  account?: { type: string; email?: string; plan?: string; organization?: string; detail?: string };
  approvalModes?: Array<typeof approvalModes[number]>;
  capabilities: { streaming: boolean; readOnly: boolean; workspaceWrite: boolean; resumeSession: boolean; toolApproval: boolean; structuredOutput: boolean; steer?: boolean };
}
export interface Snapshot {
  workspace: string; policy: WorkspacePolicy; providers: ProviderStatus[]; tasks: Task[];
  activeTaskId?: string; activeConversationId?: string; discussionId?: string; discussion?: DiscussionSummary; hybrid?: HybridSummary; checking: boolean; trusted: boolean;
  settings?: WorkspaceSettings; models?: ModelCatalog;
  conversations?: ConversationSummary[]; conversationId?: string; approvals?: ApprovalRequest[];
  accounts?: AccountSummary[]; selectedAccounts?: Partial<Record<AgentId, string>>; persistent?: boolean;
  /** 目前對話還有更早的訊息未載入；externalChanges：其他視窗寫入、本視窗尚未載入的執行數。 */
  hasEarlier?: boolean; externalChanges?: number;
}
/** 規格 §7：討論最多 8 輪，超出不可延長。 */
export const maxDiscussionRounds = 8;
export interface DiscussionBlock { kind: 'quota' | 'rate-limit'; provider: AgentId; roundNo: number }
export interface DiscussionSummary { id: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; completedRounds: number; maxRounds: number; summaryTaskId?: string; blocked?: DiscussionBlock }
/** 混合任務的進度：members 的 left 是離開的環節與原因；steps 的 member 是實際執行（或預定）的成員索引。 */
export interface HybridSummary {
  id: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; stage: 'plan' | 'step' | 'review' | 'conclusion';
  members: Array<{ label: string; provider: AgentId; lead?: boolean; left?: string }>;
  steps: Array<{ title: string; member: number; status: 'pending' | 'running' | 'done' | 'failed' }>;
}
export interface SearchFilters { provider?: AgentId; mode?: 'solo' | 'discussion'; since?: number; until?: number }
/** 搜尋命中的那一次執行：實際來源與時間，供結果顯示與跳到原始訊息。 */
export interface SearchMatch { runId: string; messageId?: string; at: number; provider: AgentId; discussion: boolean }
export interface ConversationSummary { id: string; title: string; createdAt: number; updatedAt: number; provider?: AgentId; preview?: string; activity?: 'running' | 'queued' | 'waiting'; match?: SearchMatch }
/** 官方提供的額度時間窗；usedPercent 0–100，resetsAt 為毫秒時間戳。沒有來源的欄位不填。 */
export interface UsageWindow { label: string; usedPercent: number; resetsAt?: number }
/** source：official 為即時查詢；last-run 為最近一次實際執行時官方回報的值。 */
/** 一張可用的額度重置券；時間為毫秒時間戳，標題由官方提供。 */
export interface ResetCredit { id: string; title?: string; grantedAt?: number; expiresAt?: number }
/** resetCredits：官方回報的可用額度重置券張數（目前只有 Codex）；resetCreditList：官方有給明細時的每一張，依到期時間排序。 */
export interface UsageSnapshot { windows: UsageWindow[]; updatedAt: number; source: 'official' | 'last-run'; blocked?: boolean; resetCredits?: number; resetCreditList?: ResetCredit[] }
/** 官方 account/rateLimitResetCredit/consume 的結果。 */
export type ResetCreditOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export interface AccountSummary { id: string; provider: AgentId; name: string; method?: 'cli' | 'api-key'; loggedIn?: boolean; account?: ProviderStatus['account']; usage?: UsageSnapshot; preferences?: AccountPreferences }
export interface ApprovalRequest { id: string; taskId: string; provider: AgentId; title: string; detail: string; conversationId?: string }
const base = { version: z.literal(1), requestId: z.string().min(1).max(100) };
export const webviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready') }),
  z.object({ ...base, type: z.literal('send-message'), provider: agentIdSchema, text: z.string().trim().max(32000), mode: modeSchema, preferences: providerPreferencesSchema.optional(), approvalMode: z.enum(approvalModes).optional(),
    attachments: z.array(z.object({ mime: z.string().max(40), data: z.string().max(7_000_000) })).max(4).optional() }),
  z.object({ ...base, type: z.literal('start-discussion'), provider: agentIdSchema, partner: agentIdSchema.optional(), text: z.string().trim().min(1).max(32000), rounds: z.number().int().min(2).max(8), preferences: providerPreferencesSchema.optional(), partnerPreferences: providerPreferencesSchema.optional(), partnerAccountId: z.string().max(100).optional() }),
  z.object({ ...base, type: z.literal('start-hybrid'), text: z.string().trim().min(1).max(32000), mode: modeSchema, approvalMode: z.enum(approvalModes).optional(), lead: z.number().int().min(0).max(3),
    members: z.array(z.object({ provider: agentIdSchema, preferences: providerPreferencesSchema, approvalMode: z.enum(approvalModes).optional() })).min(2).max(4) }),
  z.object({ ...base, type: z.literal('extend-discussion'), discussionId: z.string().min(1).max(100), rounds: z.number().int().min(1).max(6) }),
  z.object({ ...base, type: z.literal('add-account'), provider: agentIdSchema, name: z.string().trim().max(60).optional(), apiKey: z.string().max(400).optional() }),
  z.object({ ...base, type: z.literal('rename-account'), accountId: z.string().min(1).max(100), name: z.string().trim().min(1).max(60) }),
  z.object({ ...base, type: z.literal('remove-account'), accountId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('account-terminal'), accountId: z.string().min(1).max(100), action: z.enum(['login', 'logout']) }),
  z.object({ ...base, type: z.literal('add-read-root') }),
  z.object({ ...base, type: z.literal('remove-read-root'), path: z.string().min(1).max(4096) }),
  z.object({ ...base, type: z.literal('set-network'), enabled: z.boolean() }),
  z.object({ ...base, type: z.literal('set-agent-feature'), feature: z.enum(agentFeatures), enabled: z.boolean() }),
  z.object({ ...base, type: z.literal('use-reset-credit'), accountId: z.string().min(1).max(100), creditId: z.string().min(1).max(200).optional() }),
  z.object({ ...base, type: z.literal('select-account'), provider: agentIdSchema, accountId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('set-account-preferences'), accountId: z.string().min(1).max(100), preferences: z.object({ model: modelIdSchema, effort: effortSchema, approvalMode: z.enum(approvalModes) }) }),
  z.object({ ...base, type: z.literal('check-accounts') }),
  z.object({ ...base, type: z.literal('export-conversation'), format: z.enum(['json', 'markdown']) }),
  z.object({ ...base, type: z.literal('backup-history') }),
  z.object({ ...base, type: z.literal('set-persistence'), enabled: z.boolean() }),
  z.object({ ...base, type: z.literal('clear-project') }),
  z.object({ ...base, type: z.literal('load-earlier') }),
  z.object({ ...base, type: z.literal('restore-history') }),
  z.object({ ...base, type: z.literal('resolve-discussion'), discussionId: z.string().min(1).max(100), decision: z.enum(['retry', 'substitute', 'end']), provider: agentIdSchema.optional() }),
  z.object({ ...base, type: z.literal('reject-answer'), taskId: z.string().min(1).max(100), rejected: z.boolean() }),
  z.object({ ...base, type: z.literal('answer-approval'), approvalId: z.string().min(1).max(100), allow: z.boolean() }),
  z.object({ ...base, type: z.literal('new-conversation') }),
  z.object({ ...base, type: z.literal('open-conversation'), conversationId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('search-conversations'), query: z.string().max(500), filters: z.object({ provider: agentIdSchema.optional(), mode: z.enum(['solo', 'discussion']).optional(), since: z.number().int().nonnegative().optional(), until: z.number().int().nonnegative().optional() }).optional() }),
  z.object({ ...base, type: z.literal('rename-conversation'), conversationId: z.string().min(1).max(100), title: z.string().trim().min(1).max(120) }),
  z.object({ ...base, type: z.literal('delete-conversation'), conversationId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('cancel-task'), taskId: z.string().max(100) }),
  z.object({ ...base, type: z.literal('steer-task'), taskId: z.string().max(100), text: z.string().trim().min(1).max(32000) }),
  z.object({ ...base, type: z.literal('check-providers') }),
  z.object({ ...base, type: z.literal('authorize-workspace') }),
  z.object({ ...base, type: z.literal('clear-conversation') }),
  z.object({ ...base, type: z.literal('open-settings') }),
  z.object({ ...base, type: z.literal('show-options') }),
  z.object({ ...base, type: z.literal('save-settings'), settings: settingsSchema }),
  z.object({ ...base, type: z.literal('set-provider-preferences'), provider: agentIdSchema, preferences: providerPreferencesSchema }),
  z.object({ ...base, type: z.literal('refresh-models') })
]);
export type WebviewToHost = z.infer<typeof webviewMessageSchema>;
export type HostToWebview =
  | { version: 1; type: 'conversation-results'; requestId: string; conversations: ConversationSummary[] }
  | { version: 1; type: 'snapshot'; snapshot: Snapshot }
  | { version: 1; type: 'request-settled'; requestId: string }
  | { version: 1; type: 'show-history' }
  | { version: 1; type: 'request-accepted'; requestId: string }
  | { version: 1; type: 'settings-saved'; requestId: string }
  | { version: 1; type: 'error'; requestId?: string; message: string };
