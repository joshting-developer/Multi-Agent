export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export const approvalModes = ['ask', 'auto-review', 'full-access'] as const;
export type ApprovalMode = typeof approvalModes[number];
export const approvalLabels: Record<ApprovalMode, string> = { ask: '要求核准', 'auto-review': '代我核准', 'full-access': '完整存取' };
export interface ProviderPreferences { model: string; effort: ReasoningEffort; accountId?: string }
export interface WorkspaceSettings {
  timeoutSeconds: number; sendShortcut: 'enter' | 'modifier-enter'; defaultMode: 'read-only' | 'workspace-write';
  codexPath: string; claudePath: string; codex: ProviderPreferences; claude: ProviderPreferences;
  approvalMode: ApprovalMode;
}
export interface ModelOption { id: string; label: string; efforts: ReasoningEffort[]; isDefault?: boolean; recommendedEffort?: ReasoningEffort }
export interface ModelCatalog { codex: ModelOption[]; claude: ModelOption[]; loading: boolean; error?: string }
export const defaultSettings: WorkspaceSettings = {
  timeoutSeconds: 300, sendShortcut: 'enter', defaultMode: 'workspace-write', codexPath: '', claudePath: '',
  codex: { model: '', effort: 'medium' }, claude: { model: 'sonnet', effort: 'medium' }, approvalMode: 'ask'
};
export const claudeModels: ModelOption[] = ['opus', 'sonnet', 'haiku', 'fable'].map(id => ({
  id, label: id[0]!.toUpperCase() + id.slice(1) + '（別名）', efforts: ['low', 'medium', 'high', 'xhigh', 'max']
}));
export const effortLabels: Record<ReasoningEffort, string> = {
  none: '無', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '極高', max: '最高', ultra: 'Ultra'
};
export function concretePreferences(value: ProviderPreferences, models: ModelOption[]): ProviderPreferences {
  const model = models.find(item => item.id === value.model) ?? (!value.model ? models.find(item => item.isDefault) ?? models[0] : undefined);
  const effort = !model || model.efforts.includes(value.effort) ? value.effort : model?.recommendedEffort ?? (model?.efforts.includes('medium') ? 'medium' : model?.efforts[0]) ?? 'medium';
  return { model: value.model || model?.id || '', effort };
}
