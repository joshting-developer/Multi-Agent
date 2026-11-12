import { z } from 'zod';
import { effortSchema, modelIdSchema, providerPreferencesSchema, settingsSchema, approvalModes, type ModelCatalog, type WorkspaceSettings } from './settings';

export const agentIdSchema = z.enum(['claude', 'codex']);
export type AgentId = z.infer<typeof agentIdSchema>;
export const modeSchema = z.enum(['read-only', 'workspace-write']);
export type ExecutionMode = z.infer<typeof modeSchema>;
export const participantRoleSchema = z.enum(['architect', 'critic']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;
export const taskSchema = z.object({
  id: z.string(), provider: agentIdSchema, mode: modeSchema, prompt: z.string(), output: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  startedAt: z.number(), endedAt: z.number().optional(), error: z.string().optional(),
  activity: z.string().optional(), sessionId: z.string().optional(), participantId: z.string().optional(), participantRole: participantRoleSchema.optional(),
  discussionId: z.string().optional(), roundNo: z.number().int().positive().optional(),
  model: modelIdSchema.optional(), effort: z.union([effortSchema, z.literal('default')]).optional().transform(value => value === 'default' ? undefined : value).optional(),
  approvalMode: z.enum(approvalModes).optional()
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
  activeTaskId?: string; checking: boolean; trusted: boolean;
  settings?: WorkspaceSettings; models?: ModelCatalog;
  conversations?: ConversationSummary[]; conversationId?: string; approvals?: ApprovalRequest[];
}
export interface ConversationSummary { id: string; title: string; createdAt: number; updatedAt: number; provider?: AgentId; preview?: string }
export interface ApprovalRequest { id: string; taskId: string; provider: AgentId; title: string; detail: string }
const base = { version: z.literal(1), requestId: z.string().min(1).max(100) };
export const webviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('ready') }),
  z.object({ ...base, type: z.literal('send-message'), provider: agentIdSchema, text: z.string().trim().min(1).max(32000), mode: modeSchema, preferences: providerPreferencesSchema.optional(), approvalMode: z.enum(approvalModes).optional() }),
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
