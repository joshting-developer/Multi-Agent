<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AgentId, ExecutionMode, WebviewToHost } from '../../src/bridge/messages';
import { useHost } from './composables/useHost';
import Conversation from './components/Conversation.vue';
import Composer from './components/Composer.vue';
import ChatIcon from './components/ChatIcon.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import ApprovalCard from './components/ApprovalCard.vue';
import DiscussionBar from './components/DiscussionBar.vue';
import { defaultSettings, type ProviderPreferences } from '../../src/bridge/preferences';
const { snapshot, error, running, submitting, draftRevision, post, send, draft, saveDraft, searchConversations, searchResults, historySearching, navigating, navigate } = useHost();
const selected = ref<AgentId>('codex');
const userSelected = ref(false);
const historyShown = ref(false);
const historyQuery = ref('');
const history = computed(() => historyQuery.value ? searchResults.value : snapshot.value.conversations ?? []);
watch(() => JSON.stringify(snapshot.value.conversations), () => { if (historyShown.value && historyQuery.value) searchConversations(historyQuery.value); });
const conversationTitle = computed(() => snapshot.value.conversations?.find(item => item.id === snapshot.value.conversationId)?.title ?? '新對話');
watch(() => snapshot.value.conversationId, () => { const last = snapshot.value.tasks.at(-1); if (last) selected.value = last.provider; });
const preferences = ref<ProviderPreferences>({ model: '', effort: 'medium' });
const settings = computed(() => snapshot.value.settings ?? defaultSettings);
watch(() => `${selected.value}:${JSON.stringify(settings.value[selected.value])}`, () => { preferences.value = { ...settings.value[selected.value] }; }, { immediate: true });
const busy = computed(() => running.value || submitting.value || navigating.value || !!snapshot.value.discussionId);
const canWrite = computed(() => snapshot.value.providers.find(provider => provider.id === selected.value)?.capabilities.workspaceWrite);
const canSend = computed(() => !!preferences.value.model && snapshot.value.trusted && snapshot.value.policy.allowedProviders.includes(selected.value) && snapshot.value.providers.some(provider => provider.id === selected.value && provider.status === 'ready') && !snapshot.value.checking);
const notice = computed(() => {
  if (!snapshot.value.workspace) return undefined;
  if (!snapshot.value.trusted) return { text: '請先信任目前工作區。', action: undefined };
  if (!snapshot.value.policy.allowedProviders.includes(selected.value)) return { text: '首次使用，請授權工作區。', action: 'authorize-workspace' as const };
  const provider = snapshot.value.providers.find(provider => provider.id === selected.value);
  if (snapshot.value.checking) return { text: '正在連線…', action: undefined };
  if (provider?.status !== 'ready') return { text: provider?.reason ?? '請檢查 Agent 連線。', action: 'show-options' as const };
  return undefined;
});
watch(() => snapshot.value.providers, providers => {
  if (userSelected.value || providers.some(provider => provider.id === selected.value && provider.status === 'ready')) return;
  const available = providers.find(provider => provider.status === 'ready');
  if (available) selected.value = available.id;
});
function action(type: 'new-conversation' | 'authorize-workspace' | 'show-options' | 'refresh-models') {
  const message = { version: 1, type, requestId: crypto.randomUUID() } as WebviewToHost;
  if (message.type === 'new-conversation') navigate(message); else post(message);
}
function historySearch(query: string) { historyQuery.value = query; searchConversations(query); }
function openConversation(id: string) { navigate({ version: 1, type: 'open-conversation', requestId: crypto.randomUUID(), conversationId: id }); historyShown.value = false; }
function renameConversation(id: string, title: string) { post({ version: 1, type: 'rename-conversation', requestId: crypto.randomUUID(), conversationId: id, title }); }
function deleteConversation(id: string) { post({ version: 1, type: 'delete-conversation', requestId: crypto.randomUUID(), conversationId: id }); }
function answerApproval(id: string, allow: boolean) { post({ version: 1, type: 'answer-approval', requestId: crypto.randomUUID(), approvalId: id, allow }); }
function submit(text: string, mode: ExecutionMode, approvalMode: import('../../src/bridge/preferences').ApprovalMode) {
  send({ version: 1, type: 'send-message', requestId: crypto.randomUUID(), provider: selected.value, text, mode, approvalMode, preferences: { ...preferences.value } });
}
function discuss(text: string, rounds: number, partner: AgentId) {
  send({ version: 1, type: 'start-discussion', requestId: crypto.randomUUID(), provider: selected.value, partner, text, rounds, preferences: { ...preferences.value } });
}
// 只在目前對話含有該討論時顯示進度、完成、停止或失敗。
const discussion = computed(() => {
  const value = snapshot.value.discussion;
  if (!value) return undefined;
  return snapshot.value.tasks.some(task => task.discussionId === value.id) ? value : undefined;
});
const summaryTask = computed(() => snapshot.value.tasks.find(task => task.id === discussion.value?.summaryTaskId && task.status === 'completed' && task.output));
const insert = ref<{ text: string; revision: number }>();
function adoptSummary() {
  if (summaryTask.value) insert.value = { text: `依照下面的討論結論處理：\n\n${summaryTask.value.output}`, revision: (insert.value?.revision ?? 0) + 1 };
}
function extendDiscussion(rounds: number) {
  if (discussion.value) send({ version: 1, type: 'extend-discussion', requestId: crypto.randomUUID(), discussionId: discussion.value.id, rounds });
}
function selectPreferences(value: ProviderPreferences) {
  preferences.value = value;
  post({ version: 1, type: 'set-provider-preferences', requestId: crypto.randomUUID(), provider: selected.value, preferences: value });
}
function cancel() {
  // 討論中即使位於回合之間也能停止，Host 會阻止後續回合。
  if (snapshot.value.activeTaskId || snapshot.value.discussionId) post({ version: 1, type: 'cancel-task', requestId: crypto.randomUUID(), taskId: snapshot.value.activeTaskId ?? '' });
}
</script>

