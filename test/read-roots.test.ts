import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedFolders, networkBlocked } from '../src/execution/ReadRoots';
import { protectedFiles } from '../src/execution/ExecutionPolicy';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';
import type { Task } from '../src/bridge/messages';
import { resolve } from 'node:path';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
class FixtureProcesses extends ProcessManager {
  readonly requests: ProcessRequest[] = [];
  constructor(readonly provider: string) { super(); }
  override run(request: ProcessRequest) { this.requests.push(request); return super.run({ ...request, command: process.execPath, args: [resolve('test/fixtures/agent.cjs'), this.provider, 'ok', ...request.args] }); }
}

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function folders() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-ws-'))); const outside = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-outside-')));
  dirs.push(workspace, outside);
  await mkdir(join(outside, 'skill')); await writeFile(join(outside, 'skill', 'SKILL.md'), 'x'); await writeFile(join(workspace, 'AGENTS.md'), 'x');
  return { workspace, outside };
}
const tool = (input: string, output: string) => ({ kind: 'tool' as const, id: input, name: 'commandExecution', status: 'done' as const, input, output });

describe('Reading folders outside the workspace', () => {
  it('finds outside folders the sandbox blocked, skipping the workspace and folders already allowed', async () => {
    const { workspace, outside } = await folders();
    const file = join(outside, 'skill', 'SKILL.md');
    const task = { steps: [
      tool(`/bin/bash -c 'cat ${file} ${join(workspace, 'AGENTS.md')}'`, `cat: ${file}: Operation not permitted`),
      tool(`/bin/bash -c 'cat ${join(outside, 'missing.md')}'`, 'Operation not permitted'),
      tool(`cat ${outside}`, 'ok'),
      tool('ls', `ls: ${outside}/skill: Permission denied\nfine ${join(outside, 'other')}`)
    ] } as unknown as Task;
    expect(blockedFolders(task, workspace)).toEqual([join(outside, 'skill')]);
    expect(blockedFolders(task, workspace, [outside])).toEqual([]);
  });
  it('only accepts real folders outside the workspace and passes them to each run', async () => {
    const { workspace, outside } = await folders();
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = { id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { requests.push(request); yield { type: 'complete', taskId: request.taskId }; }, cancel: async () => undefined };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, workspace), workspace, () => true, () => 10000);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    await expect(orchestrator.addReadRoot(homedir())).rejects.toThrow('家目錄');
    await expect(orchestrator.addReadRoot(join(workspace))).rejects.toThrow('重疊');
    await expect(orchestrator.addReadRoot(join(outside, 'skill', 'SKILL.md'))).rejects.toThrow('資料夾');
    await expect(orchestrator.addReadRoot('relative')).rejects.toThrow('完整路徑');
    expect(await orchestrator.addReadRoot(join(outside, 'skill', '..'))).toBe(outside);
    await orchestrator.send('codex', 'read', 'read-only');
    expect(requests[0]?.readRoots).toEqual([outside]);
    // 重新設定工作區授權時保留清單由呼叫端帶入；移除後不再傳給 Agent。
    await orchestrator.removeReadRoot(outside); await orchestrator.send('codex', 'read', 'read-only');
    expect(requests[1]?.readRoots).toBeUndefined(); expect(orchestrator.state.policy).not.toHaveProperty('readRoots');
    await orchestrator.dispose();
  });
  it('gives Codex read-only access and Claude a directory it cannot edit', async () => {
    const codex = new FixtureProcesses('codex'); const claude = new FixtureProcesses('claude');
    const base = { taskId: 't', prompt: 'p', cwd: process.cwd(), timeoutMs: 3000, signal: new AbortController().signal, readRoots: ['/tmp/shared skills'], model: 'test-model', effort: 'low' as const };
    const codexAdapter = new CodexAppServerAdapter(codex, () => process.execPath, process.cwd());
    for await (const event of codexAdapter.execute({ ...base, mode: 'workspace-write', approvalMode: 'ask' })) void event;
    const profile = codex.requests.at(-1)!.args.find(value => value.startsWith('permissions.multi_agent={'))!;
    expect(profile).toContain('"/tmp/shared skills"="read"'); expect(profile).toContain('"."="write"');
    const claudeAdapter = new ClaudeCodeAdapter(claude, () => process.execPath, process.cwd());
    await claudeAdapter.detect();
    for await (const event of claudeAdapter.execute({ ...base, mode: 'workspace-write', model: 'sonnet' })) void event;
    const args = claude.requests.at(-1)!.args;
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/tmp/shared skills');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!).permissions.deny).toEqual(expect.arrayContaining(['Edit(//tmp/shared skills/**)', 'Write(//tmp/shared skills/**)']));
  });
});

