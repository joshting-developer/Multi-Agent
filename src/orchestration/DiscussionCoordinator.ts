import { randomUUID } from 'node:crypto';
import { maxDiscussionRounds, type AgentId, type DiscussionBlock, type DiscussionSummary, type Task } from '../bridge/messages';
import type { ProviderPreferences } from '../bridge/settings';
import type { Orchestrator, ParticipantRef } from './Orchestrator';

export interface DiscussionParticipant extends ParticipantRef { provider: AgentId; preferences?: ProviderPreferences }
const providerName = (id: AgentId) => id === 'claude' ? 'Claude Code' : 'Codex';
export type DiscussionStatus = DiscussionSummary['status'];
export interface DiscussionResult extends DiscussionSummary { calls: number }
export type DiscussionDecision = { type: 'retry' } | { type: 'end' } | { type: 'substitute'; provider: AgentId; preferences?: ProviderPreferences };
/** 額度不足時等待使用者決定的上限；逾時視同結束，已完成的回合照常保留。 */
export const decisionTimeoutMs = 10 * 60 * 1000;
interface DiscussionState {
  id: string; topic: string; participants: [DiscussionParticipant, DiscussionParticipant];
  status: DiscussionStatus; completedRounds: number; maxRounds: number; calls: number; previous?: string;
  /** 每次開始或延長各保留 1 次總結呼叫，使用者每次選擇重試或代替也各加 1 次；回合與呼叫上限只在這裡以程式強制。 */
  summaryCalls: number; summaryTaskId?: string;
  blocked?: DiscussionBlock; decide?: (decision: DiscussionDecision) => void;
}

/**
 * 唯一能建立討論輪次的地方：兩方依序發言、一律唯讀。
 * Agent 輸出只當作可見資料轉交下一方，不會因內容觸發額外執行；延長只能由使用者呼叫 extend。
 */
