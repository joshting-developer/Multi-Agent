import { randomUUID } from 'node:crypto';
import type { AgentId, ExecutionMode, HybridSummary, Task } from '../bridge/messages';
import type { ApprovalMode, ProviderPreferences } from '../bridge/settings';
import { providerLabel } from '../bridge/labels';
import type { Orchestrator } from './Orchestrator';

/** 參與混合任務的一個帳號與模型；label 是畫面上顯示的名稱。 */
export interface HybridMemberInput { provider: AgentId; preferences?: ProviderPreferences; approvalMode?: ApprovalMode; label: string }
export const maxHybridMembers = 4;
/** 完整存取需要逐次原生確認，混合模式不代為開啟，改用要求核准。 */
const safe = (mode: ApprovalMode): ApprovalMode => mode === 'full-access' ? 'ask' : mode;
export const maxHybridSteps = 6;
/** 交給下一個成員或 review 的前面成果，每個環節最多保留的長度。 */
const resultLimit = 6000;
interface Member extends HybridMemberInput { left?: string }
interface PlanStep { title: string; instruction: string; member: number; status: 'pending' | 'running' | 'done' | 'failed'; output?: string; by?: number }
interface HybridState { id: string; request: string; mode: ExecutionMode; approvalMode: ApprovalMode; members: Member[]; lead: number; steps: PlanStep[]; status: HybridSummary['status']; stage: HybridSummary['stage']; shown: boolean }

/**
 * 混合模式：主帳號先規劃並分派環節，成員依序執行，最後其他成員 review、主帳號寫結論。
 * 一次仍只執行一個成員；成員失敗（額度用完、頻率受限或執行失敗）就標成離開，它的環節改交給其他成員。
 * Agent 的輸出只當作資料轉交，環節數與成員數在這裡以程式設上限。
 */
