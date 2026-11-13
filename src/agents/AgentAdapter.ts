import type { AgentId, ExecutionMode, ProviderStatus } from '../bridge/messages';
import type { ApprovalMode, ReasoningEffort } from '../bridge/settings';
import type { ApprovalRequest } from '../bridge/messages';
export interface AgentRequest {
  taskId: string; prompt: string; cwd: string; mode: ExecutionMode; timeoutMs: number; signal: AbortSignal;
  model?: string; effort?: ReasoningEffort;
  approvalMode?: ApprovalMode;
  /** persist：保留原生 Session 供下次接續；resumeSessionId：接續這個原生 Session。討論一律不保留。 */
  persist?: boolean; resumeSessionId?: string;
  approve?: (request: Omit<ApprovalRequest, 'id' | 'taskId' | 'provider'>) => Promise<boolean>;
}
export type AgentEvent =
  | { type: 'text-delta'; taskId: string; text: string }
  | { type: 'activity'; taskId: string; text: string }
  | { type: 'tool'; taskId: string; id: string; tool: string; phase: 'start' | 'end'; success?: boolean; input?: string; output?: string }
  | { type: 'complete'; taskId: string; sessionId?: string };
export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<ProviderStatus>;
  capabilities(): ProviderStatus['capabilities'];
  execute(request: AgentRequest): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
}
