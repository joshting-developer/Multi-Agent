import { z } from 'zod';
import { effortSchema, type ModelOption } from '../bridge/settings';
import { ProcessManager } from '../execution/ProcessManager';
import { resolveExecutable } from '../agents/ExecutableResolver';

const responseSchema = z.object({
  data: z.array(z.object({
    model: z.string(), displayName: z.string(), hidden: z.boolean().optional(), isDefault: z.boolean().optional(), defaultReasoningEffort: effortSchema.optional(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).default([])
  })), nextCursor: z.string().nullish()
});
export class CodexModelCatalog {
  /** env：選定帳號的 CODEX_HOME；沒給時用 CLI 預設（只給 smoke 腳本用）。 */
  constructor(private readonly processes: ProcessManager, private readonly path: () => string, private readonly cwd: string, private readonly env?: () => Promise<Record<string, string>>) {}
  async list(): Promise<ModelOption[]> {
    const command = await resolveExecutable('codex', this.path());
    if (!command) throw new Error('找不到 Codex CLI。可設定執行檔路徑後重新載入模型。');
    const env = this.env && { ...process.env, ...await this.env() };
    let send: (value: string) => void = () => undefined;
    const models: ModelOption[] = [];
    let id = 2;
    const request = (method: string, params: unknown, requestId?: number) => send(JSON.stringify({ method, params, ...(requestId === undefined ? {} : { id: requestId }) }) + '\n');
    for await (const event of this.processes.run({
      command, args: ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"', '-c', 'mcp_servers={}', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false'],
      cwd: this.cwd, timeoutMs: 20000, ...(env && { env }),
      onStdinReady: write => { send = write; request('initialize', { clientInfo: { name: 'multi_agent_workspace', version: '0.1.4' }, capabilities: {} }, 1); }
    })) {
      if (event.type === 'exit') throw new Error('模型清單讀取中斷，請重新整理或手動輸入模型 ID。');
      let message: Record<string, unknown>;
      try { message = JSON.parse(event.text) as Record<string, unknown>; } catch { continue; }
      if (message.id !== 1 && message.id !== id) continue;
      if (message.error) throw new Error('官方 CLI 無法提供模型清單。請確認登入、網路與管理政策，或手動輸入模型 ID。');
      if (message.id === 1) {
        request('initialized', {}); request('model/list', { limit: 100, includeHidden: false }, id);
      } else {
        const parsed = responseSchema.safeParse(message.result);
        if (!parsed.success) throw new Error('模型清單格式不相容，請更新官方 CLI，或手動輸入模型 ID。');
        const result = parsed.data;
        for (const model of result.data) if (!model.hidden) models.push({
          id: model.model, label: model.displayName, isDefault: model.isDefault, recommendedEffort: model.defaultReasoningEffort,
          efforts: model.supportedReasoningEfforts.flatMap(item => { const parsed = effortSchema.safeParse(item.reasoningEffort); return parsed.success ? [parsed.data] : []; })
        });
        if (result.nextCursor && models.length < 300) request('model/list', { limit: 100, includeHidden: false, cursor: result.nextCursor }, ++id);
        else return models;
      }
    }
    throw new Error('模型清單沒有完成回應。');
  }
}
