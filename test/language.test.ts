import { describe, expect, it } from 'vitest';
import { languageInstruction } from '../src/bridge/preferences';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository } from '../src/storage/SessionRepository';
import type { AgentAdapter, AgentRequest } from '../src/agents/AgentAdapter';

describe('Reply language', () => {
  it('follows the VS Code display language unless a language is chosen or turned off', () => {
    expect(languageInstruction('auto', 'zh-tw')).toContain('Traditional Chinese (Taiwan)');
    expect(languageInstruction('auto', 'zh-cn')).toContain('Simplified Chinese');
    expect(languageInstruction('auto', 'fr')).toContain('"fr"');
    expect(languageInstruction('en', 'zh-tw')).toContain('in English');
    expect(languageInstruction('zh-TW', 'en')).toContain('Traditional Chinese (Taiwan)');
    expect(languageInstruction('none', 'zh-tw')).toBeUndefined();
  });
  it('adds the instruction to what the agent receives without changing the saved prompt', async () => {
    const requests: AgentRequest[] = [];
    const capabilities = { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, structuredOutput: true, toolApproval: false };
    const adapter: AgentAdapter = { id: 'codex', capabilities: () => capabilities, detect: async () => ({ id: 'codex', status: 'ready', capabilities }),
      async *execute(request) { requests.push(request); yield { type: 'complete', taskId: request.taskId }; }, cancel: async () => undefined };
    const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, '/workspace'), '/workspace', () => true, () => 10000);
    await orchestrator.setPolicy({ classification: 'personal', allowedProviders: ['codex'] }); await orchestrator.checkProviders();
    let setting: 'zh-TW' | 'none' = 'zh-TW';
    orchestrator.languageInstruction = () => languageInstruction(setting, 'en');
    const task = await orchestrator.send('codex', '再看一次', 'read-only');
    expect(requests[0]!.prompt.startsWith('Reply to the user in Traditional Chinese (Taiwan).')).toBe(true);
    expect(requests[0]!.prompt.endsWith('再看一次')).toBe(true); expect(task.prompt).toBe('再看一次');
    setting = 'none'; await orchestrator.send('codex', 'again', 'read-only');
    expect(requests[1]!.prompt).not.toContain('Reply to the user');
    await orchestrator.dispose();
  });
});
