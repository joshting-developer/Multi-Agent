<script setup lang="ts">
import { toolLabel } from '../../../src/bridge/labels';
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Step, Task } from '../../../src/bridge/messages';
import MessageBody from './MessageBody.vue';
import ChatIcon from './ChatIcon.vue';
/** pendingSteers：已按下立即補充、Agent 還沒接受的訊息，先顯示在對話裡並標示傳送中。 */
const props = withDefaults(defineProps<{ tasks: Task[]; focus?: { runId: string; query: string; revision: number }; hasEarlier?: boolean; externalChanges?: number; pendingSteers?: Array<{ id: string; taskId: string; text: string }> }>(), { focus: undefined, hasEarlier: false, externalChanges: 0, pendingSteers: () => [] });
const emit = defineEmits<{ reject: [taskId: string, rejected: boolean]; earlier: []; reload: [] }>();
// 往前載入時維持目前看到的位置，不跳到頂端或底部。
let anchor: number | undefined;
function earlier() { anchor = viewport.value ? viewport.value.scrollHeight - viewport.value.scrollTop : undefined; follow.value = false; emit('earlier'); }
watch(() => props.tasks[0]?.id, async () => {
  if (anchor === undefined) return;
  await nextTick(); const element = viewport.value;
  if (element) element.scrollTop = element.scrollHeight - anchor;
  anchor = undefined;
});
const viewport = ref<HTMLElement>();
const follow = ref(true);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 1000);
onBeforeUnmount(() => clearInterval(clock));
function onScroll() {
  const element = viewport.value;
  if (element) follow.value = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
}
watch(() => props.tasks.map(task => [task.id, task.output.length, task.status, task.activity]), async () => {
  if (!follow.value) return;
  await nextTick();
  const element = viewport.value;
  if (element) element.scrollTop = element.scrollHeight;
}, { deep: true });
// 從搜尋結果開啟時定位到命中的那一次執行，並在該則訊息中標示關鍵字；找不到時明確顯示失效。
const missing = ref(false); let applied = 0;
watch(() => [props.focus?.revision, props.tasks.length], async () => {
  const focus = props.focus;
  if (!focus || focus.revision === applied || !props.tasks.length) return;
  applied = focus.revision; await nextTick();
  const turn = viewport.value?.querySelector<HTMLElement>(`[data-run="${typeof CSS === 'undefined' ? focus.runId : CSS.escape(focus.runId)}"]`);
  missing.value = !turn; if (!turn) return;
  follow.value = false; turn.scrollIntoView({ block: 'center' }); mark(turn, focus.query);
}, { immediate: true });
function mark(root: HTMLElement, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let count = 0;
  for (const node of nodes) {
    let text = node; let index = text.data.toLocaleLowerCase().indexOf(needle);
    while (index >= 0 && count < 50) {
      const hit = text.splitText(index); text = hit.splitText(needle.length);
      const highlight = document.createElement('mark'); hit.replaceWith(highlight); highlight.append(hit); count++;
      index = text.data.toLocaleLowerCase().indexOf(needle);
    }
  }
}
const date = (value: number) => new Date(value).toLocaleString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const elapsed = (task: Task) => Math.max(0, Math.floor(((task.endedAt ?? now.value) - task.startedAt) / 1000));
const speaker = (task: Task) => {
  const name = task.provider === 'claude' ? 'Claude Code' : 'Codex';
  // 混合任務：顯示成員名稱與這次負責的階段。
  if (task.hybrid) return `${task.hybrid.member} · ${task.hybrid.stage === 'plan' ? '規劃分工' : task.hybrid.stage === 'step' ? `環節 ${task.hybrid.index}：${task.hybrid.title}` : task.hybrid.stage === 'review' ? 'Review' : '結論'}`;
  if (!task.participantRole) return name;
  if (task.participantRole === 'summarizer') return `${name} · 討論結論`;
  return `${name} ${task.participantRole === 'architect' ? 'A · 提案' : 'B · 審查'}${task.roundNo ? ` · 第 ${task.roundNo} 輪` : ''}${task.substitute ? ' · 代替' : ''}`;
};
const toolStatus = { running: '執行中', done: '完成', failed: '失敗', stopped: '已停止' } as const;
const summaryLine = (step: Extract<Step, { kind: 'tool' }>) => step.input?.split('\n', 1)[0] ?? '';
const statusLabel = (task: Task) => ({ queued: '排隊中', running: '執行中', completed: '', failed: '失敗', cancelled: '已停止', interrupted: '已中斷' })[task.status];
</script>

