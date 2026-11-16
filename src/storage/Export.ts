import type { Task } from '../bridge/messages';
import type { ConversationExport } from './ConversationDatabase';

const status: Record<Task['status'], string> = { queued: '排隊中', running: '執行中', completed: '已完成', failed: '失敗', cancelled: '已停止', interrupted: '已中斷' };
const provider = (task: Task) => task.provider === 'claude' ? 'Claude Code' : 'Codex';
const hybridStage = (task: Task) => task.hybrid!.stage === 'plan' ? '規劃分工' : task.hybrid!.stage === 'step' ? `環節 ${task.hybrid!.index}：${task.hybrid!.title}` : task.hybrid!.stage === 'review' ? 'Review' : '結論';
const role = (task: Task) => task.hybrid ? ` · 混合 · ${hybridStage(task)}` : task.participantRole === 'architect' ? ' A · 提案' : task.participantRole === 'critic' ? ' B · 審查' : task.participantRole === 'summarizer' ? ' · 討論結論' : '';
const time = (value: number) => new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/** 給人閱讀的 Markdown；每次執行保留 run ID、時間、Provider、狀態，工具只列名稱與狀態。 */
export function toMarkdown(data: ConversationExport): string {
  const lines = [`# ${data.conversation.title}`, '', `- 專案：${data.root}`, `- 對話 ID：${data.conversation.id}`, `- 匯出時間：${data.exportedAt}`, `- 資料庫版本：${data.schemaVersion}`, ''];
  for (const task of data.runs) {
    lines.push(`## ${time(task.startedAt)} · ${provider(task)}${role(task)}${task.roundNo ? ` · 第 ${task.roundNo} 輪` : ''} · ${status[task.status]}`, '', `run：\`${task.id}\`${task.model ? ` · 模型：${task.model}` : ''}${task.rejected ? ' · 已不採用' : ''}`, '');
    // 混合任務只有第一則帶使用者的原始要求，其餘是協調用的內部指示，不匯出。
    if (task.hybrid ? task.hybrid.text : !task.discussionId || task.roundNo === 1) lines.push('**使用者**', '', task.hybrid?.text ?? task.prompt, '');
    for (const step of task.steps ?? []) if (step.kind === 'steer') lines.push('**使用者補充**', '', step.text, '');
    const tools = task.steps?.filter(step => step.kind === 'tool') ?? [];
    if (tools.length) lines.push(`**工具**：${tools.map(step => `${step.name}（${step.status}）`).join('、')}`, '');
    lines.push(`**${provider(task)}${role(task)}**`, '', task.output || '（沒有輸出）', '');
    if (task.error) lines.push(`> 錯誤：${task.error}`, '');
  }
  return lines.join('\n');
}
