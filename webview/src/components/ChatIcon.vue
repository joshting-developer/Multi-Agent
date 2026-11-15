<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ name: 'send' | 'stop' | 'chat' | 'history' | 'settings' | 'new' }>();
const paths = {
  history: 'M3 12a9 9 0 1 0 3-6.7M3 3v5h5m4 0v5l3 2',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Zm3 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  new: 'M14 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-9M13 11l8-8-3-3-8 8-1 4 4-1',
  send: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M5 5h14v14H5z',
  chat: 'M7 18 3 21V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H7Zm0-9h10M7 13h6'
};
const path = computed(() => paths[props.name]);
</script>

<template>
  <svg viewBox="0 0 24 24" :fill="name === 'stop' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="path" /></svg>
</template>
