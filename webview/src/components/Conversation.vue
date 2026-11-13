<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Task } from '../../../src/bridge/messages';
import MessageBody from './MessageBody.vue';
import ChatIcon from './ChatIcon.vue';
const props = defineProps<{ tasks: Task[] }>();
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
  return `${name} ${task.participantRole === 'architect' ? 'A · 提案' : 'B · 審查'}${task.roundNo ? ` · 第 ${task.roundNo} 輪` : ''}`;
};
const statusLabel = (task: Task) => ({ running: '執行中', completed: '', failed: '失敗', cancelled: '已停止', interrupted: '已中斷' })[task.status];
</script>

<template>
  <section ref="viewport" class="conversation" aria-label="對話紀錄" @scroll="onScroll">
    <div v-if="tasks.length === 0" class="empty-state" aria-label="開始對話"><ChatIcon name="chat" /></div>
    <article v-for="task in tasks" :key="task.id" class="turn">
      <div v-if="task.participantRole !== 'summarizer' && (!task.roundNo || task.roundNo === 1)" class="message user-message"><p class="prompt">{{ task.prompt }}</p></div>
      <div class="message assistant-message">
        <div class="message-label"><strong>{{ speaker(task) }}</strong><span v-if="task.status !== 'completed'" :class="['task-status', task.status]">{{ statusLabel(task) }}<template v-if="task.status === 'running'"> · {{ elapsed(task) }}s</template></span></div>
        <MessageBody v-if="task.output" :text="task.output" />
        <p v-else-if="task.status === 'running'" class="muted">等待 Provider 輸出…</p>
        <p v-if="task.activity" role="status" class="activity">{{ task.activity }}</p>
        <p v-if="task.error" role="alert" class="error">{{ task.error }}</p>
      </div>
    </article>
  </section>
</template>
