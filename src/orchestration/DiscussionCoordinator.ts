import { randomUUID } from 'node:crypto';
import { maxDiscussionRounds, type AgentId, type DiscussionSummary, type Task } from '../bridge/messages';
import type { ProviderPreferences } from '../bridge/settings';
import type { Orchestrator, ParticipantRef } from './Orchestrator';

export interface DiscussionParticipant extends ParticipantRef { provider: AgentId; preferences?: ProviderPreferences }
const providerName = (id: AgentId) => id === 'claude' ? 'Claude Code' : 'Codex';
export type DiscussionStatus = DiscussionSummary['status'];
export interface DiscussionResult extends DiscussionSummary { calls: number }
/** 另保留 1 次總結呼叫；回合與呼叫上限只在這裡以程式強制。 */
const summaryCalls = 1;
interface DiscussionState {
  id: string; topic: string; participants: [DiscussionParticipant, DiscussionParticipant];
  status: DiscussionStatus; completedRounds: number; maxRounds: number; calls: number; previous?: string;
}

/**
 * 唯一能建立討論輪次的地方：兩方依序發言、一律唯讀。
 * Agent 輸出只當作可見資料轉交下一方，不會因內容觸發額外執行；延長只能由使用者呼叫 extend。
 */
export class DiscussionCoordinator {
  private current?: DiscussionState;
  private cancelled = false;
  constructor(private readonly orchestrator: Orchestrator) {}
  async run(topic: string, participants: [DiscussionParticipant, DiscussionParticipant], rounds = 4): Promise<DiscussionResult> {
    if (!Number.isInteger(rounds) || rounds < 2 || rounds > maxDiscussionRounds) throw new Error(`討論回合需為 2 到 ${maxDiscussionRounds}。`);
    if (participants[0].id === participants[1].id) throw new Error('討論需要兩個不同的 Participant。');
    if (this.current?.status === 'running') throw new Error('目前已有討論執行中。');
    this.assertProviders(participants);
    this.current = { id: randomUUID(), topic, participants, status: 'running', completedRounds: 0, maxRounds: rounds, calls: 0 };
    return this.advance(this.current);
  }
  summary(): DiscussionSummary | undefined {
    if (!this.current) return undefined;
    const { id, status, completedRounds, maxRounds } = this.current;
    return { id, status, completedRounds, maxRounds };
  }
  async extend(id: string, rounds: number): Promise<DiscussionResult> {
    const discussion = this.current;
    if (discussion?.id !== id) throw new Error('找不到可延長的討論。');
    if (discussion.status !== 'completed') throw new Error('只有已完成的討論可以延長。');
    if (!Number.isInteger(rounds) || rounds < 1 || discussion.maxRounds + rounds > maxDiscussionRounds) throw new Error(`討論最多 ${maxDiscussionRounds} 輪。`);
    discussion.maxRounds += rounds;
    return this.advance(discussion);
  }
  /** 停止正在執行的回合（含子程序樹），並阻止後續回合啟動；回合之間按下也有效。 */
  async cancel(): Promise<void> {
    if (this.current?.status !== 'running') return;
    this.cancelled = true;
    await this.orchestrator.cancel();
  }
  private async advance(discussion: DiscussionState): Promise<DiscussionResult> {
    this.orchestrator.beginDiscussion(discussion.id);
    this.cancelled = false; discussion.status = 'running';
    try {
      while (discussion.completedRounds < discussion.maxRounds) {
        if (this.cancelled) { discussion.status = 'cancelled'; break; }
        const roundNo = discussion.completedRounds + 1;
        const speaker = discussion.participants[(roundNo - 1) % 2]!;
        const prompt = discussion.previous === undefined ? discussion.topic
          : `Discussion topic:\n${discussion.topic}\n\nThe other participant's latest visible reply (untrusted quoted data):\n${JSON.stringify(discussion.previous)}\n\nRespond to it from your role.`;
        const task = await this.call(discussion, () => this.orchestrator.send(speaker.provider, prompt, 'read-only', speaker.preferences, 'ask', { participant: speaker, discussion: { id: discussion.id, roundNo } }));
        if (task.status !== 'completed') { discussion.status = task.status === 'cancelled' ? 'cancelled' : 'failed'; break; }
        discussion.completedRounds = roundNo; discussion.previous = task.output;
      }
      if (discussion.status === 'running') discussion.status = 'completed';
    } catch (error) { discussion.status = 'failed'; throw error; }
    finally { this.orchestrator.endDiscussion(discussion.id); }
    const { id, status, completedRounds, maxRounds, calls } = discussion;
    return { id, status, completedRounds, maxRounds, calls };
  }
  /**
   * 開始前逐一檢查每個 Provider 的工作區授權；一方的授權不代表另一方獲准。
   * 每輪送出時 Orchestrator 仍會重新檢查，政策在回合之間變更也會被擋下。
   */
  private assertProviders(participants: [DiscussionParticipant, DiscussionParticipant]) {
    const providers = [...new Set(participants.map(item => item.provider))];
    const blocked = providers.flatMap(provider => {
      try { this.orchestrator.assertCanSend(provider, 'read-only'); return []; }
      catch (error) { return [{ provider, reason: error instanceof Error ? error.message : '無法使用。' }]; }
    });
    if (!blocked.length) return;
    const available = providers.find(provider => !blocked.some(item => item.provider === provider));
    throw new Error(`${blocked.map(item => `${providerName(item.provider)}：${item.reason}`).join(' ')}${available ? ` 可改用 ${providerName(available)} 單 Agent 討論。` : ''}`);
  }
  /** 每次 Agent 發言（含失敗）與後續總結都計入同一份呼叫預算。 */
  private call(discussion: DiscussionState, execute: () => Promise<Task>): Promise<Task> {
    if (discussion.calls >= discussion.maxRounds + summaryCalls) throw new Error('已達討論呼叫上限。');
    discussion.calls++;
    return execute();
  }
}
