import type { AgentId, WorkspacePolicy } from '../bridge/messages';
export function assertAuthorized(policy: WorkspacePolicy, provider: AgentId, trusted: boolean): void {
  if (!trusted) throw new Error('請先信任此 VS Code 工作區。');
  if (policy.classification === 'unclassified' || policy.classification === 'restricted') throw new Error('此工作區尚未授權傳送資料。請先設定資料分類與 Provider。');
  if (!policy.allowedProviders.includes(provider)) throw new Error('此 Provider 尚未獲得目前工作區的資料使用授權。');
}

export const protectedPatterns = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.ssh/**', '**/.aws/**', '**/.codex/**', '**/.claude/**', '**/credentials*', '**/secrets*'];
