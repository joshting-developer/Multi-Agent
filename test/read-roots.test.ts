import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockedFolders } from '../src/execution/ReadRoots';
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
