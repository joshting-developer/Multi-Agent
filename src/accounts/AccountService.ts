import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentId, ProviderStatus } from '../bridge/messages';
import type { AgentRegistry } from '../agents/AgentRegistry';
import type { StateStorage } from '../storage/SessionRepository';

export interface StoredAccount { id: string; provider: AgentId; name: string }
export interface AccountView extends StoredAccount { builtIn: boolean; loggedIn?: boolean; account?: ProviderStatus['account'] }
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
  constructor(private readonly storage: StateStorage, private readonly root: string, private readonly registry: AgentRegistry) {}
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
    ].map(account => ({ ...account, ...this.status.get(account.id) }));
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
  /** 執行時帶入的環境變數；預設帳號不覆寫，沿用官方 CLI 自己的設定。 */
  env(provider: AgentId, id?: string): Record<string, string> | undefined {
    if (!id || id === defaultAccountId(provider)) return undefined;
    const account = this.find(id);
    if (account.provider !== provider) throw new Error('帳號與 Agent 不相符，請重新選擇。');
    const envKey = this.registry.get(provider).accountEnvKey;
    if (!envKey) throw new Error('此 CLI 不支援多帳號。');
    return { [envKey]: join(this.root, account.id) };
  }
  async add(provider: AgentId, name: string): Promise<AccountView> {
    const account = { id: randomUUID(), provider, name: name.trim() };
    if (!account.name) throw new Error('請輸入帳號名稱。');
    await mkdir(join(this.root, account.id), { recursive: true, mode: 0o700 });
    const state = this.read(); state.accounts.push(account); await this.write(state);
    return { ...account, builtIn: false };
  }
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
    this.status.delete(id); await this.write(state);
  }
  /** 官方登入／登出命令與要帶入的環境；由使用者在終端機完成，Extension 不經手憑證。 */
  terminal(id: string, action: 'login' | 'logout'): { name: string; command: string[]; env?: Record<string, string> } {
    const account = this.find(id);
    const command = this.registry.get(account.provider).authCommand?.(action);
    if (!command) throw new Error('找不到官方 CLI，請先在設定檢查連線。');
    return { name: `${account.provider === 'claude' ? 'Claude' : 'Codex'} · ${account.name}`, command, env: this.env(account.provider, id) };
  }
  async refresh(): Promise<void> {
    await Promise.all(this.list().map(async account => {
      const adapter = this.registry.get(account.provider);
      if (adapter.account) this.status.set(account.id, await adapter.account(this.env(account.provider, account.id)));
    }));
    this.changed();
  }
}
