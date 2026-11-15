<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { AgentId, ConversationSummary, SearchFilters, SearchMatch } from '../../../src/bridge/messages';
withDefaults(defineProps<{ conversations: ConversationSummary[]; activeId?: string; busy: boolean; searching: boolean; providers?: AgentId[] }>(), { activeId: undefined, providers: () => [] });
const emit = defineEmits<{ search: [query: string, filters: SearchFilters]; open: [id: string, match?: SearchMatch]; rename: [id: string, title: string]; delete: [id: string] }>();
const query = ref('');
const provider = ref<AgentId | ''>(''); const mode = ref<'solo' | 'discussion' | ''>(''); const period = ref<'' | 'today' | '7' | '30'>('');
const editing = ref(''); const title = ref('');
// 只提供目前資料真的有的條件：Provider、一般／討論、時間；Tag 尚無資料，不顯示。
const filters = computed<SearchFilters>(() => {
  const since = period.value === 'today' ? new Date().setHours(0, 0, 0, 0) : period.value ? Date.now() - Number(period.value) * 86400000 : undefined;
  return { ...(provider.value && { provider: provider.value }), ...(mode.value && { mode: mode.value }), ...(since !== undefined && { since }) };
});
const active = computed(() => !!query.value.trim() || Object.keys(filters.value).length > 0);
let timer: ReturnType<typeof setTimeout> | undefined;
watch([query, filters], ([value, current]) => { clearTimeout(timer); timer = setTimeout(() => emit('search', value, current), 180); });
onBeforeUnmount(() => clearTimeout(timer));
const date = (value: number) => new Date(value).toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' });
function rename(id: string) { if (title.value.trim()) emit('rename', id, title.value.trim()); editing.value = ''; }
</script>

<template>
  <section class="history-panel" aria-label="歷史對話">
    <input v-model="query" type="search" class="history-search" placeholder="搜尋對話標題與內容" aria-label="搜尋歷史對話" maxlength="500" />
    <div class="history-filters">
      <select v-model="provider" class="permission-picker" aria-label="Agent"><option value="">全部 Agent</option><option v-for="item in providers" :key="item" :value="item">{{ item === 'claude' ? 'Claude' : 'Codex' }}</option></select>
      <select v-model="mode" class="permission-picker" aria-label="類型"><option value="">全部類型</option><option value="solo">一般</option><option value="discussion">討論</option></select>
      <select v-model="period" class="permission-picker" aria-label="時間"><option value="">全部時間</option><option value="today">今天</option><option value="7">7 天內</option><option value="30">30 天內</option></select>
    </div>
    <p v-if="searching" class="muted" role="status">搜尋中…</p>
    <p v-else-if="active && !conversations.length" class="muted">沒有符合的對話</p>
    <article v-for="conversation in conversations" :key="conversation.id" :class="['history-item', { selected: conversation.id === activeId }]">
      <form v-if="editing === conversation.id" @submit.prevent="rename(conversation.id)"><input v-model="title" aria-label="對話名稱" maxlength="120" /><button type="submit" class="text-button">儲存</button><button type="button" class="text-button" @click="editing = ''">取消</button></form>
      <template v-else>
        <button type="button" class="history-open" :disabled="busy" @click="emit('open', conversation.id, conversation.match)"><span>{{ conversation.title }}</span><small v-if="conversation.match">{{ conversation.match.provider === 'claude' ? 'Claude' : 'Codex' }} · {{ date(conversation.match.at) }}{{ conversation.match.discussion ? ' · 討論' : '' }}</small><small v-else>{{ conversation.provider === 'claude' ? 'Claude' : conversation.provider === 'codex' ? 'Codex' : '' }} · {{ date(conversation.updatedAt) }}<template v-if="conversation.activity"> · {{ { running: '執行中', queued: '排隊中', waiting: '等待核准' }[conversation.activity] }}</template></small><span v-if="query.trim() && conversation.preview" class="history-preview">{{ conversation.preview }}</span></button>
        <div class="history-actions"><button type="button" class="text-button" :disabled="busy" :aria-label="`重新命名 ${conversation.title}`" @click="editing = conversation.id; title = conversation.title">重新命名</button><button type="button" class="text-button" :disabled="busy" :aria-label="`刪除 ${conversation.title}`" @click="$emit('delete', conversation.id)">刪除</button></div>
      </template>
    </article>
  </section>
</template>
