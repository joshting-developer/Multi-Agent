<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Step, Task } from '../../../src/bridge/messages';
import MessageBody from './MessageBody.vue';
import ChatIcon from './ChatIcon.vue';
const props = defineProps<{ tasks: Task[] }>();
const emit = defineEmits<{ reject: [taskId: string, rejected: boolean] }>();
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
const elapsed = (task: Task) => Math.max(0, Math.floor(((task.endedAt ?? now.value) - task.startedAt) / 1000));
const speaker = (task: Task) => {
  const name = task.provider === 'claude' ? 'Claude Code' : 'Codex';
  if (!task.participantRole) return name;
  if (task.participantRole === 'summarizer') return `${name} · 討論結論`;
  return `${name} ${task.participantRole === 'architect' ? 'A · 提案' : 'B · 審查'}${task.roundNo ? ` · 第 ${task.roundNo} 輪` : ''}${task.substitute ? ' · 代替' : ''}`;
};
const toolStatus = { running: '執行中', done: '完成', failed: '失敗', stopped: '已停止' } as const;
const summaryLine = (step: Extract<Step, { kind: 'tool' }>) => step.input?.split('\n', 1)[0] ?? '';
const statusLabel = (task: Task) => ({ running: '執行中', completed: '', failed: '失敗', cancelled: '已停止', interrupted: '已中斷' })[task.status];
</script>

<template>
  <section ref="viewport" class="conversation" aria-label="對話紀錄" @scroll="onScroll">
    <div v-if="tasks.length === 0" class="empty-state" aria-label="開始對話"><ChatIcon name="chat" /></div>
    <article v-for="task in tasks" :key="task.id" class="turn">
      <div v-if="!task.discussionId || task.roundNo === 1" class="message user-message"><p class="prompt">{{ task.prompt }}</p></div>
      <div :class="['message', 'assistant-message', { rejected: task.rejected }]">
        <div class="message-label">
          <strong>{{ speaker(task) }}</strong><span v-if="task.status !== 'completed'" :class="['task-status', task.status]">{{ statusLabel(task) }}<template v-if="task.status === 'running'"> · {{ elapsed(task) }}s</template></span><span v-else-if="task.rejected" class="task-status">已不採用</span>
          <button v-if="task.status === 'completed' && !task.discussionId" type="button" class="text-button" @click="emit('reject', task.id, !task.rejected)">{{ task.rejected ? '恢復採用' : '不採用' }}</button>
        </div>
        <template v-if="task.steps?.length">
          <template v-for="(step, index) in task.steps" :key="step.kind === 'tool' ? step.id : `text-${index}`">
            <MessageBody v-if="step.kind === 'text'" :text="step.text" />
            <details v-else :class="['tool-step', step.status]">
              <summary><span class="tool-dot" role="img" :aria-label="toolStatus[step.status]"></span><strong>{{ step.name }}</strong><span class="tool-summary">{{ summaryLine(step) }}</span></summary>
              <div v-if="step.input" class="tool-io"><span>IN</span><pre>{{ step.input }}</pre></div>
              <div v-if="step.output" class="tool-io"><span>OUT</span><pre>{{ step.output }}</pre></div>
            </details>
          </template>
        </template>
        <MessageBody v-else-if="task.output" :text="task.output" />
        <p v-else-if="task.status === 'running'" class="muted">等待 Provider 輸出…</p>
        <p v-if="task.activity" role="status" class="activity">{{ task.activity }}</p>
        <p v-if="task.error" role="alert" class="error">{{ task.error }}</p>
      </div>
    </article>
  </section>
</template>
