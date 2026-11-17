import * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import type { AgentId } from '../bridge/messages';
import { z } from 'zod';
import { replyLanguages } from '../bridge/preferences';
import { claudeModels, concretePreferences, defaultModels, effortSchema, providerPreferencesSchema, settingsSchema, type ModelCatalog, type ProviderPreferences, type WorkspaceSettings } from '../bridge/settings';
import { CodexModelCatalog } from './CodexModelCatalog';

const replyLanguageSchema = z.enum(replyLanguages);
export class SettingsService {
  readonly models: ModelCatalog = { codex: [], claude: claudeModels, loading: false };
  private readonly listeners = new Set<() => void>();
  private refresh?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  isSaving = false;
  constructor(private readonly catalog: Pick<CodexModelCatalog, 'list'>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(): void { for (const listener of this.listeners) listener(); }
  read(): WorkspaceSettings {
    const config = vscode.workspace.getConfiguration('multiAgent');
    return {
      sendShortcut: config.get('sendShortcut', 'enter'), defaultMode: config.get('defaultMode', 'workspace-write'),
      codexPath: config.get('codexPath', ''), claudePath: config.get('claudePath', ''),
      approvalMode: config.get('approvalMode', 'ask'), replyLanguage: replyLanguageSchema.safeParse(config.get('replyLanguage')).data ?? 'auto',
      codex: concretePreferences({ model: config.get('codexModel', '') || this.codexDefault(), effort: effortSchema.safeParse(config.get('codexEffort')).data ?? 'medium' }, this.models.codex),
      claude: concretePreferences({ model: config.get('claudeModel', '') || defaultModels.claude, effort: effortSchema.safeParse(config.get('claudeEffort')).data ?? 'medium' }, this.models.claude)
    };
  }
  /** Codex 清單還沒載入或有這個模型時用預設模型；沒有時交給 Codex 標的預設。 */
  private codexDefault(): string {
    const list = this.models.codex;
    return !list.length || list.some(model => model.id === defaultModels.codex) ? defaultModels.codex : '';
  }
  validate(provider: AgentId, value: ProviderPreferences): ProviderPreferences {
    const preferences = providerPreferencesSchema.parse(value);
    const selected = this.models[provider].find(model => model.id === preferences.model);
    if (preferences.model) {
      if (selected && !selected.efforts.includes(preferences.effort)) throw new Error('此模型不支援所選推理強度，請重新選擇。');
      if (provider === 'claude' && !['low', 'medium', 'high', 'xhigh', 'max'].includes(preferences.effort)) throw new Error('Claude Code 不支援此推理強度。');
    }
    return preferences;
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writes.catch(() => undefined).then(operation); this.writes = next; return next;
  }
  setProvider(provider: AgentId, preferences: ProviderPreferences): Promise<void> {
    const { model, effort } = this.validate(provider, preferences); const validated = { model, effort };
    return this.enqueue(() => { const settings = this.read(); settings[provider] = validated; return this.apply(settings); });
  }
  save(value: WorkspaceSettings): Promise<void> {
    const settings = settingsSchema.parse(value);
    return this.enqueue(() => this.apply(settings));
  }
  private async apply(value: WorkspaceSettings): Promise<void> {
    const settings = settingsSchema.parse(value);
    for (const path of [settings.codexPath, settings.claudePath]) if (path && !isAbsolute(path)) throw new Error('CLI 路徑必須是執行檔的絕對路徑。');
    this.validate('codex', settings.codex); this.validate('claude', settings.claude);
    const current = this.read();
    const values = {
      approvalMode: settings.approvalMode, replyLanguage: settings.replyLanguage, sendShortcut: settings.sendShortcut, defaultMode: settings.defaultMode,
      codexPath: settings.codexPath, claudePath: settings.claudePath,
      codexModel: settings.codex.model, codexEffort: settings.codex.effort, claudeModel: settings.claude.model, claudeEffort: settings.claude.effort
    };
    const config = vscode.workspace.getConfiguration('multiAgent');
    this.isSaving = true;
    try {
      for (const [key, value] of Object.entries(values)) if (JSON.stringify(config.get(key)) !== JSON.stringify(value)) await config.update(key, value, vscode.ConfigurationTarget.Global);
      if (current.codexPath !== settings.codexPath) { this.models.codex = []; void this.refreshModels(); }
    } finally { this.isSaving = false; this.changed(); }
  }
  refreshModels(): Promise<void> {
    if (this.refresh) return this.refresh;
    this.models.loading = true; this.models.error = undefined; this.changed();
    const path = this.read().codexPath;
    this.refresh = (async () => {
      try { const models = await this.catalog.list(); if (this.read().codexPath === path) this.models.codex = models; }
      catch (error) { this.models.error = error instanceof Error ? error.message : '無法讀取模型清單。'; }
      finally {
        this.models.loading = false; this.refresh = undefined; this.changed();
        if (this.read().codexPath !== path) queueMicrotask(() => { void this.refreshModels(); });
      }
    })();
    return this.refresh;
  }
}
