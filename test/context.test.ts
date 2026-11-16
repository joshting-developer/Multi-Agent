import { describe, expect, it } from 'vitest';
import { buildContext, contextBudget } from '../src/orchestration/ContextBuilder';
import type { Task } from '../src/bridge/messages';

const turn = (index: number, extra: Partial<Task> = {}): Task => ({
  id: `task-${String(index).padStart(4, '0')}-xxxx`, provider: 'claude', mode: 'read-only', status: 'completed', startedAt: Date.UTC(2026, 10, 14, 0, index),
  prompt: `question ${index}`, output: `answer ${index} `.repeat(400), ...extra
});

describe('Conversation context builder', () => {
  it('carries messages added while the agent was working as part of what the user said', () => {
    const { prompt } = buildContext([turn(1, { steps: [{ kind: 'text', text: 'working' }, { kind: 'steer', text: 'also add tests', at: 1 }] })], 'next');
    expect(prompt).toContain('question 1\\n[added while the agent was working] also add tests');
  });
  it('sends the current message alone when there is no history', () => {
    expect(buildContext([], 'hello')).toEqual({ prompt: 'hello', contextIds: [] });
  });
  it('keeps a long conversation within budget, newest first, and reports what was included', () => {
    const history = Array.from({ length: 40 }, (_, index) => turn(index));
    const { prompt, contextIds } = buildContext(history, 'current question');
    const quoted = prompt.slice(prompt.indexOf('\n') + 1, prompt.indexOf('\n\nCurrent user message:'));
    expect(quoted.length).toBeLessThanOrEqual(contextBudget + 100);
    expect(contextIds.at(-1)).toBe(history.at(-1)!.id); expect(contextIds.length).toBeLessThan(40);
    expect(prompt).toMatch(/\d+ older turns are not included\./); expect(prompt).toContain('question 39'); expect(prompt).not.toContain('"question 0"');
    expect(prompt.endsWith('Current user message:\ncurrent question')).toBe(true);
    // 預算不足時先保留使用者訊息，舊回答標成省略而不是整段截斷。
    expect(prompt).toContain('answer omitted to fit the context budget');
  });
  it('labels earlier answers as unverified and never re-sends a rejected answer', () => {
    const { prompt, contextIds } = buildContext([turn(1, { output: 'WRONG-CONCLUSION-42', rejected: true }), turn(2, { output: 'kept answer' })], 'next');
    expect(prompt).not.toContain('WRONG-CONCLUSION-42'); expect(prompt).toContain('answer rejected by the user');
    expect(prompt).toContain('question 1'); expect(prompt).toContain('kept answer'); expect(prompt).toContain('may be wrong');
    expect(contextIds).toEqual(['task-0001-xxxx', 'task-0002-xxxx']);
  });
});
