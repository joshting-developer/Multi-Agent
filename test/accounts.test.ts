import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountService } from '../src/accounts/AccountService';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';

class Fixture extends ProcessManager {
  readonly requests: ProcessRequest[] = [];
  constructor(private readonly provider: string) { super(); }
  override run(request: ProcessRequest) { this.requests.push(request); return super.run({ ...request, command: process.execPath, args: [resolve('test/fixtures/agent.cjs'), this.provider, 'ok', ...request.args] }); }
}
class Secrets { readonly values = new Map<string, string>(); async get(key: string) { return this.values.get(key); } async store(key: string, value: string) { this.values.set(key, value); } async delete(key: string) { this.values.delete(key); } }
class Memory { value: unknown; get<T>() { return this.value as T; } async update(_key: string, value: unknown) { this.value = JSON.parse(JSON.stringify(value)); } }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-accounts-')); dirs.push(root);
  const claude = new Fixture('claude'); const codex = new Fixture('codex');
  const registry = new AgentRegistry([new ClaudeCodeAdapter(claude, () => process.execPath, process.cwd()), new CodexAppServerAdapter(codex, () => process.execPath, process.cwd())]);
  await registry.detect();
  return { root, claude, codex, storage: new Memory(), registry, service: (storage = new Memory()) => new AccountService(storage, root, registry) };
}

