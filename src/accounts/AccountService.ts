import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, ProviderStatus, ResetCreditOutcome, UsageSnapshot } from '../bridge/messages';
import type { AgentRegistry } from '../agents/AgentRegistry';
import type { StateStorage } from '../storage/SessionRepository';
import type { AccountPreferences } from '../bridge/preferences';

/** cli：在終端機用官方命令登入；api-key：使用者輸入的 API Key。 */
export interface StoredAccount { id: string; provider: AgentId; name: string; method?: 'cli' | 'api-key'; preferences?: AccountPreferences }
/** VS Code SecretStorage（作業系統鑰匙圈）的最小介面。 */
export interface SecretStore { get(key: string): PromiseLike<string | undefined>; store(key: string, value: string): PromiseLike<void>; delete(key: string): PromiseLike<void> }
const secretKey = (id: string) => `multiAgent.apiKey.${id}`;
export interface AccountView extends StoredAccount { loggedIn?: boolean; account?: ProviderStatus['account']; usage?: UsageSnapshot }
interface StoredState { version: 1; accounts: StoredAccount[]; names: Record<string, string>; selected?: Partial<Record<AgentId, string>> }
const key = 'multiAgent.accounts.v1';
const workspaceKey = 'multiAgent.selectedAccounts.v1';
const providers: AgentId[] = ['codex', 'claude'];
const label = (provider: AgentId) => provider === 'claude' ? 'Claude' : 'Codex';

/**
 * 每個帳號對應 Extension 儲存區下自己的官方 CLI 設定目錄，由官方 CLI 自行保管憑證；
 * 這裡只保存名稱與目錄位置，不讀、不複製任何 Token。不使用官方 CLI 的預設目錄（~/.codex、~/.claude），
 * 官方擴充或 CLI 換帳號不會影響這裡（MA-104）。
 */
export class AccountService {
  private readonly status = new Map<string, { loggedIn: boolean; account?: ProviderStatus['account'] }>();
  private readonly listeners = new Set<() => void>();
  private readonly usage = new Map<string, UsageSnapshot>();
  /** workspace：這個工作區自己的使用中帳號（VS Code workspaceState）；沒有時用全域的最近選擇（MA-165）。 */
  constructor(private readonly storage: StateStorage, private readonly root: string, private readonly registry: AgentRegistry, private readonly secrets?: SecretStore, private readonly workspace?: StateStorage) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed() { for (const listener of this.listeners) listener(); }
  private read(): StoredState {
    const value = this.storage.get<StoredState>(key);
    return value?.version === 1 ? value : { version: 1, accounts: [], names: {} };
  }
  private async write(state: StoredState) { await this.storage.update(key, state); this.changed(); }
  list(): AccountView[] {
    const state = this.read();
    // 還沒取名的帳號在登入後改用帳戶本身的名稱（見 refresh）。
    return state.accounts.map(account => ({ ...account, name: account.name || (account.method === 'api-key' ? 'API Key' : '新帳號') })).map(account => ({ ...account, ...this.status.get(account.id), ...(this.usage.has(account.id) && { usage: this.usage.get(account.id) }) }));
  }
  private find(id: string): AccountView {
    const account = this.list().find(item => item.id === id);
    if (!account) throw new Error('找不到這個帳號，請重新選擇。');
    return account;
  }
  /** 沒有在送出時另外指定時，各 Provider 使用的帳號。 */
  /** 選過且還存在的帳號優先，否則用該來源的第一個帳號；沒有帳號的來源不列出。舊版的預設帳號選擇會落到這裡。 */
  selected(): Partial<Record<AgentId, string>> {
    const state = this.read();
    // 先看這個工作區自己選的，再看全域最近一次的選擇；兩個視窗各選各的，不會互相改到（MA-165）。
    const local = this.workspace?.get<Partial<Record<AgentId, string>>>(workspaceKey) ?? {};
    const result = Object.fromEntries(providers.flatMap(provider => {
      const own = state.accounts.filter(account => account.provider === provider);
      const id = own.find(account => account.id === local[provider])?.id ?? own.find(account => account.id === state.selected?.[provider])?.id ?? own[0]?.id;
      return id ? [[provider, id]] : [];
    })) as Partial<Record<AgentId, string>>;
    // 這個工作區還沒選過時，把現在用的帳號記下來，之後別的視窗換帳號不會影響這裡。
    if (this.workspace && providers.some(provider => result[provider] && local[provider] !== result[provider])) void this.workspace.update(workspaceKey, { ...local, ...result });
    return result;
  }