<template>
  <section ref="viewport" class="conversation" aria-label="對話紀錄" @scroll="onScroll">
    <div v-if="tasks.length === 0" class="empty-state" aria-label="開始對話"><ChatIcon name="chat" /></div>
    <p v-if="externalChanges" class="notice" role="status"><span>其他視窗有 {{ externalChanges }} 則新訊息</span><button type="button" class="text-button" @click="emit('reload')">重新載入</button></p>
    <button v-if="hasEarlier" type="button" class="text-button load-earlier" @click="earlier">載入更早的訊息</button>
    <p v-if="missing" class="notice" role="alert">找不到原始訊息，可能已刪除</p>
    <article v-for="task in tasks" :key="task.id" :class="['turn', { focused: focus?.runId === task.id && !missing }]" :data-run="task.id">
      <div v-if="task.hybrid ? task.hybrid.text : !task.discussionId || task.roundNo === 1" class="message user-message"><p class="prompt">{{ task.hybrid?.text ?? task.prompt }}</p><p v-if="task.attachments?.length" class="attachment-list"><span v-for="(item, index) in task.attachments" :key="item.id" class="attachment-chip">圖片 {{ index + 1 }} · {{ item.bytes >= 1048576 ? `${(item.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(item.bytes / 1024))} KB` }}</span></p></div>
      <div :class="['message', 'assistant-message', { rejected: task.rejected }]">
        <div class="message-label">
          <strong>{{ speaker(task) }}</strong><span v-if="focus?.runId === task.id" class="task-status">{{ date(task.startedAt) }}</span><span v-if="task.status !== 'completed'" :class="['task-status', task.status]">{{ statusLabel(task) }}<template v-if="task.status === 'running'"> · {{ elapsed(task) }}s</template></span><span v-else-if="task.rejected" class="task-status">已不採用</span><span v-if="task.persisted && task.contextMode === 'rebuilt'" class="task-status">上下文已重建</span>
          <button v-if="task.status === 'completed' && !task.discussionId && !task.hybrid" type="button" class="text-button" @click="emit('reject', task.id, !task.rejected)">{{ task.rejected ? '恢復採用' : '不採用' }}</button>
        </div>
        <template v-if="task.steps?.length">
          <template v-for="(step, index) in task.steps" :key="step.kind === 'tool' ? step.id : `${step.kind}-${index}`">
            <MessageBody v-if="step.kind === 'text'" :text="step.text" />
            <div v-else-if="step.kind === 'steer'" class="message user-message steer-message"><p class="prompt">{{ step.text }}</p></div>
            <details v-else :class="['tool-step', step.status]">
              <summary><span class="tool-dot" role="img" :aria-label="toolStatus[step.status]"></span><strong>{{ toolLabel(step.name) }}</strong><span v-if="step.status === 'failed'" class="failed">失敗</span><span class="tool-summary">{{ summaryLine(step) }}</span></summary>
              <div v-if="step.cwd" class="tool-io"><span>資料夾</span><pre>{{ step.cwd }}</pre></div>
              <div v-if="step.input" class="tool-io"><span>輸入</span><pre>{{ step.input }}</pre></div>
              <div v-if="step.output" class="tool-io"><span>輸出</span><pre>{{ step.output }}</pre></div>
              <div v-if="step.exitCode" class="tool-io"><span>結束碼</span><pre>{{ step.exitCode }}</pre></div>
            </details>
          </template>
        </template>
        <MessageBody v-else-if="task.output" :text="task.output" />
        <p v-else-if="task.status === 'running'" class="muted">等待 Provider 輸出…</p>
        <div v-for="item in pendingSteers.filter(entry => entry.taskId === task.id)" :key="item.id" class="message user-message steer-message pending" aria-busy="true"><p class="prompt">{{ item.text }}</p><span class="steer-status" role="status"><span class="steer-spinner" aria-hidden="true"></span>傳送中…</span></div>
        <p v-if="task.activity" role="status" class="activity">{{ task.activity }}</p>
        <p v-if="task.error" role="alert" class="error">{{ task.error }}</p>
      </div>
    </article>
  </section>
</template>
