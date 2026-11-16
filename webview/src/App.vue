<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AccountSummary, AgentId, ExecutionMode, SearchFilters, SearchMatch, WebviewToHost } from '../../src/bridge/messages';
import { useHost } from './composables/useHost';
import Conversation from './components/Conversation.vue';
import Composer from './components/Composer.vue';
import ChatIcon from './components/ChatIcon.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import ApprovalCard from './components/ApprovalCard.vue';
import DiscussionBar from './components/DiscussionBar.vue';
import QueuedMessages from './components/QueuedMessages.vue';
import HybridBar from './components/HybridBar.vue';
import AgentPanel from './components/AgentPanel.vue';
import LoginCard from './components/LoginCard.vue';
import type { ChatKind, HybridMember, QueuedMessage } from './queue';
import { concretePreferences, defaultSettings, type AccountPreferences, type ProviderPreferences } from '../../src/bridge/preferences';
const { steer, historyRequested, snapshot, error, running, submitting, draftRevision, post, send, draft, draftFor, saveDraft, searchConversations, searchResults, historySearching, navigating, navigate } = useHost();
const selected = ref<AgentId>('codex');
const insert = ref<{ text: string; revision: number }>();
const userSelected = ref(false);
const historyShown = ref(false);
watch(historyRequested, () => { historyShown.value = true; historyQuery.value = ''; historyFilters.value = {}; });
const historyQuery = ref('');
const historyFilters = ref<SearchFilters>({});
const history = computed(() => historyQuery.value || Object.keys(historyFilters.value).length ? searchResults.value : snapshot.value.conversations ?? []);
watch(() => JSON.stringify(snapshot.value.conversations), () => { if (historyShown.value && (historyQuery.value || Object.keys(historyFilters.value).length)) searchConversations(historyQuery.value, historyFilters.value); });
const conversationTitle = computed(() => snapshot.value.conversations?.find(item => item.id === snapshot.value.conversationId)?.title ?? '新對話');
watch(() => snapshot.value.conversationId, (id, previous) => {
  const last = snapshot.value.tasks.at(-1); if (last) selected.value = last.provider;
  if (previous) insert.value = { text: draftFor(id), revision: (insert.value?.revision ?? 0) + 1 };
});
const settings = computed(() => snapshot.value.settings ?? defaultSettings);
const catalog = computed(() => ({ codex: snapshot.value.models?.codex ?? [], claude: snapshot.value.models?.claude ?? [] }));
// 帳號自己記住的模型、強度與核准方式；沒設定時沿用該 Agent 的預設，模型清單有值時取第一個可用模型。
function preferencesOf(account: AccountSummary): AccountPreferences {
  const own = account.preferences; const fallback = settings.value[account.provider];
  const model = own?.model || fallback.model || catalog.value[account.provider][0]?.id || '';
  return { ...concretePreferences({ model, effort: own?.effort ?? fallback.effort }, catalog.value[account.provider]), approvalMode: own?.approvalMode ?? settings.value.approvalMode };
}
const soloAccount = computed(() => snapshot.value.accounts?.find(account => account.id === snapshot.value.selectedAccounts?.[selected.value]));
const soloPreferences = computed(() => soloAccount.value ? preferencesOf(soloAccount.value) : { ...settings.value[selected.value], approvalMode: settings.value.approvalMode });
const preferences = computed<ProviderPreferences>(() => ({ model: soloPreferences.value.model, effort: soloPreferences.value.effort, ...(soloAccount.value && { accountId: soloAccount.value.id }) }));
const busy = computed(() => running.value || submitting.value || navigating.value || !!snapshot.value.discussionId);
// 一般任務執行中仍可打字，送出會進待送清單；討論進行中才鎖住輸入框。
const composerBusy = computed(() => submitting.value || navigating.value || !!snapshot.value.discussionId);
// 一般任務在背景執行時仍可切換、新增對話；只有切換中或討論進行中才鎖住導覽。
const navigationLocked = computed(() => navigating.value || !!snapshot.value.discussionId);
const canWrite = computed(() => snapshot.value.providers.find(provider => provider.id === selected.value)?.capabilities.workspaceWrite);
const canSend = computed(() => !!preferences.value.model && snapshot.value.trusted && snapshot.value.policy.allowedProviders.includes(selected.value) && snapshot.value.providers.some(provider => provider.id === selected.value && provider.status === 'ready') && !snapshot.value.checking);
const notice = computed(() => {
  if (!snapshot.value.workspace) return undefined;
  if (!snapshot.value.trusted) return { text: '請先信任目前工作區', action: undefined };
  if (!snapshot.value.policy.allowedProviders.includes(selected.value)) return { text: '首次使用，請授權工作區', action: 'authorize-workspace' as const };
  const provider = snapshot.value.providers.find(provider => provider.id === selected.value);
  if (snapshot.value.checking) return { text: '正在連線…', action: undefined };
  if (provider?.status !== 'ready') return { text: provider?.reason ?? '請檢查 Agent 連線', action: 'show-options' as const };
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
function historySearch(query: string, filters: SearchFilters = {}) { historyQuery.value = query; historyFilters.value = filters; searchConversations(query, filters); }
const newRequestId = () => crypto.randomUUID();
const focus = ref<{ runId: string; query: string; revision: number }>();
function openConversation(id: string, match?: SearchMatch) {
  focus.value = match ? { runId: match.runId, query: historyQuery.value, revision: (focus.value?.revision ?? 0) + 1 } : undefined;
  navigate({ version: 1, type: 'open-conversation', requestId: crypto.randomUUID(), conversationId: id }); historyShown.value = false;
}
function renameConversation(id: string, title: string) { post({ version: 1, type: 'rename-conversation', requestId: crypto.randomUUID(), conversationId: id, title }); }
function deleteConversation(id: string) { post({ version: 1, type: 'delete-conversation', requestId: crypto.randomUUID(), conversationId: id }); }
function rejectAnswer(taskId: string, rejected: boolean) { post({ version: 1, type: 'reject-answer', requestId: crypto.randomUUID(), taskId, rejected }); }
function answerApproval(id: string, allow: boolean) { post({ version: 1, type: 'answer-approval', requestId: crypto.randomUUID(), approvalId: id, allow }); }
function submit(text: string, mode: ExecutionMode, approvalMode: import('../../src/bridge/preferences').ApprovalMode, images: Array<{ mime: string; data: string }> = []) {
  const item: QueuedMessage = { id: crypto.randomUUID(), conversationId: snapshot.value.conversationId ?? '', provider: selected.value, text, mode, approvalMode, preferences: { ...preferences.value }, images: images.map(image => ({ mime: image.mime, data: image.data })) };
  // 執行中先放進待送清單，等目前任務完成或使用者選擇立即補充。
  if (running.value) { queue.value.push(item); draftRevision.value++; return; }
  dispatch(item);
}
function dispatch(item: QueuedMessage, keepDraft = false) {
  send({ version: 1, type: 'send-message', requestId: crypto.randomUUID(), provider: item.provider, text: item.text, mode: item.mode, approvalMode: item.approvalMode, preferences: item.preferences, ...(item.images.length && { attachments: item.images }) }, keepDraft);
}
const queue = ref<QueuedMessage[]>([]);
const queued = computed(() => queue.value.filter(item => item.conversationId === (snapshot.value.conversationId ?? '')));
const activeTask = computed(() => running.value ? snapshot.value.tasks.find(task => task.id === snapshot.value.activeTaskId) : undefined);
const canSteer = computed(() => !!activeTask.value && !!snapshot.value.providers.find(provider => provider.id === activeTask.value!.provider)?.capabilities.steer);
const take = (id: string) => { const item = queue.value.find(entry => entry.id === id); queue.value = queue.value.filter(entry => entry.id !== id); return item; };
function sendQueued(id: string) { if (submitting.value || running.value) return; const item = take(id); if (item) dispatch(item, true); }
function editQueued(id: string) { const item = take(id); if (item) insert.value = { text: item.text, revision: (insert.value?.revision ?? 0) + 1 }; }
async function steerQueued(id: string) {
  const item = queue.value.find(entry => entry.id === id); const task = activeTask.value;
  if (!item || !task || item.steering) return;
  item.steering = true;
  if (await steer(task.id, item.text)) take(id); else item.steering = false;
}
// 目前對話的任務正常完成才自動送下一則；失敗或停止時留在清單讓使用者決定。
let watchedTask: string | undefined;
watch(() => [snapshot.value.activeTaskId, snapshot.value.activeConversationId, snapshot.value.conversationId] as const, ([id, conversation, current]) => {
  const finished = watchedTask; watchedTask = id && conversation === current ? id : undefined;
  if (!finished || finished === id) return;
  if (snapshot.value.tasks.find(task => task.id === finished)?.status !== 'completed') return;
  const next = queued.value.find(item => !item.steering);
  if (next && canSend.value && !submitting.value) { take(next.id); dispatch(next, true); }
});
// 一般／討論／混合在標題列切換；帳號與設定都在標題列下方的成員面板選，送出時才組成請求。
const kind = ref<ChatKind>('solo');
const kinds: Array<{ id: ChatKind; label: string }> = [{ id: 'solo', label: '一般' }, { id: 'discussion', label: '討論' }, { id: 'hybrid', label: '混合' }];
const team = ref<{ members: HybridMember[]; lead: number }>({ members: [], lead: -1 });
const rounds = ref(4);
const kindReady = computed(() => {
  if (kind.value === 'solo') return true;
  const { members, lead } = team.value;
  const count = kind.value === 'discussion' ? members.length === 2 : members.length >= 2 && members.length <= 4;
  return count && lead >= 0 && members.every(member => member.preferences.model);
});
function compose(text: string, mode: ExecutionMode, approvalMode: import('../../src/bridge/preferences').ApprovalMode, images: Array<{ mime: string; data: string }> = []) {
  if (kind.value === 'discussion') discuss(text);
  else if (kind.value === 'hybrid') startHybrid(text, mode, approvalMode);
  else submit(text, mode, approvalMode, images);
}
// 討論：主帳號是提案方 A，另一個是審查方 B，各自帶自己的模型與強度。
function discuss(text: string) {
  const { members, lead } = team.value; const a = members[lead]!; const b = members.find((_, index) => index !== lead)!;
  send({ version: 1, type: 'start-discussion', requestId: crypto.randomUUID(), provider: a.provider, partner: b.provider, text, rounds: rounds.value, preferences: { ...a.preferences }, partnerPreferences: { ...b.preferences }, ...(b.preferences.accountId && { partnerAccountId: b.preferences.accountId }) });
}
function startHybrid(text: string, mode: ExecutionMode, approvalMode: import('../../src/bridge/preferences').ApprovalMode) {
  send({ version: 1, type: 'start-hybrid', requestId: crypto.randomUUID(), text, mode, approvalMode, members: team.value.members.map(member => ({ provider: member.provider, preferences: { ...member.preferences }, ...(member.approvalMode && { approvalMode: member.approvalMode }) })), lead: team.value.lead });
}
function chooseSolo(provider: AgentId, accountId: string) {
  selected.value = provider; userSelected.value = true;
  if (accountId !== snapshot.value.selectedAccounts?.[provider]) selectAccount(provider, accountId);
}
// 一個已登入的帳號都沒有時（檢查中不算），聊天畫面直接提供 Claude、Codex 的登入入口。
const needsLogin = computed(() => !!snapshot.value.accounts && !snapshot.value.accounts.some(account => account.loggedIn !== false));
function login(provider: AgentId, accountId?: string) {
  if (accountId) post({ version: 1, type: 'account-terminal', requestId: crypto.randomUUID(), accountId, action: 'login' });
  else post({ version: 1, type: 'add-account', requestId: crypto.randomUUID(), provider });
}
function loginWithKey(provider: AgentId, apiKey: string) { post({ version: 1, type: 'add-account', requestId: crypto.randomUUID(), provider, apiKey }); }
function setAccountPreferences(accountId: string, value: AccountPreferences) { post({ version: 1, type: 'set-account-preferences', requestId: crypto.randomUUID(), accountId, preferences: value }); }
// 只在目前對話含有該混合任務時顯示進度與離開的成員。
const hybrid = computed(() => snapshot.value.hybrid && snapshot.value.tasks.some(task => task.hybrid?.id === snapshot.value.hybrid!.id) ? snapshot.value.hybrid : undefined);
function selectAccount(provider: AgentId, accountId: string) { post({ version: 1, type: 'select-account', requestId: crypto.randomUUID(), provider, accountId }); }
// 只在目前對話含有該討論時顯示進度、完成、停止或失敗。
const discussion = computed(() => {
  const value = snapshot.value.discussion;
  if (!value) return undefined;
  return snapshot.value.tasks.some(task => task.discussionId === value.id) ? value : undefined;
});
const summaryTask = computed(() => snapshot.value.tasks.find(task => task.id === discussion.value?.summaryTaskId && task.status === 'completed' && task.output));
function adoptSummary() {
  // 帶入結論後回到一般模式，由使用者自己選權限送出。
  if (summaryTask.value) kind.value = 'solo';
  if (summaryTask.value) insert.value = { text: `依照下面的討論結論處理：\n\n${summaryTask.value.output}`, revision: (insert.value?.revision ?? 0) + 1 };
}
// 只列出已授權、可用且不是卡住的那個 Provider；實際送出前 Host 仍會再檢查。
const alternatives = computed(() => {
  const blocked = discussion.value?.blocked?.provider;
  return snapshot.value.providers.filter(provider => provider.id !== blocked && provider.status === 'ready' && snapshot.value.policy.allowedProviders.includes(provider.id)).map(provider => provider.id);
});
function resolveDiscussion(decision: 'retry' | 'substitute' | 'end', provider?: AgentId) {
  if (discussion.value) post({ version: 1, type: 'resolve-discussion', requestId: crypto.randomUUID(), discussionId: discussion.value.id, decision, provider });
}
function extendDiscussion(rounds: number) {
  if (discussion.value) send({ version: 1, type: 'extend-discussion', requestId: crypto.randomUUID(), discussionId: discussion.value.id, rounds });
}
function cancel() {
  // 討論中即使位於回合之間也能停止，Host 會阻止後續回合。
  if (snapshot.value.activeTaskId || snapshot.value.discussionId) post({ version: 1, type: 'cancel-task', requestId: crypto.randomUUID(), taskId: snapshot.value.activeTaskId ?? '' });
}
</script>

<template>
  <main class="workspace">
    <header class="chat-toolbar"><button type="button" class="conversation-title text-button" :disabled="navigationLocked" :aria-expanded="historyShown" @click="historyShown = !historyShown; historyQuery = ''; historyFilters = {}">{{ historyShown ? '歷史對話' : conversationTitle }}</button><div><span v-if="!historyShown" class="mode-tabs" role="group" aria-label="送出方式"><button v-for="item in kinds" :key="item.id" type="button" :aria-pressed="kind === item.id" :disabled="busy" @click="kind = item.id">{{ item.label }}</button></span><button type="button" class="icon-button" aria-label="歷史對話" :disabled="navigationLocked" :aria-pressed="historyShown" @click="historyShown = !historyShown; historyQuery = ''; historyFilters = {}"><ChatIcon name="history" /></button><button type="button" class="icon-button" aria-label="新增對話" :disabled="navigationLocked" @click="action('new-conversation'); historyShown = false"><ChatIcon name="new" /></button></div></header>
    <AgentPanel v-if="!historyShown && !needsLogin" :kind="kind" :accounts="snapshot.accounts ?? []" :selected-accounts="snapshot.selectedAccounts ?? {}" :provider="selected" :models="catalog" :providers="snapshot.providers" :preferences-of="preferencesOf" :busy="busy" @solo="chooseSolo" @preferences="setAccountPreferences" @team="(members, lead) => team = { members, lead }" @rounds="value => rounds = value" />
    <p v-if="historyShown && error" class="error notice" role="alert">{{ error }}</p>
    <HistoryPanel v-if="historyShown" :conversations="history" :active-id="snapshot.conversationId" :busy="navigationLocked" :searching="historySearching" :providers="snapshot.policy.allowedProviders" @search="historySearch" @open="openConversation" @rename="renameConversation" @delete="deleteConversation" />
    <Conversation v-else :key="snapshot.conversationId" :tasks="snapshot.tasks" :focus="focus" :has-earlier="!!snapshot.hasEarlier" :external-changes="snapshot.externalChanges ?? 0" @earlier="post({ version: 1, type: 'load-earlier', requestId: newRequestId() })" @reload="snapshot.conversationId && openConversation(snapshot.conversationId)" @reject="rejectAnswer" />
    <div v-if="!historyShown" class="input-area">
      <p v-if="error" class="error notice" role="alert">{{ error }}</p>
      <div v-else-if="notice" class="notice" role="status"><span>{{ notice.text }}</span><button v-if="notice.action" type="button" class="text-button" :disabled="busy" @click="action(notice.action)">{{ notice.action === 'authorize-workspace' ? '授權' : '設定' }}</button></div>
      <DiscussionBar v-if="discussion && !error && !notice" :discussion="discussion" :busy="busy" :summary-ready="!!summaryTask" :alternatives="alternatives" @extend="extendDiscussion" @adopt="adoptSummary" @resolve="resolveDiscussion" />
      <HybridBar v-if="hybrid && !error" :hybrid="hybrid" />
      <ApprovalCard v-for="request in snapshot.approvals ?? []" :key="request.id" :request="request" :background="!!request.conversationId && request.conversationId !== snapshot.conversationId" @answer="answerApproval" />
      <LoginCard v-if="needsLogin" :accounts="snapshot.accounts ?? []" :busy="snapshot.checking" @login="login" @api-key="loginWithKey" />
      <QueuedMessages v-if="queued.length" :items="queued" :can-steer="canSteer" :can-send="canSend && !busy" :running="running" @steer="steerQueued" @send="sendQueued" @edit="editQueued" @remove="take" />
      <Composer :insert="insert" :approval-mode="soloPreferences.approvalMode" :supported-approval-modes="snapshot.providers.find(item => item.id === selected)?.approvalModes" :busy="composerBusy" :running="running || !!snapshot.discussionId" :can-send="canSend" :can-write="canWrite" :kind="kind" :kind-ready="kindReady" :send-shortcut="settings.sendShortcut" :default-mode="settings.defaultMode" :initial-draft="draft" :draft-revision="draftRevision" @send="compose" @cancel="cancel" @draft="saveDraft" />
    </div>
  </main>
</template>
