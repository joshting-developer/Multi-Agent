export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = typeof reasoningEfforts[number];
export const approvalModes = ['ask', 'auto-review', 'full-access'] as const;
export type ApprovalMode = typeof approvalModes[number];
export const approvalLabels: Record<ApprovalMode, string> = { ask: '要求核准', 'auto-review': '代我核准', 'full-access': '完整存取' };
export const replyLanguages = ['auto', 'zh-TW', 'en', 'none'] as const;
export type ReplyLanguage = typeof replyLanguages[number];
export const replyLanguageLabels: Record<ReplyLanguage, string> = { auto: '跟隨 VS Code', 'zh-TW': '繁體中文', en: 'English', none: '不指定' };
/** 依設定與 VS Code 介面語言產生給 Agent 的語言指示；不指定時不加。 */
export function languageInstruction(setting: ReplyLanguage, displayLanguage = 'en'): string | undefined {
  if (setting === 'none') return undefined;
  const tag = (setting === 'auto' ? displayLanguage : setting).toLowerCase();
  const name = tag.startsWith('zh-tw') || tag.startsWith('zh-hant') || tag === 'zh-hk' ? 'Traditional Chinese (Taiwan)' : tag.startsWith('zh') ? 'Simplified Chinese' : tag.startsWith('ja') ? 'Japanese' : tag.startsWith('ko') ? 'Korean' : tag.startsWith('en') ? 'English' : `the language with BCP 47 tag "${tag}"`;
  return `Reply to the user in ${name}. Keep code, commands, file paths, identifiers and quoted text unchanged.`;
}
export interface ProviderPreferences { model: string; effort: ReasoningEffort; accountId?: string }
export interface WorkspaceSettings {
  timeoutSeconds: number; sendShortcut: 'enter' | 'modifier-enter'; defaultMode: 'read-only' | 'workspace-write';
  codexPath: string; claudePath: string; codex: ProviderPreferences; claude: ProviderPreferences;
  approvalMode: ApprovalMode; replyLanguage: ReplyLanguage;
}
export interface ModelOption { id: string; label: string; efforts: ReasoningEffort[]; isDefault?: boolean; recommendedEffort?: ReasoningEffort }
export interface ModelCatalog { codex: ModelOption[]; claude: ModelOption[]; loading: boolean; error?: string }
export const defaultSettings: WorkspaceSettings = {
  timeoutSeconds: 300, sendShortcut: 'enter', defaultMode: 'workspace-write', codexPath: '', claudePath: '',
  codex: { model: '', effort: 'medium' }, claude: { model: 'sonnet', effort: 'medium' }, approvalMode: 'ask', replyLanguage: 'auto'
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