<template>
  <main class="workspace">
    <header class="chat-toolbar"><button type="button" class="conversation-title text-button" :disabled="busy" :aria-expanded="historyShown" @click="historyShown = !historyShown; historyQuery = ''">{{ historyShown ? '歷史對話' : conversationTitle }}</button><div><button type="button" class="icon-button" aria-label="歷史對話" :disabled="busy" :aria-pressed="historyShown" @click="historyShown = !historyShown; historyQuery = ''"><ChatIcon name="history" /></button><button type="button" class="icon-button" aria-label="新增對話" :disabled="busy" @click="action('new-conversation'); historyShown = false"><ChatIcon name="new" /></button></div></header>
    <p v-if="historyShown && error" class="error notice" role="alert">{{ error }}</p>
    <HistoryPanel v-if="historyShown" :conversations="history" :active-id="snapshot.conversationId" :busy="busy" :searching="historySearching" @search="historySearch" @open="openConversation" @rename="renameConversation" @delete="deleteConversation" />
    <Conversation v-else :key="snapshot.conversationId" :tasks="snapshot.tasks" />
    <div v-if="!historyShown" class="input-area">
      <p v-if="error" class="error notice" role="alert">{{ error }}</p>
      <div v-else-if="notice" class="notice" role="status"><span>{{ notice.text }}</span><button v-if="notice.action" type="button" class="text-button" :disabled="busy" @click="action(notice.action)">{{ notice.action === 'authorize-workspace' ? '授權' : '設定' }}</button></div>
      <DiscussionBar v-if="discussion && !error && !notice" :discussion="discussion" :busy="busy" :summary-ready="!!summaryTask" @extend="extendDiscussion" @adopt="adoptSummary" />
      <ApprovalCard v-for="request in snapshot.approvals ?? []" :key="request.id" :request="request" @answer="answerApproval" />
      <Composer :insert="insert" :approval-mode="settings.approvalMode" :supported-approval-modes="snapshot.providers.find(item => item.id === selected)?.approvalModes" :busy="busy" :running="running || !!snapshot.discussionId" :can-send="canSend" :can-write="canWrite" :provider="selected" :preferences="preferences" :models="snapshot.models?.[selected] ?? []" :models-loading="snapshot.models?.loading ?? false" :send-shortcut="settings.sendShortcut" :default-mode="settings.defaultMode" :initial-draft="draft" :draft-revision="draftRevision" @send="submit" @discuss="discuss" @cancel="cancel" @draft="saveDraft" @select="selected = $event; userSelected = true" @preferences="selectPreferences" @settings="action('show-options')" @refresh-models="action('refresh-models')" />
    </div>
  </main>
</template>
