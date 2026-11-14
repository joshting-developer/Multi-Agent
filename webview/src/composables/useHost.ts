import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ConversationSummary, HostToWebview, SearchFilters, Snapshot, WebviewToHost } from '../../../src/bridge/messages';
import type { WorkspaceSettings } from '../../../src/bridge/preferences';

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void; getState(): unknown; setState(value: unknown): void };
const api = acquireVsCodeApi();
export function useHost() {
  const snapshot = ref<Snapshot>({ workspace: '', policy: { classification: 'unclassified', allowedProviders: [] }, providers: [], tasks: [], checking: false, trusted: false });
  const error = ref('');
  const searchResults = ref<ConversationSummary[]>([]);
  const historySearching = ref(false);
  let searchRequestId: string | undefined;
  const submitting = ref(false);
  const navigating = ref(false);
  let navigationRequestId: string | undefined;
  const draftRevision = ref(0);
  const historyRequested = ref(0);
  const settingsSaving = ref(false);
  const settingsSaved = ref(0);
  let settingsRequestId: string | undefined;
  let pendingRequestId: string | undefined;
  let pendingDiscussion = false;
  // 只有目前檢視的對話正在執行才算 running；背景對話執行中仍可在這裡排入新工作。
  const running = computed(() => !!snapshot.value.activeTaskId && snapshot.value.activeConversationId === snapshot.value.conversationId);
  const post = (message: WebviewToHost) => { error.value = ''; api.postMessage(message); };
  function receive(event: MessageEvent<HostToWebview>) {
    const message = event.data;
    if (!message || message.version !== 1) return;
    if (message.type === 'snapshot') {
      if (snapshot.value.conversationId && snapshot.value.conversationId !== message.snapshot.conversationId) draftRevision.value++;
      snapshot.value = message.snapshot;
      // 討論沒有排隊，第一輪開始即代表已受理。
      if (pendingDiscussion && message.snapshot.discussionId) {
        if (submitting.value) draftRevision.value++;
        submitting.value = false; pendingRequestId = undefined; pendingDiscussion = false;
      }
    } else if (message.type === 'show-history') {
      historyRequested.value++;
    } else if (message.type === 'conversation-results') {
      if (message.requestId === searchRequestId) { searchResults.value = message.conversations; historySearching.value = false; }
    } else if (message.type === 'settings-saved') {
      if (message.requestId === settingsRequestId) { settingsSaving.value = false; settingsRequestId = undefined; settingsSaved.value++; }
    } else if (message.type === 'request-accepted') {
      if (message.requestId === pendingRequestId) { draftRevision.value++; submitting.value = false; pendingRequestId = undefined; }
    } else if (message.type === 'request-settled') {
      if (message.requestId === navigationRequestId) { navigating.value = false; navigationRequestId = undefined; }
      if (message.requestId === pendingRequestId) { submitting.value = false; pendingRequestId = undefined; }
    } else if (message.type === 'error') {
      error.value = message.message;
      if (!message.requestId || message.requestId === navigationRequestId) { navigating.value = false; navigationRequestId = undefined; }
      if (message.requestId === searchRequestId) historySearching.value = false;
      if (!message.requestId || message.requestId === settingsRequestId) { settingsSaving.value = false; settingsRequestId = undefined; }
      if (!message.requestId || message.requestId === pendingRequestId) { submitting.value = false; pendingRequestId = undefined; }
    }
  }
  function navigate(message: Extract<WebviewToHost, { type: 'new-conversation' | 'open-conversation' }>) {
    navigating.value = true; navigationRequestId = message.requestId; post(message);
  }
  function searchConversations(query: string, filters: SearchFilters = {}) {
    searchRequestId = crypto.randomUUID(); historySearching.value = true;
    post({ version: 1, type: 'search-conversations', requestId: searchRequestId, query, ...(Object.keys(filters).length && { filters }) });
  }
  function send(message: Extract<WebviewToHost, { type: 'send-message' | 'start-discussion' | 'extend-discussion' }>) {
    submitting.value = true; pendingRequestId = message.requestId; pendingDiscussion = message.type !== 'send-message'; post(message);
  }
  function saveSettings(settings: WorkspaceSettings) {
    settingsRequestId = crypto.randomUUID(); settingsSaving.value = true;
    post({ version: 1, type: 'save-settings', requestId: settingsRequestId, settings });
  }
  onMounted(() => { window.addEventListener('message', receive); post({ version: 1, type: 'ready', requestId: crypto.randomUUID() }); });
  onUnmounted(() => window.removeEventListener('message', receive));
  // 每個對話各自保留草稿；背景任務的事件不會清掉其他對話的草稿。
  const cached = api.getState();
  const drafts: Record<string, string> = typeof cached === 'object' && cached !== null && 'drafts' in cached && typeof cached.drafts === 'object' && cached.drafts ? { ...cached.drafts as Record<string, string> } : {};
  const draftFor = (id = snapshot.value.conversationId ?? '') => drafts[id] ?? '';
  const saveDraft = (draft: string) => { const id = snapshot.value.conversationId ?? ''; if (draft) drafts[id] = draft; else delete drafts[id]; api.setState({ drafts }); };
  const draft = typeof cached === 'object' && cached !== null && 'draft' in cached && typeof cached.draft === 'string' ? cached.draft : '';
  return { historyRequested, navigating, navigate, searchConversations, searchResults, historySearching, snapshot, error, running, submitting, draftRevision, post, send, draft, draftFor, saveDraft, saveSettings, settingsSaving, settingsSaved };
}