describe('Multiple official CLI accounts', () => {
  it('names extra accounts, gives each its own CLI directory, and resolves the account for each step', async () => {
    const { root, registry, storage } = await setup();
    const accounts = new AccountService(storage, root, registry);
    // 沒有內建的預設帳號：不使用官方 CLI 的 ~/.codex、~/.claude，沒有帳號時要求先新增。
    expect(accounts.list()).toEqual([]); expect(accounts.selected()).toEqual({});
    expect(() => accounts.resolve('claude')).toThrow(/還沒有 Claude 帳號/); await expect(accounts.env('codex')).rejects.toThrow(/還沒有 Codex 帳號/);
    const work = await accounts.add('claude', '公司 Claude'); const personal = await accounts.add('claude', '個人 Claude');
    expect((await stat(join(root, work.id))).mode & 0o777).toBe(0o700);
    expect(await accounts.env('claude', work.id)).toEqual({ CLAUDE_CONFIG_DIR: join(root, work.id) });
    await expect(accounts.env('codex', work.id)).rejects.toThrow(/不相符/); await expect(accounts.env('claude', 'missing')).rejects.toThrow(/找不到/);
    // 沒選過時用第一個帳號；指定的帳號不存在（例如舊版的 default-claude）時改用選定帳號。
    expect(accounts.selected()).toEqual({ claude: work.id }); expect(accounts.resolve('claude', 'default-claude')).toBe(work.id); expect(accounts.resolve('claude', personal.id)).toBe(personal.id);
    await accounts.rename(personal.id, '個人 2');
    await accounts.select('claude', personal.id);
    // 重新建立服務（模擬重開 VS Code）後名稱與選擇都還在。
    const reopened = new AccountService(storage, root, registry);
    expect(reopened.list().map(item => item.name)).toEqual(['公司 Claude', '個人 2']);
    expect(reopened.selected()).toEqual({ claude: personal.id });
    expect(reopened.terminal(work.id, 'login')).toEqual({ name: 'Claude · 公司 Claude', command: [process.execPath, 'auth', 'login'], env: { CLAUDE_CONFIG_DIR: join(root, work.id) } });
    await reopened.remove(personal.id);
    expect(await readdir(root)).toEqual([work.id]); expect(reopened.selected().claude).toBe(work.id);
  });
  it('adds an account without a name and names it after the signed-in identity, checking only that account', async () => {
    const { root, registry, claude, storage } = await setup();
    const accounts = new AccountService(storage, root, registry);
    const added = await accounts.add('claude');
    expect(added.name).toBe('新帳號'); expect(added.loggedIn).toBeUndefined();
    const before = claude.requests.length;
    await accounts.refresh([added.id]);
    expect(claude.requests.slice(before).map(request => request.env?.CLAUDE_CONFIG_DIR)).toEqual([join(root, added.id)]);
    expect(accounts.loggedIn(added.id)).toBe(true);
    expect(new AccountService(storage, root, registry).list().find(item => item.id === added.id)?.name).toBe(`${added.id}@example.test`);
    // 使用者改過的名稱不會被覆蓋。
    await accounts.rename(added.id, '公司'); await accounts.refresh([added.id]);
    expect(accounts.list().find(item => item.id === added.id)?.name).toBe('公司');
  });
  it('checks each account with its own directory and keeps only public identity fields', async () => {
    const { root, registry, claude } = await setup();
    const accounts = new AccountService(new Memory(), root, registry);
    const signedIn = await accounts.add('claude', 'A'); const signedOut = await accounts.add('claude', 'logged-out B');
    await accounts.refresh();
    const views = accounts.list();
    expect(views.find(item => item.id === signedIn.id)).toMatchObject({ loggedIn: true, account: { email: `${signedIn.id}@example.test` } });
    // 每次檢查都帶帳號自己的目錄，不會去讀官方 CLI 的預設目錄。
        expect(claude.requests.filter(request => request.args.includes('status')).every(request => request.env?.CLAUDE_CONFIG_DIR?.startsWith(root))).toBe(true);
    expect(JSON.stringify(views)).not.toContain('secret-must-not-leak');
    expect(claude.requests.filter(request => request.args.includes('status')).map(request => request.env?.CLAUDE_CONFIG_DIR)).toEqual(expect.arrayContaining([join(root, signedIn.id), join(root, signedOut.id)]));
    void signedOut;
  });
  it('reads Codex usage per account without a model run and keeps Claude usage from the last real run', async () => {
    const { root, registry } = await setup();
    const accounts = new AccountService(new Memory(), root, registry);
    const normal = await accounts.add('codex', 'normal'); const exhausted = await accounts.add('codex', 'exhausted');
    await writeFile(join(root, exhausted.id, 'exhausted'), '');
    await accounts.refresh();
    const codex = accounts.list().find(item => item.id === normal.id)!;
    expect(codex.usage).toMatchObject({ source: 'official', windows: [{ label: '5 小時', usedPercent: 42, resetsAt: 1794632400000 }, { label: '7 天', usedPercent: 7 }] });
    expect(codex.usage?.windows[1]).not.toHaveProperty('resetsAt'); expect(codex.usage?.blocked).toBeUndefined();
    expect(accounts.list().find(item => item.id === exhausted.id)?.usage?.blocked).toBe(true);
    expect(JSON.stringify(accounts.list())).not.toContain('secret-must-not-leak');
    expect(codex.usage?.resetCredits).toBe(2);
    expect(codex.usage?.resetCreditList).toEqual([{ id: 'soon', title: 'Full reset (Weekly + 5 hr)', grantedAt: 1793568435000, expiresAt: 1796160435000 }, { id: 'late', title: 'Full reset (Weekly + 5 hr)', grantedAt: 1794518416000, expiresAt: 1797110416000 }]);
    // Claude 沒有不需推論的查詢：沒有執行前不顯示數字，執行回報後依帳號記錄。
    const claude = await accounts.add('claude', 'Claude'); await accounts.refresh([claude.id]);
    expect(accounts.list().find(item => item.id === claude.id)?.usage).toBeUndefined();
    accounts.recordUsage('claude', claude.id, { windows: [{ label: '5 小時', usedPercent: 25 }], updatedAt: 1, source: 'last-run' });
    expect(accounts.list().find(item => item.id === claude.id)?.usage?.windows[0]?.usedPercent).toBe(25);
    // 定期同步只重讀官方額度，不碰 Claude 執行回報的數字。
    accounts.recordUsage('codex', normal.id, { windows: [], updatedAt: 1, source: 'last-run' });
    await accounts.refreshUsage();
    expect(accounts.list().find(item => item.id === normal.id)?.usage).toMatchObject({ source: 'official', windows: [{ usedPercent: 42 }, { usedPercent: 7 }] });
    expect(accounts.list().find(item => item.id === claude.id)?.usage?.windows[0]?.usedPercent).toBe(25);
  });
  it('keeps the active account per workspace so another window cannot switch it', async () => {
    const { root, registry } = await setup();
    const shared = new Memory(); const tracker = new Memory(); const guild = new Memory();
    const first = new AccountService(shared, root, registry, undefined, tracker);
    const work = await first.add('codex', 'work'); const home = await first.add('codex', 'home');
    // TaskTracker 先用 work；GuildManager 開啟時記下當時的帳號，之後各選各的。
    await first.select('codex', work.id);
    const second = new AccountService(shared, root, registry, undefined, guild);
    expect(second.selected().codex).toBe(work.id);
    await second.select('codex', home.id);
    expect(second.selected().codex).toBe(home.id);
    expect(first.selected().codex).toBe(work.id);
    expect(first.resolve('codex')).toBe(work.id);
    // 新開的工作區沿用最近一次的選擇。
    expect(new AccountService(shared, root, registry, undefined, new Memory()).selected().codex).toBe(home.id);
  });
  it('remembers each account own model, effort and approval mode', async () => {
    const { root, registry } = await setup();
    const storage = new Memory(); const accounts = new AccountService(storage, root, registry);
    const work = await accounts.add('codex', 'work'); const home = await accounts.add('codex', 'home');
    await accounts.setPreferences(work.id, { model: 'gpt', effort: 'high', approvalMode: 'auto-review' });
    // 重新建立服務（重開視窗）後仍保留；另一個帳號不受影響。
    const reopened = new AccountService(storage, root, registry);
    expect(reopened.list().find(item => item.id === work.id)?.preferences).toEqual({ model: 'gpt', effort: 'high', approvalMode: 'auto-review' });
    expect(reopened.preferences(home.id)).toBeUndefined();
    await expect(reopened.setPreferences('missing', { model: 'gpt', effort: 'high', approvalMode: 'ask' })).rejects.toThrow('找不到這個帳號');
  });
  it('uses an official reset credit only when the window is exhausted and refreshes usage afterwards', async () => {
    const { root, registry } = await setup();
    const accounts = new AccountService(new Memory(), root, registry);
    const account = await accounts.add('codex', 'main');
    await accounts.refresh([account.id]);
    await expect(accounts.useResetCredit(account.id)).resolves.toBe('nothingToReset');
    await writeFile(join(root, account.id, 'exhausted'), ''); await accounts.refresh([account.id]);
    expect(accounts.list()[0]!.usage).toMatchObject({ blocked: true, resetCredits: 2 });
    // 指定較晚到期的那張：只用掉它，另一張還在。
    await expect(accounts.useResetCredit(account.id, 'late')).resolves.toBe('reset');
    expect(accounts.list()[0]!.usage?.blocked).toBeUndefined();
    expect(accounts.list()[0]!.usage).toMatchObject({ resetCredits: 1, resetCreditList: [{ id: 'soon' }] });
    await expect(accounts.useResetCredit(account.id, 'late')).resolves.toBe('noCredit');
    await writeFile(join(root, account.id, 'exhausted'), '');
    await expect(accounts.useResetCredit(account.id)).resolves.toBe('reset');
    expect(accounts.list()[0]!.usage).toMatchObject({ resetCredits: 0, resetCreditList: [] });
    // 執行回報沒有張數時沿用官方查詢的值。
    accounts.recordUsage('codex', account.id, { windows: [], updatedAt: 2, source: 'last-run' });
    expect(accounts.list()[0]!.usage).toMatchObject({ resetCredits: 0, resetCreditList: [] });
    const claude = await accounts.add('claude', 'Claude');
    await expect(accounts.useResetCredit(claude.id)).rejects.toThrow('沒有額度重置券');
  });
  it('adds API Key accounts without keeping the key in state or the terminal', async () => {
    const { root, registry, codex } = await setup();
    const storage = new Memory(); const secrets = new Secrets();
    const accounts = new AccountService(storage, root, registry, secrets);
    const claudeKey = `sk-ant-api03-${'a'.repeat(30)}`; const codexKey = `sk-proj-${'b'.repeat(30)}`;
    await expect(accounts.add('claude', 'bad', 'sk-short')).rejects.toThrow(/sk-ant-/);
    await expect(accounts.add('codex', 'bad', `sk-${'c'.repeat(10)} space ${'c'.repeat(10)}`)).rejects.toThrow(/sk-/);
    // Claude：Key 存進鑰匙圈，只在執行時以環境變數提供；終端機與狀態都沒有 Key。
    const api = await accounts.add('claude', 'API', `  ${claudeKey}\n`);
    expect(api.method).toBe('api-key');
    expect(await accounts.env('claude', api.id)).toEqual({ CLAUDE_CONFIG_DIR: join(root, api.id), ANTHROPIC_API_KEY: claudeKey });
    expect(() => accounts.terminal(api.id, 'login')).toThrow(/API Key/);
    // Codex：交給官方 login --with-api-key 從 stdin 讀入並寫進該帳號目錄，Extension 不保存。
    const codexApi = await accounts.add('codex', 'Codex API', codexKey);
    const login = codex.requests.find(request => request.args.includes('--with-api-key'))!;
    expect(login.args).toEqual(['login', '--with-api-key']); expect(login.input).toBe(codexKey); expect(login.args.join(' ')).not.toContain(codexKey);
    expect(login.env?.CODEX_HOME).toBe(join(root, codexApi.id));
    expect(await readFile(join(root, codexApi.id, 'auth.json'), 'utf8')).toContain(codexKey);
    expect(await accounts.env('codex', codexApi.id)).toEqual({ CODEX_HOME: join(root, codexApi.id) });
    expect([...secrets.values.keys()]).toEqual([`multiAgent.apiKey.${api.id}`]);
    // CLI 拒絕的 Key 不留下帳號或目錄。
    await expect(accounts.add('codex', 'rejected', `sk-rejected-${'d'.repeat(20)}`)).rejects.toThrow(/沒有接受/);
    expect(accounts.list().map(item => item.name)).not.toContain('rejected'); expect((await readdir(root)).sort()).toEqual([api.id, codexApi.id].sort());
    expect(JSON.stringify(storage.value)).not.toMatch(/sk-ant|sk-proj/); expect(JSON.stringify(accounts.list())).not.toMatch(/sk-ant|sk-proj/);
    await accounts.remove(api.id);
    expect(secrets.values.size).toBe(0);
  });
});
