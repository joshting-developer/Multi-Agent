<script setup lang="ts">
import { computed } from 'vue';
import type { HybridSummary } from '../../../src/bridge/messages';
const props = defineProps<{ hybrid: HybridSummary }>();
const current = computed(() => props.hybrid.steps.findIndex(step => step.status === 'running'));
const done = computed(() => props.hybrid.steps.filter(step => step.status === 'done').length);
const left = computed(() => props.hybrid.members.filter(member => member.left));
const progress = computed(() => {
  const { stage, steps, members } = props.hybrid;
  if (stage === 'plan') return '規劃分工';
  if (stage === 'review') return 'Review';
  if (stage === 'conclusion') return '整理結論';
  const index = current.value < 0 ? Math.min(done.value, steps.length - 1) : current.value; const step = steps[index];
  return step ? `環節 ${index + 1}／${steps.length} · ${step.title} · ${members[step.member]?.label ?? ''}` : '執行環節';
});
</script>

<template>
  <!-- 停止與失敗以 alert 播報；離開的成員在進行中與結束後都列出。 -->
  <div class="notice hybrid-bar" :role="hybrid.status === 'failed' || hybrid.status === 'cancelled' ? 'alert' : 'status'">
    <span v-if="hybrid.status === 'running'">混合 · {{ progress }}</span>
    <span v-else-if="hybrid.status === 'completed'">混合任務已完成 · {{ hybrid.steps.length }} 個環節</span>
    <span v-else>{{ hybrid.status === 'cancelled' ? '混合任務已停止' : '混合任務失敗' }} · 完成 {{ done }}／{{ hybrid.steps.length }} 個環節</span>
    <ul v-if="left.length" class="hybrid-left"><li v-for="member in left" :key="member.label">{{ member.label }} 中途離開 · {{ member.left }}</li></ul>
  </div>
</template>