describe('Network access for agents', () => {
  it('stays off by default and is turned on per workspace with an audit entry', async () => {
    const { workspace } = await folders();
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = { id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { requests.push(request); yield { type: 'complete', taskId: request.taskId }; }, cancel: async () => undefined };
    const audits: string[] = [];
    const repository = new SessionRepository({ get: () => undefined, update: async () => undefined }, workspace);
    repository.audit = async event => { audits.push(event.detail); };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), repository, workspace, () => true, () => 0);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    await orchestrator.send('codex', 'fetch', 'read-only');
    expect(requests[0]?.network).toBeUndefined();
    await orchestrator.setNetwork(true); await orchestrator.send('codex', 'fetch', 'read-only');
    expect(requests[1]?.network).toBe(true); expect(orchestrator.state.policy.network).toBe(true);
    await orchestrator.setNetwork(false); await orchestrator.send('codex', 'fetch', 'read-only');
    expect(requests[2]?.network).toBeUndefined(); expect(orchestrator.state.policy).not.toHaveProperty('network');
    expect(audits.slice(-2)).toEqual(['允許 Agent 使用網路', '關閉 Agent 網路']);
    await orchestrator.dispose();
  });
  it('opens the Codex sandbox network and web search, and gives Claude web tools, only when allowed', async () => {
    const base = { taskId: 't', prompt: 'p', cwd: process.cwd(), timeoutMs: 3000, signal: new AbortController().signal, model: 'test-model', effort: 'low' as const };
    for (const network of [false, true]) {
      const codex = new FixtureProcesses('codex'); const claude = new FixtureProcesses('claude');
      const codexAdapter = new CodexAppServerAdapter(codex, () => process.execPath, process.cwd());
      for await (const event of codexAdapter.execute({ ...base, mode: 'workspace-write', approvalMode: 'ask', ...(network && { network }) })) void event;
      const args = codex.requests.at(-1)!.args;
      expect(args.find(value => value.startsWith('permissions.multi_agent={'))).toContain(`network={enabled=${network}}`);
      expect(args).toContain(`web_search="${network ? 'live' : 'disabled'}"`);
      const claudeAdapter = new ClaudeCodeAdapter(claude, () => process.execPath, process.cwd()); await claudeAdapter.detect();
      for await (const event of claudeAdapter.execute({ ...base, mode: 'read-only', model: 'sonnet', ...(network && { network }) })) void event;
      const tools = claude.requests.at(-1)!.args[claude.requests.at(-1)!.args.indexOf('--tools') + 1];
      expect(tools).toBe(network ? 'Read,Glob,Grep,WebFetch,WebSearch' : 'Read,Glob,Grep');
    }
  });
  it('recognizes commands that failed for lack of network', () => {
    const task = (output: string) => ({ id: 't', provider: 'codex', mode: 'read-only', prompt: '', output: '', status: 'completed', startedAt: 1, steps: [tool('curl https://example.com', output)] }) as Task;
    expect(networkBlocked(task('curl: (6) Could not resolve host: example.com'))).toBe(true);
    expect(networkBlocked(task('Error: getaddrinfo ENOTFOUND registry.npmjs.org'))).toBe(true);
    expect(networkBlocked(task('HTTP/2 200'))).toBe(false);
  });
});