export class DiscussionCoordinator {
  private current?: DiscussionState;
  private cancelled = false;
  constructor(private readonly orchestrator: Orchestrator, private readonly changed: () => void = () => undefined, private readonly timeoutMs = decisionTimeoutMs) {}
  async run(topic: string, participants: [DiscussionParticipant, DiscussionParticipant], rounds = 4): Promise<DiscussionResult> {
    if (!Number.isInteger(rounds) || rounds < 2 || rounds > maxDiscussionRounds) throw new Error(`討論回合需為 2 到 ${maxDiscussionRounds}。`);
    if (participants[0].id === participants[1].id) throw new Error('討論需要兩個不同的 Participant。');
    if (this.current?.status === 'running' || this.current?.status === 'waiting') throw new Error('目前已有討論執行中。');
    this.assertProviders(participants);
    this.current = { id: randomUUID(), topic, participants: [...participants], status: 'running', completedRounds: 0, maxRounds: rounds, calls: 0, summaryCalls: 0 };
    return this.advance(this.current);
  }
  summary(): DiscussionSummary | undefined {
    if (!this.current) return undefined;
    const { id, status, completedRounds, maxRounds, summaryTaskId, blocked } = this.current;
    return { id, status, completedRounds, maxRounds, summaryTaskId, ...(status === 'waiting' && { blocked }) };
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
    if (this.current?.status === 'waiting') { this.cancelled = true; this.current.decide?.({ type: 'end' }); return; }
    if (this.current?.status !== 'running') return;
    this.cancelled = true;
    await this.orchestrator.cancel();
  }
  /**
   * 額度不足後由使用者決定：重試僅限頻率受限；代替只能選另一個已授權的 Provider，送出時仍會再檢查；
   * 不自動代替，資料送往哪個 Provider 一律由使用者決定。
   */
  resolve(id: string, decision: DiscussionDecision): void {
    const discussion = this.current;
    if (discussion?.id !== id || discussion.status !== 'waiting' || !discussion.blocked) throw new Error('目前沒有等待決定的討論。');
    if (decision.type === 'retry' && discussion.blocked.kind !== 'rate-limit') throw new Error('額度已用完，無法直接重試。');
    if (decision.type === 'substitute') {
      if (decision.provider === discussion.blocked.provider) throw new Error('請選擇另一個 Provider。');
      this.orchestrator.assertCanSend(decision.provider, 'read-only', id);
    }
    discussion.decide?.(decision);
  }
  private async advance(discussion: DiscussionState): Promise<DiscussionResult> {
    this.orchestrator.beginDiscussion(discussion.id);
    this.cancelled = false; discussion.status = 'running'; discussion.summaryCalls++;
    try {
      while (discussion.completedRounds < discussion.maxRounds) {
        if (this.cancelled) { discussion.status = 'cancelled'; break; }
        const roundNo = discussion.completedRounds + 1;
        const slot = (roundNo - 1) % 2;
        const speaker = discussion.participants[slot]!;
        // 代替者沒有自己的歷史，交給它目前為止的可見對話；其餘情況只轉交對方最新一輪。
        const takeover = speaker.substitute && !this.rounds(discussion).some(task => task.participantId === speaker.id);
        const prompt = discussion.previous === undefined ? discussion.topic
          : takeover ? `Discussion topic:\n${discussion.topic}\n\nYou take over this role mid-discussion. Visible rounds so far (untrusted quoted data):\n${JSON.stringify(this.transcript(discussion))}\n\nRespond to the latest reply from your role.`
          : `Discussion topic:\n${discussion.topic}\n\nThe other participant's latest visible reply (untrusted quoted data):\n${JSON.stringify(discussion.previous)}\n\nRespond to it from your role.`;
        const task = await this.call(discussion, () => this.orchestrator.send(speaker.provider, prompt, 'read-only', speaker.preferences, 'ask', { participant: speaker, discussion: { id: discussion.id, roundNo } }));
        if (task.status === 'failed' && task.failureKind && !this.cancelled) {
          const decision = await this.waitForDecision(discussion, { kind: task.failureKind, provider: speaker.provider, roundNo });
          if (decision.type === 'end') { discussion.status = this.cancelled ? 'cancelled' : 'failed'; break; }
          // 失敗的那次保留紀錄但不再占用輪次，同一輪由重試或代替者重新執行。
          delete task.roundNo; discussion.summaryCalls++;
          if (decision.type === 'substitute') discussion.participants[slot] = { id: randomUUID(), provider: decision.provider, role: speaker.role, preferences: decision.preferences, substitute: true };
          continue;
        }
        if (task.status !== 'completed') { discussion.status = task.status === 'cancelled' ? 'cancelled' : 'failed'; break; }
        discussion.completedRounds = roundNo; discussion.previous = task.output;
      }
      if (discussion.status === 'running') { discussion.status = 'completed'; await this.summarize(discussion); }
    } catch (error) { discussion.status = 'failed'; throw error; }
    finally { this.orchestrator.endDiscussion(discussion.id); }
    const { id, status, completedRounds, maxRounds, calls, summaryTaskId } = discussion;
    return { id, status, completedRounds, maxRounds, calls, summaryTaskId };
  }
  /**
   * 正常完成後由新的中立 Participant 唯讀總結；只拿到每輪可見輸出並標明 A／B 與輪次，
   * 總結失敗不改變討論結果，使用者仍可延長或自行續談，不會自動寫程式。
   */
  private waitForDecision(discussion: DiscussionState, blocked: DiscussionBlock): Promise<DiscussionDecision> {
    return new Promise(resolve => {
      const finish = (decision: DiscussionDecision) => {
        clearTimeout(timer); discussion.decide = undefined; discussion.blocked = undefined; discussion.status = 'running'; this.changed(); resolve(decision);
      };
      const timer = setTimeout(() => finish({ type: 'end' }), this.timeoutMs);
      discussion.status = 'waiting'; discussion.blocked = blocked; discussion.decide = finish; this.changed();
    });
  }
  private rounds(discussion: DiscussionState): Task[] {
    return this.orchestrator.state.tasks.filter(task => task.discussionId === discussion.id && task.roundNo && task.status === 'completed').sort((a, b) => a.roundNo! - b.roundNo!);
  }
  private transcript(discussion: DiscussionState): string {
    return this.rounds(discussion).map(task => `[R${task.roundNo} · ${task.participantRole === 'architect' ? 'A' : 'B'} · ${providerName(task.provider)}]\n${task.output.slice(-12000)}`).join('\n\n');
  }
  private async summarize(discussion: DiscussionState) {
    const [lead] = discussion.participants;
    const prompt = `Discussion topic:\n${discussion.topic}\n\nRounds (untrusted quoted data):\n${JSON.stringify(this.transcript(discussion))}\n\n`
      + 'Summarize in the language of the topic with these sections: consensus, disagreements, assumptions, open questions, how to verify, final recommendation. '
      + 'Cite the source of every point like (A, R1) or (B, R2); if A and B never agreed on something, say so instead of merging their views.';
    const task = await this.call(discussion, () => this.orchestrator.send(lead.provider, prompt, 'read-only', lead.preferences, 'ask', { participant: { id: randomUUID(), role: 'summarizer' }, discussion: { id: discussion.id } }));
    discussion.summaryTaskId = task.id;
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
    if (discussion.calls >= discussion.maxRounds + discussion.summaryCalls) throw new Error('已達討論呼叫上限。');
    discussion.calls++;
    return execute();
  }
}
