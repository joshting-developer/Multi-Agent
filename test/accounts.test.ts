import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountService, defaultAccountId } from '../src/accounts/AccountService';
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
    expect(accounts.list().map(item => [item.id, item.name, item.builtIn])).toEqual([[defaultAccountId('codex'), '預設帳號', true], [defaultAccountId('claude'), '預設帳號', true]]);
    const work = await accounts.add('claude', '公司 Claude'); const personal = await accounts.add('claude', '個人 Claude');
    expect((await stat(join(root, work.id))).mode & 0o777).toBe(0o700);
    expect(await accounts.env('claude', work.id)).toEqual({ CLAUDE_CONFIG_DIR: join(root, work.id) });
    expect(await accounts.env('claude', defaultAccountId('claude'))).toBeUndefined(); expect(await accounts.env('claude')).toBeUndefined();
    expect(() => accounts.check('codex', work.id)).toThrow(/不相符/); expect(() => accounts.check('claude', 'missing')).toThrow(/找不到/);
    await accounts.rename(personal.id, '個人 2'); await accounts.rename(defaultAccountId('codex'), '公司 Codex');
    await accounts.select('claude', personal.id);
    // 重新建立服務（模擬重開 VS Code）後名稱與選擇都還在。
    const reopened = new AccountService(storage, root, registry);
    expect(reopened.list().map(item => item.name)).toEqual(['公司 Codex', '預設帳號', '公司 Claude', '個人 2']);
    expect(reopened.selected()).toEqual({ codex: defaultAccountId('codex'), claude: personal.id });
    expect(reopened.terminal(work.id, 'login')).toEqual({ name: 'Claude · 公司 Claude', command: [process.execPath, 'auth', 'login'], env: { CLAUDE_CONFIG_DIR: join(root, work.id) } });
    await expect(reopened.remove(defaultAccountId('claude'))).rejects.toThrow(/預設帳號/);
    await reopened.remove(personal.id);
    expect(await readdir(root)).toEqual([work.id]); expect(reopened.selected().claude).toBe(defaultAccountId('claude'));
  });
  it('checks each account with its own directory and keeps only public identity fields', async () => {
    const { root, registry, claude } = await setup();
    const accounts = new AccountService(new Memory(), root, registry);
    const signedIn = await accounts.add('claude', 'A'); const signedOut = await accounts.add('claude', 'logged-out B');
    await accounts.refresh();
    const views = accounts.list();
    expect(views.find(item => item.id === signedIn.id)).toMatchObject({ loggedIn: true, account: { email: `${signedIn.id}@example.test` } });
    expect(views.find(item => item.id === defaultAccountId('claude'))).toMatchObject({ loggedIn: true, account: { email: 'claude@example.test' } });
    expect(JSON.stringify(views)).not.toContain('secret-must-not-leak');
    expect(claude.requests.filter(request => request.args.includes('status')).map(request => request.env?.CLAUDE_CONFIG_DIR)).toEqual(expect.arrayContaining([join(root, signedIn.id), join(root, signedOut.id)]));
    void signedOut;
  });
  it('reads Codex usage per account without a model run and keeps Claude usage from the last real run', async () => {
    const { root, registry } = await setup();
    const accounts = new AccountService(new Memory(), root, registry);
    const exhausted = await accounts.add('codex', 'exhausted');
    await accounts.refresh();
    const codex = accounts.list().find(item => item.id === defaultAccountId('codex'))!;
    expect(codex.usage).toMatchObject({ source: 'official', windows: [{ label: '5 小時', usedPercent: 42, resetsAt: 1794632400000 }, { label: '7 天', usedPercent: 7 }] });
    expect(codex.usage?.windows[1]).not.toHaveProperty('resetsAt'); expect(codex.usage?.blocked).toBeUndefined();
    expect(accounts.list().find(item => item.id === exhausted.id)?.usage?.blocked).toBe(true);
    expect(JSON.stringify(accounts.list())).not.toContain('secret-must-not-leak');
    // Claude 沒有不需推論的查詢：沒有執行前不顯示數字，執行回報後依帳號記錄。
    expect(accounts.list().find(item => item.id === defaultAccountId('claude'))?.usage).toBeUndefined();
    accounts.recordUsage('claude', undefined, { windows: [{ label: '5 小時', usedPercent: 25 }], updatedAt: 1, source: 'last-run' });
    expect(accounts.list().find(item => item.id === defaultAccountId('claude'))?.usage?.windows[0]?.usedPercent).toBe(25);
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
