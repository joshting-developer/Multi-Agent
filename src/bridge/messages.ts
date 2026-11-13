import { z } from 'zod';
import { effortSchema, modelIdSchema, providerPreferencesSchema, settingsSchema, approvalModes, type ModelCatalog, type WorkspaceSettings } from './settings';

export const agentIdSchema = z.enum(['claude', 'codex']);
export type AgentId = z.infer<typeof agentIdSchema>;
export const modeSchema = z.enum(['read-only', 'workspace-write']);
export type ExecutionMode = z.infer<typeof modeSchema>;
export const participantRoleSchema = z.enum(['architect', 'critic', 'summarizer']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
/** 稽核事件只存種類與簡短說明（工具名稱、核准標題、Provider），不存命令內容、檔案差異或認證資料。 */
export const auditKinds = ['tool-start', 'tool-end', 'tool-failed', 'approval-requested', 'approval-allowed', 'approval-denied', 'cancelled', 'data-outbound', 'policy-changed', 'full-access-granted'] as const;
export const auditEventSchema = z.object({ at: z.number(), kind: z.enum(auditKinds), detail: z.string().max(200) });
export type AuditEvent = z.infer<typeof auditEventSchema>;
export const taskSchema = z.object({
  id: z.string(), provider: agentIdSchema, mode: modeSchema, prompt: z.string(), output: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.number(), endedAt: z.number().optional(), error: z.string().optional(),
  activity: z.string().optional(), sessionId: z.string().optional(), participantId: z.string().optional(), participantRole: participantRoleSchema.optional(),
  discussionId: z.string().optional(), roundNo: z.number().int().positive().optional(),
  model: modelIdSchema.optional(), effort: z.union([effortSchema, z.literal('default')]).optional().transform(value => value === 'default' ? undefined : value).optional(),
  approvalMode: z.enum(approvalModes).optional(),
  failureKind: z.enum(['quota', 'rate-limit']).optional(), substitute: z.boolean().optional(),
  rejected: z.boolean().optional(), contextIds: z.array(z.string()).optional(), events: z.array(auditEventSchema).optional()
});
export type Task = z.infer<typeof taskSchema>;
export type Classification = 'unclassified' | 'personal' | 'company' | 'restricted';
export interface WorkspacePolicy { classification: Classification; allowedProviders: AgentId[] }
export interface ProviderStatus {
  id: AgentId;
  status: 'not-installed' | 'installed' | 'authenticated' | 'ready' | 'error' | 'unknown';
  version?: string; reason?: string;
  account?: { type: string; email?: string; plan?: string; organization?: string; detail?: string };
  approvalModes?: Array<typeof approvalModes[number]>;
  capabilities: { streaming: boolean; readOnly: boolean; workspaceWrite: boolean; resumeSession: boolean; toolApproval: boolean; structuredOutput: boolean };
}
export interface Snapshot {
  workspace: string; policy: WorkspacePolicy; providers: ProviderStatus[]; tasks: Task[];
  activeTaskId?: string; discussionId?: string; discussion?: DiscussionSummary; checking: boolean; trusted: boolean;
  settings?: WorkspaceSettings; models?: ModelCatalog;
  conversations?: ConversationSummary[]; conversationId?: string; approvals?: ApprovalRequest[];
}
/** 規格 §7：討論最多 8 輪，超出不可延長。 */
export const maxDiscussionRounds = 8;
export interface DiscussionBlock { kind: 'quota' | 'rate-limit'; provider: AgentId; roundNo: number }
export interface DiscussionSummary { id: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'; completedRounds: number; maxRounds: number; summaryTaskId?: string; blocked?: DiscussionBlock }
export interface ConversationSummary { id: string; title: string; createdAt: number; updatedAt: number; provider?: AgentId; preview?: string }
export interface ApprovalRequest { id: string; taskId: string; provider: AgentId; title: string; detail: string }
const base = { version: z.literal(1), requestId: z.string().min(1).max(100) };
export const webviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready') }),
  z.object({ ...base, type: z.literal('send-message'), provider: agentIdSchema, text: z.string().trim().min(1).max(32000), mode: modeSchema, preferences: providerPreferencesSchema.optional(), approvalMode: z.enum(approvalModes).optional() }),
  z.object({ ...base, type: z.literal('start-discussion'), provider: agentIdSchema, partner: agentIdSchema.optional(), text: z.string().trim().min(1).max(32000), rounds: z.number().int().min(2).max(8), preferences: providerPreferencesSchema.optional() }),
  z.object({ ...base, type: z.literal('extend-discussion'), discussionId: z.string().min(1).max(100), rounds: z.number().int().min(1).max(6) }),
  z.object({ ...base, type: z.literal('resolve-discussion'), discussionId: z.string().min(1).max(100), decision: z.enum(['retry', 'substitute', 'end']), provider: agentIdSchema.optional() }),
  z.object({ ...base, type: z.literal('reject-answer'), taskId: z.string().min(1).max(100), rejected: z.boolean() }),
  z.object({ ...base, type: z.literal('answer-approval'), approvalId: z.string().min(1).max(100), allow: z.boolean() }),
  z.object({ ...base, type: z.literal('new-conversation') }),
  z.object({ ...base, type: z.literal('open-conversation'), conversationId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('search-conversations'), query: z.string().max(500) }),
  z.object({ ...base, type: z.literal('rename-conversation'), conversationId: z.string().min(1).max(100), title: z.string().trim().min(1).max(120) }),
  z.object({ ...base, type: z.literal('delete-conversation'), conversationId: z.string().min(1).max(100) }),
  z.object({ ...base, type: z.literal('cancel-task'), taskId: z.string().max(100) }),
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
  | { version: 1; type: 'settings-saved'; requestId: string }
  | { version: 1; type: 'error'; requestId?: string; message: string };
