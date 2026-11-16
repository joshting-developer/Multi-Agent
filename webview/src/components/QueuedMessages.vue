<script setup lang="ts">
import type { QueuedMessage } from '../queue';
defineProps<{ items: QueuedMessage[]; canSteer: boolean; canSend: boolean; running: boolean }>();
const emit = defineEmits<{ steer: [id: string]; send: [id: string]; edit: [id: string]; remove: [id: string] }>();
</script>

<template>
  <ol class="queued-list" aria-label="待送訊息">
    <li v-for="item in items" :key="item.id" class="queued-item">
      <span class="queued-text" :title="item.text">{{ item.text || `圖片 ${item.images.length} 張` }}<small v-if="item.text && item.images.length"> · 圖片 {{ item.images.length }} 張</small></span>
      <span class="queued-actions">
        <!-- 圖片無法補充給執行中的任務，只能排隊。 -->
        <button v-if="running && canSteer && !item.images.length" type="button" class="text-button" @click="emit('steer', item.id)">立即補充</button>
        <button v-if="!running" type="button" class="text-button" :disabled="!canSend" @click="emit('send', item.id)">送出</button>
        <button type="button" class="text-button" @click="emit('edit', item.id)">編輯</button>
        <button type="button" class="text-button" :aria-label="`移除待送訊息：${item.text.slice(0, 30)}`" @click="emit('remove', item.id)">移除</button>
      </span>
    </li>
  </ol>
</template>
