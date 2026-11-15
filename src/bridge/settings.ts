import { z } from 'zod';
import { approvalModes, reasoningEfforts, replyLanguages } from './preferences';
export * from './preferences';

export const effortSchema = z.enum(reasoningEfforts);
export const modelIdSchema = z.string().trim().max(180).refine(value => value === '' || /^[a-zA-Z0-9][a-zA-Z0-9._:/@()+\[\]-]*$/.test(value), '請輸入有效的模型 ID。');
export const providerPreferencesSchema = z.object({ model: modelIdSchema, effort: effortSchema, accountId: z.string().max(100).optional() });
export const settingsSchema = z.object({
  approvalMode: z.enum(approvalModes).default('ask'),
  replyLanguage: z.enum(replyLanguages).default('auto'),
  timeoutSeconds: z.number().int().min(10).max(3600),
  sendShortcut: z.enum(['enter', 'modifier-enter']),
  defaultMode: z.enum(['read-only', 'workspace-write']),
  codexPath: z.string().max(2048), claudePath: z.string().max(2048),
  codex: providerPreferencesSchema, claude: providerPreferencesSchema
});
