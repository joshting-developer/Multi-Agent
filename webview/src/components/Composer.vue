<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { AccountSummary, AgentId, ExecutionMode } from '../../../src/bridge/messages';
import ProviderPicker from './ProviderPicker.vue';
import ChatIcon from './ChatIcon.vue';
import ModelPicker from './ModelPicker.vue';
import { approvalLabels, approvalModes, type ApprovalMode, type ModelOption, type ProviderPreferences } from '../../../src/bridge/preferences';
const props = withDefaults(defineProps<{
  busy: boolean; running: boolean; canSend: boolean; initialDraft: string; draftRevision?: number; canWrite?: boolean; provider?: AgentId;
  insert?: { text: string; revision: number }; accounts?: AccountSummary[]; selectedAccounts?: Partial<Record<AgentId, string>>; approvalMode?: ApprovalMode; supportedApprovalModes?: ApprovalMode[]; preferences?: ProviderPreferences; models?: ModelOption[]; modelsLoading?: boolean; sendShortcut?: 'enter' | 'modifier-enter'; defaultMode?: ExecutionMode;
}>(), { insert: undefined, accounts: () => [], selectedAccounts: () => ({}), approvalMode: 'ask', supportedApprovalModes: () => [...approvalModes], provider: 'codex', draftRevision: 0, canWrite: true, preferences: () => ({ model: '', effort: 'medium' }), models: () => [], modelsLoading: false, sendShortcut: 'enter', defaultMode: 'workspace-write' });
const emit = defineEmits<{ send: [text: string, mode: ExecutionMode, approvalMode: ApprovalMode, images?: PastedImage[]]; discuss: [text: string, rounds: number, partner: AgentId, partnerAccountId: string | undefined]; account: [provider: AgentId, accountId: string]; cancel: []; draft: [text: string]; select: [id: AgentId]; preferences: [value: ProviderPreferences]; settings: []; refreshModels: [] }>();
const text = ref(props.initialDraft);
// 貼上的圖片只在送出前留在輸入框；預覽用 blob URL，送出時才轉成 base64。
export interface PastedImage { mime: string; data: string; url: string; bytes: number }
const images = ref<PastedImage[]>([]);
const imageError = ref('');
const imageLimit = { count: 4, bytes: 5 * 1024 * 1024 };
async function onPaste(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => !!file);
  if (!files.length) return;
  event.preventDefault(); imageError.value = '';
  for (const file of files) {
    if (images.value.length >= imageLimit.count) { imageError.value = `最多 ${imageLimit.count} 張圖片`; break; }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { imageError.value = '只支援 PNG、JPEG、GIF、WebP'; continue; }
    if (file.size > imageLimit.bytes) { imageError.value = '單張圖片不能超過 5 MB'; continue; }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    images.value.push({ mime: file.type, data, url: URL.createObjectURL(file), bytes: file.size });
  }
}
function removeImage(index: number) { const [image] = images.value.splice(index, 1); if (image) URL.revokeObjectURL(image.url); }
function clearImages() { for (const image of images.value) URL.revokeObjectURL(image.url); images.value = []; imageError.value = ''; }
const input = ref<HTMLTextAreaElement>();
const stop = ref<HTMLButtonElement>();
// 按鈕被移除（延長、Stop 消失）時焦點會掉到 body：執行中移到 Stop，結束後回到輸入框。
watch(() => props.running, async running => {
  await nextTick();
  if (document.activeElement && document.activeElement !== document.body) return;
  (running ? stop.value : input.value)?.focus();
});
const approval = ref<ApprovalMode>(props.approvalMode);
watch(() => props.approvalMode, value => { approval.value = value; });
watch(() => props.provider, () => { approval.value = props.approvalMode; });
const mode = ref<ExecutionMode>(props.canWrite === false ? 'read-only' : props.defaultMode);
const modeChosen = ref(false);
const discussion = ref(false);
const rounds = ref(4);
// 審查方預設與提案方相同（同 Agent 討論），手動選擇後才固定。
const partner = ref<AgentId>(props.provider);
const partnerChosen = ref(false);
watch(() => props.provider, value => { if (!partnerChosen.value) partner.value = value; });
// 只有同一 Provider 有兩個以上帳號時才顯示帳號選擇；審查方的帳號可以和提案方不同。
const providerAccounts = computed(() => props.accounts.filter(account => account.provider === props.provider));
const partnerAccounts = computed(() => props.accounts.filter(account => account.provider === partner.value));
const partnerAccount = ref<string>();
watch(() => [partner.value, props.selectedAccounts[partner.value]], () => { partnerAccount.value = props.selectedAccounts[partner.value]; }, { immediate: true });
const accountLabel = (account: AccountSummary) => account.loggedIn === false ? `${account.name}（未登入）` : account.name;
const valid = computed(() => props.canSend && props.supportedApprovalModes.includes(approval.value) && !props.busy && (text.value.trim().length > 0 || (!discussion.value && images.value.length > 0)) && text.value.length <= 32000 && (!discussion.value || text.value.trim().length > 0));
watch(text, value => emit('draft', value));
watch(() => props.draftRevision, () => { text.value = ''; clearImages(); });
// 討論結論只帶入輸入框，由使用者自己選模式後送出，不自動執行。
watch(() => props.insert?.revision, async () => {
  if (!props.insert) return;
  text.value = props.insert.text.slice(0, 32000); discussion.value = false;
  await nextTick(); input.value?.focus();
});
watch(() => props.canWrite, value => {
  if (value === false) mode.value = 'read-only';
  else if (!modeChosen.value) mode.value = props.defaultMode;
});
watch(() => props.defaultMode, value => { if (!modeChosen.value) mode.value = value === 'workspace-write' && !props.canWrite ? 'read-only' : value; });
function submit() {
  if (!valid.value) return;
  if (discussion.value) emit('discuss', text.value.trim(), rounds.value, partner.value, partnerAccounts.value.length > 1 ? partnerAccount.value : undefined);
  else if (images.value.length) emit('send', text.value.trim(), mode.value, approval.value, images.value);
  else emit('send', text.value.trim(), mode.value, approval.value);
}
function onKey(event: KeyboardEvent) {
  const shortcut = event.metaKey || event.ctrlKey || (props.sendShortcut === 'enter' && !event.shiftKey);
  if (event.key === 'Enter' && shortcut && !event.isComposing) { event.preventDefault(); submit(); }
}
</script>

