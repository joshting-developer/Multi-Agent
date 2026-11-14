import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, ProviderStatus, UsageSnapshot } from '../bridge/messages';
import type { AgentRegistry } from '../agents/AgentRegistry';
import type { StateStorage } from '../storage/SessionRepository';

/** cli：在終端機用官方命令登入；api-key：使用者輸入的 API Key。 */
export interface StoredAccount { id: string; provider: AgentId; name: string; method?: 'cli' | 'api-key' }
/** VS Code SecretStorage（作業系統鑰匙圈）的最小介面。 */
export interface SecretStore { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void> }
const secretKey = (id: string) => `multiAgent.apiKey.${id}`;
export interface AccountView extends StoredAccount { builtIn: boolean; loggedIn?: boolean; account?: ProviderStatus['account']; usage?: UsageSnapshot }
interface StoredState { version: 1; accounts: StoredAccount[]; names: Record<string, string>; selected?: Partial<Record<AgentId, string>> }
const key = 'multiAgent.accounts.v1';
const providers: AgentId[] = ['codex', 'claude'];
export const defaultAccountId = (provider: AgentId) => `default-${provider}`;

/**
 * 每個額外帳號對應 Extension 儲存區下自己的官方 CLI 設定目錄，由官方 CLI 自行保管憑證；
 * 這裡只保存名稱與目錄位置，不讀、不複製任何 Token。CLI 原本的帳號是不能移除的預設帳號。
 */
