<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { ConversationSummary } from '../../../src/bridge/messages';
defineProps<{ conversations: ConversationSummary[]; activeId?: string; busy: boolean; searching: boolean }>();
const emit = defineEmits<{ search: [query: string]; open: [id: string]; rename: [id: string, title: string]; delete: [id: string] }>();
const query = ref('');
const editing = ref(''); const title = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, value => { clearTimeout(timer); timer = setTimeout(() => emit('search', value), 180); });
onBeforeUnmount(() => clearTimeout(timer));
const date = (value: number) => new Date(value).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
function rename(id: string) { if (title.value.trim()) emit('rename', id, title.value.trim()); editing.value = ''; }
</script>

<template>
  <section class="history-panel" aria-label="歷史對話">
    <input v-model="query" type="search" class="history-search" placeholder="搜尋對話標題與內容" aria-label="搜尋歷史對話" maxlength="500" />
    <p v-if="searching" class="muted" role="status">搜尋中…</p>
    <p v-else-if="query && !conversations.length" class="muted">沒有符合的對話</p>
    <article v-for="conversation in conversations" :key="conversation.id" :class="['history-item', { selected: conversation.id === activeId }]">
      <form v-if="editing === conversation.id" @submit.prevent="rename(conversation.id)"><input v-model="title" aria-label="對話名稱" maxlength="120" /><button type="submit">儲存</button><button type="button" @click="editing = ''">取消</button></form>
      <template v-else>
        <button type="button" class="history-open" :disabled="busy" @click="$emit('open', conversation.id)"><span>{{ conversation.title }}</span><small>{{ conversation.provider === 'claude' ? 'Claude' : conversation.provider === 'codex' ? 'Codex' : '' }} · {{ date(conversation.updatedAt) }}<template v-if="conversation.activity"> · {{ { running: '執行中', queued: '排隊中', waiting: '等待核准' }[conversation.activity] }}</template></small><span v-if="query && conversation.preview" class="history-preview">{{ conversation.preview }}</span></button>
        <div class="history-actions"><button type="button" class="text-button" :disabled="busy" :aria-label="`重新命名 ${conversation.title}`" @click="editing = conversation.id; title = conversation.title">重新命名</button><button type="button" class="text-button" :disabled="busy" :aria-label="`刪除 ${conversation.title}`" @click="$emit('delete', conversation.id)">刪除</button></div>
      </template>
    </article>
  </section>
</template>
