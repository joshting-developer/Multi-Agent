<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AgentId, ExecutionMode } from '../../../src/bridge/messages';
import ProviderPicker from './ProviderPicker.vue';
import ChatIcon from './ChatIcon.vue';
import ModelPicker from './ModelPicker.vue';
import { approvalLabels, approvalModes, type ApprovalMode, type ModelOption, type ProviderPreferences } from '../../../src/bridge/preferences';
const props = withDefaults(defineProps<{
  busy: boolean; running: boolean; canSend: boolean; initialDraft: string; draftRevision?: number; canWrite?: boolean; provider?: AgentId;
  approvalMode?: ApprovalMode; supportedApprovalModes?: ApprovalMode[]; preferences?: ProviderPreferences; models?: ModelOption[]; modelsLoading?: boolean; sendShortcut?: 'enter' | 'modifier-enter'; defaultMode?: ExecutionMode;
}>(), { approvalMode: 'ask', supportedApprovalModes: () => [...approvalModes], provider: 'codex', draftRevision: 0, canWrite: true, preferences: () => ({ model: '', effort: 'medium' }), models: () => [], modelsLoading: false, sendShortcut: 'enter', defaultMode: 'workspace-write' });
const emit = defineEmits<{ send: [text: string, mode: ExecutionMode, approvalMode: ApprovalMode]; discuss: [text: string, rounds: number]; cancel: []; draft: [text: string]; select: [id: AgentId]; preferences: [value: ProviderPreferences]; settings: []; refreshModels: [] }>();
const text = ref(props.initialDraft);
const approval = ref<ApprovalMode>(props.approvalMode);
watch(() => props.approvalMode, value => { approval.value = value; });
watch(() => props.provider, () => { approval.value = props.approvalMode; });
const mode = ref<ExecutionMode>(props.canWrite === false ? 'read-only' : props.defaultMode);
const modeChosen = ref(false);
const discussion = ref(false);
const rounds = ref(4);
const valid = computed(() => props.canSend && props.supportedApprovalModes.includes(approval.value) && !props.busy && text.value.trim().length > 0 && text.value.length <= 32000);
watch(text, value => emit('draft', value));
watch(() => props.draftRevision, () => { text.value = ''; });
watch(() => props.canWrite, value => {
  if (value === false) mode.value = 'read-only';
  else if (!modeChosen.value) mode.value = props.defaultMode;
});
watch(() => props.defaultMode, value => { if (!modeChosen.value) mode.value = value === 'workspace-write' && !props.canWrite ? 'read-only' : value; });
function submit() {
  if (!valid.value) return;
  if (discussion.value) emit('discuss', text.value.trim(), rounds.value);
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
    <textarea id="message" v-model="text" rows="3" maxlength="32000" placeholder="想做什麼都可以" :disabled="busy" @keydown="onKey"></textarea>
    <div class="composer-footer">
      <div class="composer-options">
        <ProviderPicker :selected="provider" :busy="busy" @select="$emit('select', $event)" />
        <ModelPicker :provider="provider" :value="preferences" :models="models" :busy="busy" :loading="modelsLoading" @change="$emit('preferences', $event)" @settings="$emit('settings')" @refresh="$emit('refreshModels')" />
        <button type="button" class="permission-picker discussion-toggle" :aria-pressed="discussion" :disabled="busy" @click="discussion = !discussion">討論</button>
        <select v-if="discussion" v-model.number="rounds" class="permission-picker" :disabled="busy" aria-label="討論回合"><option v-for="count in [2, 3, 4, 5, 6, 7, 8]" :key="count" :value="count">{{ count }} 輪</option></select>
        <template v-else>
          <select v-model="approval" class="permission-picker approval-picker" :disabled="busy || mode === 'read-only'" aria-label="動作核准"><option v-for="item in approvalModes" :key="item" :value="item" :disabled="!supportedApprovalModes.includes(item)">{{ approvalLabels[item] }}</option></select>
          <select v-model="mode" class="permission-picker" :disabled="busy" aria-label="任務權限" @change="modeChosen = true"><option value="read-only">唯讀</option><option value="workspace-write" :disabled="canWrite === false">可編輯</option></select>
        </template>
      </div>
      <div class="composer-actions">
        <button v-if="running" type="button" class="send-button stop" aria-label="停止任務" title="停止任務" @click="$emit('cancel')"><ChatIcon name="stop" /></button>
        <button v-else type="submit" class="send-button" :disabled="!valid" aria-label="送出訊息" :title="sendShortcut === 'enter' ? '送出（Enter）；換行（Shift+Enter）' : '送出（⌘ / Ctrl + Enter）'"><ChatIcon name="send" /></button>
      </div>
    </div>
  </form>
</template>