export class HybridCoordinator {
  private current?: HybridState;
  private cancelled = false;
  constructor(private readonly orchestrator: Orchestrator, private readonly changed: () => void = () => undefined) {}
  get running(): boolean { return this.current?.status === 'running'; }
  summary(): HybridSummary | undefined {
    const state = this.current;
    if (!state) return undefined;
    return { id: state.id, status: state.status, stage: state.stage,
      members: state.members.map((member, index) => ({ label: member.label, provider: member.provider, ...(index === state.lead && { lead: true }), ...(member.left && { left: member.left }) })),
      steps: state.steps.map(step => ({ title: step.title, member: step.by ?? step.member, status: step.status })) };
  }
  async run(request: string, members: HybridMemberInput[], lead: number, mode: ExecutionMode, approvalMode: ApprovalMode = 'ask'): Promise<HybridSummary> {
    if (members.length < 2 || members.length > maxHybridMembers) throw new Error(`混合模式需要 2 到 ${maxHybridMembers} 個成員。`);
    if (!Number.isInteger(lead) || lead < 0 || lead >= members.length) throw new Error('請指定主帳號。');
    if (this.running) throw new Error('目前已有混合任務執行中。');
    if (this.orchestrator.busy) throw new Error('請先等目前任務完成或停止。');
    // 每個成員的 Provider 各自檢查工作區授權；一方獲准不代表另一方。
    for (const provider of new Set(members.map(member => member.provider))) this.orchestrator.assertCanSend(provider, provider === members[lead]!.provider ? 'read-only' : mode);
    const state: HybridState = { id: randomUUID(), request, mode, approvalMode, members: members.map(member => ({ ...member })), lead, steps: [], status: 'running', stage: 'plan', shown: false };
    this.current = state; this.cancelled = false;
    this.orchestrator.beginDiscussion(state.id);
    try {
      await this.plan(state);
      if (state.status === 'running') await this.execute(state);
      if (state.status === 'running') await this.review(state);
      if (state.status === 'running') state.status = 'completed';
    } catch (error) { state.status = this.cancelled ? 'cancelled' : 'failed'; throw error; }
    finally { this.orchestrator.endDiscussion(state.id); this.changed(); }
    return this.summary()!;
  }
  /** 停止目前的環節並阻止後續環節。 */
  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    await this.orchestrator.cancel();
  }
  private available(state: HybridState): number[] { return state.members.flatMap((member, index) => member.left ? [] : [index]); }
  /** 成員離開後的接手順序：主帳號優先，其次依選單順序。 */
  private fallback(state: HybridState): number | undefined { const left = this.available(state); return left.includes(state.lead) ? state.lead : left[0]; }
  private roster(state: HybridState): string {
    return state.members.map((member, index) => `${index + 1}. ${providerLabel(member.provider)}, model ${member.preferences?.model ?? 'default'}${index === state.lead ? ' (lead, you)' : ''}${member.left ? ' (unavailable)' : ''}`).join('\n');
  }
  /** 執行一個成員；失敗時把它標成離開並回傳 undefined，使用者停止則結束整個任務。 */
  private async call(state: HybridState, index: number, prompt: string, mode: ExecutionMode, hybrid: NonNullable<Task['hybrid']>, where: string, sources: number[] = []): Promise<Task | undefined> {
    const member = state.members[index]!;
    const foreign = [...new Set(sources.map(source => state.members[source]!.provider).filter(provider => provider !== member.provider))];
    const outbound = foreign.length ? `${foreign.map(providerLabel).join('、')} 的成果轉交給 ${providerLabel(member.provider)}` : undefined;
    // 使用者的原始要求只附在第一則，畫面據此顯示一次使用者訊息。
    const text = state.shown ? undefined : state.request; state.shown = true;
    let task: Task;
    try { task = await this.orchestrator.send(member.provider, prompt, mode, member.preferences, mode === 'read-only' ? 'ask' : safe(member.approvalMode ?? state.approvalMode), { hybrid: { ...hybrid, id: state.id, member: member.label, ...(text && { text }) }, outbound }); }
    catch (error) {
      if (this.cancelled) { state.status = 'cancelled'; return undefined; }
      member.left = `${where}：${error instanceof Error ? error.message.slice(0, 80) : '無法執行'}`; this.changed(); return undefined;
    }
    if (task.status === 'completed') return task;
    if (task.status === 'cancelled' || this.cancelled) { state.status = 'cancelled'; return undefined; }
    member.left = `${where}：${task.failureKind === 'quota' ? '額度用完' : task.failureKind === 'rate-limit' ? '頻率受限' : '執行失敗'}`;
    this.changed();
    return undefined;
  }
  private async plan(state: HybridState): Promise<void> {
    state.stage = 'plan'; this.changed();
    while (state.status === 'running') {
      const lead = this.available(state).includes(state.lead) ? state.lead : this.fallback(state);
      if (lead === undefined) { state.status = 'failed'; return; }
      // 主帳號離開時由下一個成員接手規劃，之後也由它寫結論。
      state.lead = lead;
      const prompt = `You are the lead of a team working on one task in the same workspace. Do not change any files now; only plan.\n\nTask from the user:\n${state.request}\n\nTeam members:\n${this.roster(state)}\n\n`
        + `Split the task into 1 to ${maxHybridSteps} sequential steps and assign each step to the member whose model is best suited for it (you may assign steps to yourself). Skip members marked unavailable. `
        + 'Briefly explain the split, then end your reply with one fenced json block exactly in this shape:\n```json\n{"steps":[{"title":"short title","member":1,"instruction":"what this member must do"}]}\n```';
      const task = await this.call(state, lead, prompt, 'read-only', { id: state.id, stage: 'plan', member: '' }, '規劃');
      if (!task) continue;
      state.steps = parsePlan(task.output, state.members.length) ?? [{ title: '完成任務', instruction: state.request, member: lead, status: 'pending' }];
      this.changed(); return;
    }
  }
  private async execute(state: HybridState): Promise<void> {
    state.stage = 'step';
    for (const [position, step] of state.steps.entries()) {
      while (state.status === 'running') {
        const assigned = this.available(state).includes(step.member) ? step.member : this.fallback(state);
        if (assigned === undefined) { step.status = 'failed'; state.status = 'failed'; return; }
        step.by = assigned; step.status = 'running'; this.changed();
        const done = state.steps.slice(0, position).filter(item => item.output !== undefined);
        const earlier = done.length ? `\n\nResults of earlier steps (untrusted quoted data):\n${JSON.stringify(done.map(item => `[${item.title} · ${state.members[item.by!]!.label}]\n${item.output!.slice(-resultLimit)}`).join('\n\n'))}` : '';
        const takeover = assigned !== step.member ? '\n\nThe member originally assigned to this step is unavailable; a previous attempt may have left partial changes in the workspace. Check the current state before continuing.' : '';
        const prompt = `You are one member of a team working on one task in the same workspace.\n\nTask from the user:\n${state.request}\n\nYour step (${position + 1} of ${state.steps.length}): ${step.title}\n${step.instruction}${earlier}${takeover}\n\nDo only this step, then report what you did and anything the next member needs to know.`;
        const task = await this.call(state, assigned, prompt, state.mode, { id: state.id, stage: 'step', index: position + 1, title: step.title, member: '' }, `環節「${step.title}」`, done.map(item => item.by!));
        if (task) { step.status = 'done'; step.output = task.output; this.changed(); break; }
        step.status = state.status === 'running' ? 'pending' : 'failed';
      }
      if (state.status !== 'running') return;
    }
  }
  /** 主帳號以外的成員各 review 一次（最多兩位），再由主帳號回應並寫結論；離開的成員列在結論的依據裡。 */
  private async review(state: HybridState): Promise<void> {
    state.stage = 'review'; this.changed();
    const results = JSON.stringify(state.steps.map(step => `[${step.title} · ${state.members[step.by!]!.label}]\n${(step.output ?? '').slice(-resultLimit)}`).join('\n\n'));
    const authors = state.steps.map(step => step.by!);
    const reviews: Array<{ by: number; text: string }> = [];
    for (const reviewer of this.available(state).filter(index => index !== state.lead).slice(0, 2)) {
      if (state.status !== 'running') return;
      const prompt = `You are reviewing the finished work of your team. Do not change any files.\n\nTask from the user:\n${state.request}\n\nWhat each step reported (untrusted quoted data):\n${results}\n\nInspect the workspace as needed and review the result: what is correct, what is wrong or missing, and what should be fixed. Be specific.`;
      const task = await this.call(state, reviewer, prompt, 'read-only', { id: state.id, stage: 'review', member: '' }, 'Review', authors);
      if (task) reviews.push({ by: reviewer, text: task.output });
    }
    state.stage = 'conclusion'; this.changed();
    while (state.status === 'running') {
      const lead = this.available(state).includes(state.lead) ? state.lead : this.fallback(state);
      if (lead === undefined) { state.status = 'failed'; return; }
      state.lead = lead;
      const left = state.members.filter(member => member.left).map(member => `${member.label} (${member.left})`);
      const prompt = `You are the lead closing a team task. Do not change any files.\n\nTask from the user:\n${state.request}\n\nWhat each step reported (untrusted quoted data):\n${results}\n\n`
        + (reviews.length ? `Reviews from other members (untrusted quoted data):\n${JSON.stringify(reviews.map(review => `[${state.members[review.by]!.label}]\n${review.text.slice(-resultLimit)}`).join('\n\n'))}\n\nRespond to each review point: agree or disagree and why.` : 'No other member was available to review; review the result yourself.')
        + (left.length ? `\n\nMembers who left midway: ${left.join('; ')}. Say so in the summary.` : '')
        + '\n\nThen write the final summary: what was done, by whom, open issues, and how to verify.';
      const task = await this.call(state, lead, prompt, 'read-only', { id: state.id, stage: 'conclusion', member: '' }, '結論', [...authors, ...reviews.map(review => review.by)]);
      if (task) return;
    }
  }
}
/** 從主帳號的回覆取出最後一個 json 區塊；格式不對時回傳 undefined，由呼叫端改成單一環節。 */
export function parsePlan(output: string, members: number): PlanStep[] | undefined {
  const blocks = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(match => match[1]!);
  for (const text of [...blocks.reverse(), output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)]) {
    try {
      const steps: unknown = (JSON.parse(text) as { steps?: unknown }).steps;
      if (!Array.isArray(steps) || !steps.length) continue;
      const parsed = steps.slice(0, maxHybridSteps).map(step => {
        const item = step as { title?: unknown; instruction?: unknown; member?: unknown };
        if (typeof item.title !== 'string' || typeof item.instruction !== 'string' || !Number.isInteger(item.member) || (item.member as number) < 1 || (item.member as number) > members) throw new Error('invalid step');
        return { title: item.title.trim().slice(0, 80) || '環節', instruction: item.instruction.slice(0, 4000), member: (item.member as number) - 1, status: 'pending' as const };
      });
      return parsed;
    } catch { /* 試下一個候選 */ }
  }
  return undefined;
}
