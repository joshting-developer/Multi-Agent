import type { AgentId, ExecutionMode, ProviderStatus } from '../bridge/messages';
import type { ApprovalMode, ReasoningEffort } from '../bridge/settings';
import type { ApprovalRequest } from '../bridge/messages';
export interface AgentRequest {
  taskId: string; prompt: string; cwd: string; mode: ExecutionMode; timeoutMs: number; signal: AbortSignal;
  model?: string; effort?: ReasoningEffort;
  approvalMode?: ApprovalMode;
  approve?: (request: Omit<ApprovalRequest, 'id' | 'taskId' | 'provider'>) => Promise<boolean>;
}
export type AgentEvent =
  | { type: 'text-delta'; taskId: string; text: string }
  | { type: 'activity'; taskId: string; text: string }
  | { type: 'tool'; taskId: string; tool: string; phase: 'start' | 'end'; success?: boolean }
  | { type: 'complete'; taskId: string; sessionId?: string };
export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<ProviderStatus>;
  capabilities(): ProviderStatus['capabilities'];
  execute(request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
