import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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
class Memory { value: unknown; get<T>() { return this.value as T; } async update(_key: string, value: unknown) { this.value = JSON.parse(JSON.stringify(value)); } }
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'multi-agent-accounts-')); dirs.push(root);
  const claude = new Fixture('claude'); const codex = new Fixture('codex');
  const registry = new AgentRegistry([new ClaudeCodeAdapter(claude, () => process.execPath, process.cwd()), new CodexAppServerAdapter(codex, () => process.execPath, process.cwd())]);
  await registry.detect();
  return { root, claude, storage: new Memory(), registry, service: (storage = new Memory()) => new AccountService(storage, root, registry) };
}

describe('Multiple official CLI accounts', () => {
  it('names extra accounts, gives each its own CLI directory, and resolves the account for each step', async () => {
    const { root, registry, storage } = await setup();
    const accounts = new AccountService(storage, root, registry);
    expect(accounts.list().map(item => [item.id, item.name, item.builtIn])).toEqual([[defaultAccountId('codex'), '預設帳號', true], [defaultAccountId('claude'), '預設帳號', true]]);
    const work = await accounts.add('claude', '公司 Claude'); const personal = await accounts.add('claude', '個人 Claude');
    expect((await stat(join(root, work.id))).mode & 0o777).toBe(0o700);
    expect(accounts.env('claude', work.id)).toEqual({ CLAUDE_CONFIG_DIR: join(root, work.id) });
    expect(accounts.env('claude', defaultAccountId('claude'))).toBeUndefined(); expect(accounts.env('claude')).toBeUndefined();
    expect(() => accounts.env('codex', work.id)).toThrow(/不相符/); expect(() => accounts.env('claude', 'missing')).toThrow(/找不到/);
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
});
