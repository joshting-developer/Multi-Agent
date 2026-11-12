<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { maxDiscussionRounds, type DiscussionSummary } from '../../../src/bridge/messages';
const props = defineProps<{ discussion: DiscussionSummary; busy: boolean }>();
const emit = defineEmits<{ extend: [rounds: number] }>();
const remaining = computed(() => maxDiscussionRounds - props.discussion.maxRounds);
const extra = ref(1);
watch(remaining, value => { extra.value = Math.min(Math.max(1, extra.value), Math.max(1, value)); });
const running = computed(() => props.discussion.status === 'running');
const current = computed(() => Math.min(props.discussion.completedRounds + 1, props.discussion.maxRounds));
</script>

<template>
  <!-- 停止與失敗以 alert 立即播報；進行中與完成以 status 播報，串流輸出不會改變這段文字。 -->
  <div v-if="discussion.status === 'cancelled' || discussion.status === 'failed'" class="notice discussion-bar" role="alert">
    <span>{{ discussion.status === 'cancelled' ? '討論已停止' : '討論失敗' }} · 已保留 {{ discussion.completedRounds }} 輪</span>
  </div>
  <div v-else class="notice discussion-bar" role="status">
    <span v-if="running">討論 · 第 {{ current }}／{{ discussion.maxRounds }} 輪</span>
    <span v-else>討論已完成 · {{ discussion.completedRounds }} 輪</span>
    <span v-if="discussion.status === 'completed' && remaining > 0" class="discussion-extend">
      <select v-model.number="extra" class="permission-picker" :disabled="busy" aria-label="延長回合"><option v-for="count in remaining" :key="count" :value="count">+{{ count }} 輪</option></select>
      <button type="button" class="text-button" :disabled="busy" @click="emit('extend', extra)">延長</button>
    </span>
  </div>
</template>
