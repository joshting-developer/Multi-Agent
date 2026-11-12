import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { ConversationSummary, HostToWebview, Snapshot, WebviewToHost } from '../../../src/bridge/messages';
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
  const settingsSaving = ref(false);
  const settingsSaved = ref(0);
  let settingsRequestId: string | undefined;
  let pendingRequestId: string | undefined;
  const running = computed(() => !!snapshot.value.activeTaskId);
  const post = (message: WebviewToHost) => { error.value = ''; api.postMessage(message); };
  function receive(event: MessageEvent<HostToWebview>) {
    const message = event.data;
    if (!message || message.version !== 1) return;
    if (message.type === 'snapshot') {
      if (snapshot.value.conversationId && snapshot.value.conversationId !== message.snapshot.conversationId) draftRevision.value++;
      snapshot.value = message.snapshot;
      if (message.snapshot.activeTaskId) {
        if (submitting.value) draftRevision.value++;
        submitting.value = false; pendingRequestId = undefined;
      }
    } else if (message.type === 'conversation-results') {
      if (message.requestId === searchRequestId) { searchResults.value = message.conversations; historySearching.value = false; }
    } else if (message.type === 'settings-saved') {
      if (message.requestId === settingsRequestId) { settingsSaving.value = false; settingsRequestId = undefined; settingsSaved.value++; }
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
  function searchConversations(query: string) {
    searchRequestId = crypto.randomUUID(); historySearching.value = true;
    post({ version: 1, type: 'search-conversations', requestId: searchRequestId, query });
  }
  function send(message: Extract<WebviewToHost, { type: 'send-message' | 'start-discussion' }>) {
    submitting.value = true; pendingRequestId = message.requestId; post(message);
  }
  function saveSettings(settings: WorkspaceSettings) {
    settingsRequestId = crypto.randomUUID(); settingsSaving.value = true;
    post({ version: 1, type: 'save-settings', requestId: settingsRequestId, settings });
  }
  onMounted(() => { window.addEventListener('message', receive); post({ version: 1, type: 'ready', requestId: crypto.randomUUID() }); });
  onUnmounted(() => window.removeEventListener('message', receive));
  const cached = api.getState();
  const draft = typeof cached === 'object' && cached !== null && 'draft' in cached && typeof cached.draft === 'string' ? cached.draft : '';
  return { navigating, navigate, searchConversations, searchResults, historySearching, snapshot, error, running, submitting, draftRevision, post, send, draft, saveDraft: (draft: string) => api.setState({ draft }), saveSettings, settingsSaving, settingsSaved };
}
