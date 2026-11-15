import type { AgentId, ExecutionMode } from '../../src/bridge/messages';
import type { ApprovalMode, ProviderPreferences } from '../../src/bridge/preferences';

/** 任務執行中先打好的下一則訊息；送出時沿用加入清單當下選的 Agent、模型與權限。 */
export interface QueuedMessage {
  id: string; conversationId: string; provider: AgentId; text: string; mode: ExecutionMode; approvalMode: ApprovalMode;
  preferences: ProviderPreferences; images: Array<{ mime: string; data: string }>; steering?: boolean;
}
/** 混合模式的一個成員：帳號、模型與推理強度都放在 preferences。 */
export interface HybridMember { provider: AgentId; preferences: ProviderPreferences }
