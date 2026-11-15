<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ExecutionMode } from '../../../src/bridge/messages';
import ChatIcon from './ChatIcon.vue';
import type { ChatKind } from '../queue';
import { approvalModes, type ApprovalMode } from '../../../src/bridge/preferences';
const props = withDefaults(defineProps<{
  busy: boolean; running: boolean; canSend: boolean; initialDraft: string; draftRevision?: number; canWrite?: boolean;
  /** 帳號、模型、強度與核准方式都在標題列下方的成員面板選；這裡只帶入目前帳號的核准方式。 */
  insert?: { text: string; revision: number }; approvalMode?: ApprovalMode; supportedApprovalModes?: ApprovalMode[]; kind?: ChatKind; kindReady?: boolean; sendShortcut?: 'enter' | 'modifier-enter'; defaultMode?: ExecutionMode;
}>(), { insert: undefined, approvalMode: 'ask', supportedApprovalModes: () => [...approvalModes], draftRevision: 0, canWrite: true, kind: 'solo', kindReady: true, sendShortcut: 'enter', defaultMode: 'workspace-write' });
const emit = defineEmits<{ send: [text: string, mode: ExecutionMode, approvalMode: ApprovalMode, images?: PastedImage[]]; cancel: []; draft: [text: string] }>();
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
const approval = computed(() => props.approvalMode);
const mode = ref<ExecutionMode>(props.canWrite === false ? 'read-only' : props.defaultMode);
const modeChosen = ref(false);
// 討論與混合需要文字、不能帶圖片；執行中只能排一般訊息。混合另外需要成員設定完成。
const valid = computed(() => props.canSend && props.supportedApprovalModes.includes(approval.value) && !props.busy && text.value.length <= 32000
  && (props.kind === 'solo' ? text.value.trim().length > 0 || images.value.length > 0 : text.value.trim().length > 0 && !images.value.length && !props.running && props.kindReady));
watch(text, value => emit('draft', value));
watch(() => props.draftRevision, () => { text.value = ''; clearImages(); });
// 討論結論只帶入輸入框，由使用者自己選模式後送出，不自動執行。
watch(() => props.insert?.revision, async () => {
  if (!props.insert) return;
  text.value = props.insert.text.slice(0, 32000);
  await nextTick(); input.value?.focus();
});
watch(() => props.canWrite, value => {
  if (value === false) mode.value = 'read-only';
  else if (!modeChosen.value) mode.value = props.defaultMode;
});
watch(() => props.defaultMode, value => { if (!modeChosen.value) mode.value = value === 'workspace-write' && !props.canWrite ? 'read-only' : value; });
function submit() {
  if (!valid.value) return;
  if (images.value.length) emit('send', text.value.trim(), mode.value, approval.value, images.value);
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
        <template v-if="kind !== 'discussion'">
          <select v-model="mode" class="permission-picker" :disabled="busy" aria-label="任務權限" @change="modeChosen = true"><option value="read-only">唯讀</option><option value="workspace-write" :disabled="canWrite === false">可編輯</option></select>
        </template>
      </div>
      <div class="composer-actions">
        <button v-if="running" ref="stop" type="button" class="send-button stop" aria-label="停止任務" title="停止任務" @click="$emit('cancel')"><ChatIcon name="stop" /></button>
        <button v-if="!running || text.trim() || images.length" type="submit" class="send-button" :disabled="!valid" :aria-label="running ? '加入待送清單' : '送出訊息'" :title="(running ? '加入待送清單' : '送出') + (sendShortcut === 'enter' ? '（Enter）；換行（Shift+Enter）' : '（⌘ / Ctrl + Enter）')"><ChatIcon name="send" /></button>
      </div>
    </div>
  </form>
</template>