describe('Optional agent features', () => {
  it('keeps every feature off by default and records each change', async () => {
    const { workspace } = await folders();
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = { id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { requests.push(request); yield { type: 'complete', taskId: request.taskId }; }, cancel: async () => undefined };
    const audits: string[] = [];
    const repository = new SessionRepository({ get: () => undefined, update: async () => undefined }, workspace);
    repository.audit = async event => { audits.push(event.detail); };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), repository, workspace, () => true, () => 0);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    await orchestrator.send('codex', 'x', 'read-only'); expect(requests[0]?.features).toBeUndefined();
    await orchestrator.setFeature('mcp', true); await orchestrator.setFeature('apps', true); await orchestrator.setFeature('apps', true);
    await orchestrator.send('codex', 'x', 'read-only'); expect(requests[1]?.features).toEqual(['apps', 'mcp']);
    await orchestrator.setFeature('apps', false); await orchestrator.setFeature('mcp', false);
    expect(orchestrator.state.policy).not.toHaveProperty('features');
    expect(audits.slice(-4)).toEqual(['開放 Agent 功能：mcp', '開放 Agent 功能：apps', '關閉 Agent 功能：apps', '關閉 Agent 功能：mcp']);
    await orchestrator.dispose();
  });
  it('passes only the opened features to the Codex and Claude CLIs', async () => {
    const base = { taskId: 't', prompt: 'p', cwd: process.cwd(), timeoutMs: 3000, signal: new AbortController().signal, model: 'test-model', effort: 'low' as const };
    const run = async (features?: AgentRequest['features']) => {
      const codex = new FixtureProcesses('codex'); const claude = new FixtureProcesses('claude');
      const codexAdapter = new CodexAppServerAdapter(codex, () => process.execPath, process.cwd()); await codexAdapter.detect();
      for await (const event of codexAdapter.execute({ ...base, mode: 'workspace-write', approvalMode: 'ask', ...(features && { features }) })) void event;
      const claudeAdapter = new ClaudeCodeAdapter(claude, () => process.execPath, process.cwd()); await claudeAdapter.detect();
      for await (const event of claudeAdapter.execute({ ...base, mode: 'read-only', model: 'sonnet', ...(features && { features }) })) void event;
      return { codex: codex.requests.at(-1)!.args, claude: claude.requests.at(-1)!.args };
    };
    const closed = await run();
    expect(closed.codex).toEqual(expect.arrayContaining(['mcp_servers={}', 'features.apps=false', 'features.plugins=false', 'features.hooks=false']));
    expect(closed.claude).toEqual(expect.arrayContaining(['--safe-mode', '--strict-mcp-config', '--disable-slash-commands']));
    expect(JSON.parse(closed.claude[closed.claude.indexOf('--settings') + 1]!)).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
    const open = await run(['apps', 'mcp', 'subagents', 'memory', 'hooks', 'commands']);
    // Codex：不再強制清空 MCP、關掉外掛與 hooks，個別功能改成 true。
    expect(open.codex).not.toContain('mcp_servers={}'); expect(open.codex).not.toContain('features.apps=false'); expect(open.codex).not.toContain('features.hooks=false');
    // Claude：拿掉 safe-mode、空 MCP 與停用斜線指令，加入 Agent 工具與記憶；仍保留 --restricted 與 hooks 關閉。
    expect(open.claude).not.toContain('--safe-mode'); expect(open.claude).not.toContain('--strict-mcp-config'); expect(open.claude).not.toContain('--disable-slash-commands');
    expect(open.claude).toContain('--restricted'); expect(open.claude[open.claude.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Agent');
    expect(JSON.parse(open.claude[open.claude.indexOf('--settings') + 1]!)).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: true });
  });
});

describe('Protected secret files for Codex', () => {
  it('denies the secret files that exist instead of wildcard rules, so folders stay removable', async () => {
    const { workspace } = await folders();
    await writeFile(join(workspace, '.env'), 'x'); await mkdir(join(workspace, 'config')); await writeFile(join(workspace, 'config', 'server.key'), 'x');
    await mkdir(join(workspace, '.ssh')); await writeFile(join(workspace, '.ssh', 'id'), 'x');
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true }); await writeFile(join(workspace, 'node_modules', 'pkg', '.env'), 'x');
    await mkdir(join(workspace, 'dist', 'admin'), { recursive: true }); await writeFile(join(workspace, 'dist', 'admin', 'index.html'), 'x');
    expect(protectedFiles(workspace).sort()).toEqual(['.env', '.ssh', 'config/server.key']);
    const codex = new FixtureProcesses('codex');
    const adapter = new CodexAppServerAdapter(codex, () => process.execPath, workspace);
    for await (const event of adapter.execute({ taskId: 't', prompt: 'p', cwd: workspace, timeoutMs: 3000, signal: new AbortController().signal, mode: 'workspace-write', approvalMode: 'ask', model: 'test-model', effort: 'low' })) void event;
    const profile = codex.requests.at(-1)!.args.find(value => value.startsWith('permissions.multi_agent={'))!;
    expect(profile).toContain('".env"="deny"'); expect(profile).toContain('"config/server.key"="deny"'); expect(profile).toContain('".ssh"="deny"');
    expect(profile).not.toContain('**');
  });
});