export class AccountService {
  private readonly status = new Map<string, { loggedIn: boolean; account?: ProviderStatus['account'] }>();
  private readonly listeners = new Set<() => void>();
  private readonly usage = new Map<string, UsageSnapshot>();
  constructor(private readonly storage: StateStorage, private readonly root: string, private readonly registry: AgentRegistry, private readonly secrets?: SecretStore) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const listener of this.listeners) listener(); }
  private read(): StoredState {
    const value = this.storage.get<StoredState>(key);
    return value?.version === 1 ? value : { version: 1, accounts: [], names: {} };
  }
  private async write(state: StoredState) { await this.storage.update(key, state); this.changed(); }
  list(): AccountView[] {
    const state = this.read();
    return [
      ...providers.map(provider => ({ id: defaultAccountId(provider), provider, name: state.names[defaultAccountId(provider)] ?? '預設帳號', builtIn: true })),
      ...state.accounts.map(account => ({ ...account, builtIn: false }))
    ].map(account => ({ ...account, ...this.status.get(account.id), ...(this.usage.has(account.id) && { usage: this.usage.get(account.id) }) }));
  }
  private find(id: string): AccountView {
    const account = this.list().find(item => item.id === id);
    if (!account) throw new Error('找不到這個帳號，請重新選擇。');
    return account;
  }
  /** 沒有在送出時另外指定時，各 Provider 使用的帳號。 */
  selected(): Record<AgentId, string> {
    const state = this.read(); const ids = new Set(this.list().map(item => item.id));
    return Object.fromEntries(providers.map(provider => [provider, state.selected?.[provider] && ids.has(state.selected[provider]!) ? state.selected[provider]! : defaultAccountId(provider)])) as Record<AgentId, string>;
  }
  async select(provider: AgentId, id: string): Promise<void> {
    if (this.find(id).provider !== provider) throw new Error('帳號與 Agent 不相符，請重新選擇。');
    const state = this.read(); state.selected = { ...state.selected, [provider]: id }; await this.write(state);
  }
  /** 帳號的官方 CLI 設定目錄；預設帳號不覆寫，沿用官方 CLI 自己的設定。 */
  directory(provider: AgentId, id?: string): Record<string, string> | undefined {
    if (!id || id === defaultAccountId(provider)) return undefined;
    const account = this.find(id);
    if (account.provider !== provider) throw new Error('帳號與 Agent 不相符，請重新選擇。');
    const envKey = this.registry.get(provider).accountEnvKey;
    if (!envKey) throw new Error('此 CLI 不支援多帳號。');
    return { [envKey]: join(this.root, account.id) };
  }
  /** 執行時帶入的環境變數：設定目錄，加上存在鑰匙圈的 API Key（只有需要以環境變數提供 Key 的 CLI）。 */
  async env(provider: AgentId, id?: string): Promise<Record<string, string> | undefined> {
    const directory = this.directory(provider, id);
    if (!directory || this.find(id!).method !== 'api-key') return directory;
    const variable = this.registry.get(provider).apiKeyEnvVar;
    if (!variable) return directory;
    const key = await this.secrets?.get(secretKey(id!));
    if (!key) throw new Error('找不到這個帳號的 API Key，請移除後重新新增。');
    return { ...directory, [variable]: key };
  }
  async add(provider: AgentId, name: string, apiKey?: string): Promise<AccountView> {
    const account: StoredAccount = { id: randomUUID(), provider, name: name.trim(), ...(apiKey !== undefined && { method: 'api-key' }) };
    if (!account.name) throw new Error('請輸入帳號名稱。');
    const adapter = this.registry.get(provider);
    if (apiKey !== undefined) {
      const key = apiKey.trim();
      if (!/^\S{20,400}$/.test(key) || !key.startsWith(provider === 'claude' ? 'sk-ant-' : 'sk-')) throw new Error(provider === 'claude' ? 'Anthropic API Key 應以 sk-ant- 開頭。' : 'OpenAI API Key 應以 sk- 開頭。');
      if (!adapter.apiKeyLogin && !(adapter.apiKeyEnvVar && this.secrets)) throw new Error('此 CLI 不支援以 API Key 登入。');
      apiKey = key;
    }
    await mkdir(join(this.root, account.id), { recursive: true, mode: 0o700 });
    try {
      // Codex 交給官方 login --with-api-key 寫進該帳號目錄；Claude 存進作業系統鑰匙圈，執行時才以環境變數提供。
      if (apiKey && adapter.apiKeyLogin) await adapter.apiKeyLogin(apiKey, { [adapter.accountEnvKey!]: join(this.root, account.id) });
      else if (apiKey) await this.secrets!.store(secretKey(account.id), apiKey);
    } catch (error) { await rm(join(this.root, account.id), { recursive: true, force: true }); throw error; }
    const state = this.read(); state.accounts.push(account); await this.write(state);
    return { ...account, builtIn: false };
  }
  /** 只做存在與歸屬檢查，不讀取 Key。 */
  check(provider: AgentId, id?: string): void { this.directory(provider, id); }
  async rename(id: string, name: string): Promise<void> {
    const value = name.trim(); const state = this.read(); this.find(id);
    if (!value) throw new Error('請輸入帳號名稱。');
    const stored = state.accounts.find(item => item.id === id);
    if (stored) stored.name = value; else state.names[id] = value;
    await this.write(state);
  }
  /** 移除只刪除這個帳號自己的設定目錄；預設帳號是 CLI 原本的登入，不在這裡刪除。 */
  async remove(id: string): Promise<void> {
    const account = this.find(id);
    if (account.builtIn) throw new Error('預設帳號是官方 CLI 原本的登入，請在終端機用官方命令登出。');
    const state = this.read(); state.accounts = state.accounts.filter(item => item.id !== id);
    await rm(join(this.root, id), { recursive: true, force: true });
    if (account.method === 'api-key') await this.secrets?.delete(secretKey(id));
    this.status.delete(id); this.usage.delete(id); await this.write(state);
  }
  /** 官方登入／登出命令與要帶入的環境；由使用者在終端機完成，Extension 不經手憑證。 */
  terminal(id: string, action: 'login' | 'logout'): { name: string; command: string[]; env?: Record<string, string> } {
    const account = this.find(id);
    if (account.method === 'api-key' && !this.registry.get(account.provider).apiKeyLogin) throw new Error('這個帳號用 API Key 登入；要更換 Key 請移除後重新新增。');
    const command = this.registry.get(account.provider).authCommand?.(action);
    if (!command) throw new Error('找不到官方 CLI，請先在設定檢查連線。');
    // 終端機只帶設定目錄，不帶 API Key。
    return { name: `${account.provider === 'claude' ? 'Claude' : 'Codex'} · ${account.name}`, command, env: this.directory(account.provider, id) };
  }
  async refresh(): Promise<void> {
    await Promise.all(this.list().map(async account => {
      const adapter = this.registry.get(account.provider); const env = await this.env(account.provider, account.id).catch(() => undefined);
      if (adapter.account) this.status.set(account.id, await adapter.account(env));
      // 只有官方提供不需推論的查詢時才主動讀；其餘保留最近一次執行回報的值，切換帳號不會沿用其他帳號的資料。
      if (adapter.usage && this.status.get(account.id)?.loggedIn) { const usage = await adapter.usage(env); if (usage) this.usage.set(account.id, usage); else this.usage.delete(account.id); }
    }));
    this.changed();
  }
  recordUsage(provider: AgentId, id: string | undefined, usage: UsageSnapshot): void {
    this.usage.set(id ?? defaultAccountId(provider), usage); this.changed();
  }
}