  /** 執行要用的帳號：指定且存在的帳號，否則目前選定的帳號；都沒有時要求先新增。 */
  resolve(provider: AgentId, id?: string): string {
    const account = id ? this.read().accounts.find(item => item.id === id && item.provider === provider) : undefined;
    const resolved = account?.id ?? this.selected()[provider];
    if (!resolved) throw new Error(`還沒有 ${label(provider)} 帳號，請到設定 → 帳號新增並登入。`);
    return resolved;
  }
  /** 帳號自己的模型、推理強度與動作核准；呼叫端先驗證模型與強度。 */
  async setPreferences(id: string, preferences: AccountPreferences): Promise<void> {
    this.find(id); const state = this.read();
    state.accounts.find(item => item.id === id)!.preferences = { model: preferences.model, effort: preferences.effort, approvalMode: preferences.approvalMode };
    await this.write(state);
  }
  preferences(id?: string): AccountPreferences | undefined { return id ? this.read().accounts.find(item => item.id === id)?.preferences : undefined; }
  async select(provider: AgentId, id: string): Promise<void> {
    if (this.find(id).provider !== provider) throw new Error('帳號與 Agent 不相符，請重新選擇。');
    if (this.workspace) await this.workspace.update(workspaceKey, { ...this.workspace.get<Partial<Record<AgentId, string>>>(workspaceKey), [provider]: id });
    // 全域只當新工作區的預設。
    const state = this.read(); state.selected = { ...state.selected, [provider]: id }; await this.write(state);
  }
  /** 帳號自己的官方 CLI 設定目錄；一定要指定帳號，不回退到官方 CLI 的預設目錄。 */
  directory(provider: AgentId, id?: string): Record<string, string> {
    if (!id) throw new Error(`還沒有 ${label(provider)} 帳號，請到設定 → 帳號新增並登入。`);
    const account = this.find(id);
    if (account.provider !== provider) throw new Error('帳號與 Agent 不相符，請重新選擇。');
    const envKey = this.registry.get(provider).accountEnvKey;
    if (!envKey) throw new Error('此 CLI 不支援多帳號。');
    return { [envKey]: join(this.root, account.id) };
  }
  /** 執行時帶入的環境變數：設定目錄，加上存在鑰匙圈的 API Key（只有需要以環境變數提供 Key 的 CLI）。 */
  async env(provider: AgentId, id?: string): Promise<Record<string, string>> {
    const directory = this.directory(provider, id);
    if (this.find(id!).method !== 'api-key') return directory;
    const variable = this.registry.get(provider).apiKeyEnvVar;
    if (!variable) return directory;
    const key = await this.secrets?.get(secretKey(id!));
    if (!key) throw new Error('找不到這個帳號的 API Key，請移除後重新新增。');
    return { ...directory, [variable]: key };
  }
  /** 名稱可省略：登入後自動用帳戶的 email，之後可再改名。 */
  async add(provider: AgentId, name = '', apiKey?: string): Promise<AccountView> {
    const account: StoredAccount = { id: randomUUID(), provider, name: name.trim(), ...(apiKey !== undefined && { method: 'api-key' }) };
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
    return this.find(account.id);
  }
  async rename(id: string, name: string): Promise<void> {
    const value = name.trim(); const state = this.read(); this.find(id);
    if (!value) throw new Error('請輸入帳號名稱。');
    state.accounts.find(item => item.id === id)!.name = value;
    await this.write(state);
  }
  /** 移除只刪除這個帳號自己的設定目錄與鑰匙圈裡的 Key。 */
  async remove(id: string): Promise<void> {
    const account = this.find(id);
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
    return { name: `${label(account.provider)} · ${account.name}`, command, env: this.directory(account.provider, id) };
  }
  /** 重新檢查登入與用量；給 ids 時只檢查這些帳號（例如剛開登入終端機的帳號）。 */
  async refresh(ids?: string[]): Promise<void> {
    await Promise.all(this.list().filter(account => !ids || ids.includes(account.id)).map(async account => {
      const adapter = this.registry.get(account.provider); const env = await this.env(account.provider, account.id).catch(() => undefined);
      if (adapter.account) this.status.set(account.id, await adapter.account(env));
      // 只有官方提供不需推論的查詢時才主動讀；其餘保留最近一次執行回報的值，切換帳號不會沿用其他帳號的資料。
      if (adapter.usage && this.status.get(account.id)?.loggedIn) { const usage = await adapter.usage(env); if (usage) this.usage.set(account.id, usage); else this.usage.delete(account.id); }
    }));
    const state = this.read();
    const unnamed = state.accounts.filter(account => !account.name && this.status.get(account.id)?.account?.email);
    for (const account of unnamed) account.name = this.status.get(account.id)!.account!.email!.slice(0, 60);
    if (unnamed.length) await this.write(state); else this.changed();
  }
  /** 只重讀官方額度（不重新檢查登入），給設定頁定期同步用；官方讀額度不耗 token。 */
  async refreshUsage(): Promise<void> {
    await Promise.all(this.list().filter(account => this.status.get(account.id)?.loggedIn && this.registry.get(account.provider).usage).map(async account => {
      const usage = await this.registry.get(account.provider).usage!(await this.env(account.provider, account.id)).catch(() => undefined);
      if (usage) this.usage.set(account.id, usage);
    }));
    this.changed();
  }
  loggedIn(id: string): boolean | undefined { return this.status.get(id)?.loggedIn; }
  /** 用掉這個帳號的一張官方重置券（指定 creditId 時用那一張），之後重新讀用量。 */
  async useResetCredit(id: string, creditId?: string): Promise<ResetCreditOutcome> {
    const account = this.find(id); const adapter = this.registry.get(account.provider);
    if (!adapter.consumeResetCredit) throw new Error('這個來源沒有額度重置券。');
    const outcome = await adapter.consumeResetCredit(await this.env(account.provider, id), creditId);
    await this.refresh([id]);
    return outcome;
  }
  recordUsage(provider: AgentId, id: string | undefined, usage: UsageSnapshot): void {
    if (!id) return;
    // 執行回報沒有重置券張數，沿用最近一次官方查詢的值。
    const previous = this.usage.get(id);
    this.usage.set(id, previous?.resetCredits === undefined || usage.resetCredits !== undefined ? usage : { ...usage, resetCredits: previous.resetCredits, ...(previous.resetCreditList && { resetCreditList: previous.resetCreditList }) }); this.changed();
  }
}