<template>
  <form class="composer" @submit.prevent="submit">
    <label for="message" class="sr-only">訊息</label>
    <div v-if="images.length" class="image-strip"><figure v-for="(image, index) in images" :key="image.url" class="image-chip"><img :src="image.url" :alt="`貼上的圖片 ${index + 1}`" /><button type="button" class="image-remove" :aria-label="`移除圖片 ${index + 1}`" :disabled="busy" @click="removeImage(index)">×</button></figure></div>
    <p v-if="imageError" class="error" role="alert">{{ imageError }}</p>
    <textarea id="message" ref="input" v-model="text" rows="3" maxlength="32000" placeholder="想做什麼都可以" :disabled="busy" @keydown="onKey" @paste="onPaste"></textarea>
    <div class="composer-footer">
      <div class="composer-options">
        <ProviderPicker :selected="provider" :busy="busy" @select="$emit('select', $event)" />
        <ModelPicker :provider="provider" :value="preferences" :models="models" :busy="busy" :loading="modelsLoading" @change="$emit('preferences', $event)" @settings="$emit('settings')" @refresh="$emit('refreshModels')" />
        <select v-if="providerAccounts.length > 1" class="permission-picker account-picker" :value="selectedAccounts[provider]" :disabled="busy" aria-label="帳號" @change="$emit('account', provider, ($event.target as HTMLSelectElement).value)"><option v-for="account in providerAccounts" :key="account.id" :value="account.id">{{ accountLabel(account) }}</option></select>
        <button type="button" class="permission-picker discussion-toggle" :aria-pressed="discussion" :disabled="busy" @click="discussion = !discussion">討論</button>
        <select v-if="discussion" v-model="partner" class="permission-picker partner-picker" :disabled="busy" aria-label="審查 Agent" @change="partnerChosen = true"><option value="codex">審查：Codex</option><option value="claude">審查：Claude</option></select>
        <select v-if="discussion && partnerAccounts.length > 1" v-model="partnerAccount" class="permission-picker account-picker" :disabled="busy" aria-label="審查帳號"><option v-for="account in partnerAccounts" :key="account.id" :value="account.id">審查帳號：{{ accountLabel(account) }}</option></select>
        <select v-if="discussion" v-model.number="rounds" class="permission-picker" :disabled="busy" aria-label="討論回合"><option v-for="count in [2, 3, 4, 5, 6, 7, 8]" :key="count" :value="count">{{ count }} 輪</option></select>
        <template v-else>
          <select v-model="approval" class="permission-picker approval-picker" :disabled="busy || mode === 'read-only'" aria-label="動作核准"><option v-for="item in approvalModes" :key="item" :value="item" :disabled="!supportedApprovalModes.includes(item)">{{ approvalLabels[item] }}</option></select>
          <select v-model="mode" class="permission-picker" :disabled="busy" aria-label="任務權限" @change="modeChosen = true"><option value="read-only">唯讀</option><option value="workspace-write" :disabled="canWrite === false">可編輯</option></select>
        </template>
      </div>
      <div class="composer-actions">
        <button v-if="running" ref="stop" type="button" class="send-button stop" aria-label="停止任務" title="停止任務" @click="$emit('cancel')"><ChatIcon name="stop" /></button>
        <button v-else type="submit" class="send-button" :disabled="!valid" aria-label="送出訊息" :title="sendShortcut === 'enter' ? '送出（Enter）；換行（Shift+Enter）' : '送出（⌘ / Ctrl + Enter）'"><ChatIcon name="send" /></button>
      </div>
    </div>
  </form>
</template>
