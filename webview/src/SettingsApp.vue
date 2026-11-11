<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useHost } from './composables/useHost';
import ProviderSettings from './components/ProviderSettings.vue';
import AccountSettings from './components/AccountSettings.vue';
import { approvalModes, approvalLabels, defaultSettings, type WorkspaceSettings } from '../../src/bridge/preferences';
import type { AgentId, WebviewToHost } from '../../src/bridge/messages';
const { snapshot, error, post, saveSettings, settingsSaving, settingsSaved } = useHost();
const section = ref<'general' | 'agents' | 'accounts' | 'workspace'>('general');
const provider = ref<AgentId>('codex');
const clone = (value: WorkspaceSettings): WorkspaceSettings => JSON.parse(JSON.stringify(value)) as WorkspaceSettings;
const draft = ref(clone(defaultSettings));
const baseline = ref(JSON.stringify(defaultSettings));
const loaded = ref(false);
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value);
const saved = ref(false);
function reset() {
  draft.value = clone(snapshot.value.settings ?? defaultSettings);
  baseline.value = JSON.stringify(draft.value); loaded.value = true;
}
watch(() => JSON.stringify(snapshot.value.settings), () => { if (!loaded.value || (!dirty.value && !settingsSaving.value)) reset(); });
watch(settingsSaved, () => { reset(); saved.value = true; });
watch(dirty, value => { if (value) saved.value = false; });
function action(type: 'check-providers' | 'refresh-models' | 'authorize-workspace' | 'clear-conversation') {
  post({ version: 1, type, requestId: crypto.randomUUID() } as WebviewToHost);
}
const pathKey = computed(() => provider.value === 'codex' ? 'codexPath' : 'claudePath');
</script>

<template>
  <main class="settings-page">
    <nav class="settings-navigation" aria-label="設定分類"><div class="settings-brand">Multi-Agent</div><button type="button" :aria-current="section === 'general' ? 'page' : undefined" @click="section = 'general'">一般</button><button type="button" :aria-current="section === 'agents' ? 'page' : undefined" @click="section = 'agents'">Agent 與模型</button><button type="button" :aria-current="section === 'workspace' ? 'page' : undefined" @click="section = 'workspace'">工作區與資料</button><button type="button" :aria-current="section === 'accounts' ? 'page' : undefined" @click="section = 'accounts'">帳號</button></nav>
    <form class="settings-content" @submit.prevent="saveSettings(clone(draft))">
      <h1>{{ { general: '一般', agents: 'Agent 與模型', accounts: '帳號', workspace: '工作區與資料' }[section] }}</h1>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="section === 'general'">
        <section class="settings-card"><h2>聊天</h2><label class="setting-row"><span>傳送快捷鍵</span><select v-model="draft.sendShortcut" aria-label="傳送快捷鍵"><option value="enter">Enter</option><option value="modifier-enter">⌘ / Ctrl + Enter</option></select></label><label class="setting-row"><span>新對話檔案權限</span><select v-model="draft.defaultMode" aria-label="預設檔案權限"><option value="workspace-write">可編輯</option><option value="read-only">唯讀</option></select></label></section>
        <section class="settings-card"><h2>執行</h2><label class="setting-row"><span>動作核准</span><select v-model="draft.approvalMode" aria-label="動作核准"><option v-for="item in approvalModes" :key="item" :value="item">{{ approvalLabels[item] }}</option></select></label><label class="setting-row"><span>任務時間上限<small>秒（10–3600）</small></span><input v-model.number="draft.timeoutSeconds" type="number" min="10" max="3600" required aria-label="任務時間上限" /></label></section>
      </template>
      <template v-else-if="section === 'agents'">
        <div class="provider-tabs"><button type="button" :aria-pressed="provider === 'codex'" @click="provider = 'codex'">Codex</button><button type="button" :aria-pressed="provider === 'claude'" @click="provider = 'claude'">Claude Code</button></div>
        <p v-if="snapshot.models?.error && provider === 'codex'" class="setting-description" role="status">{{ snapshot.models.error }}</p>
        <ProviderSettings :provider="provider" :value="draft[provider]" :path="draft[pathKey]" :models="snapshot.models?.[provider] ?? []" :status="snapshot.providers.find(item => item.id === provider)" :checking="snapshot.checking" :loading="snapshot.models?.loading ?? false" @change="draft[provider] = $event" @path-change="draft[pathKey] = $event" @check="action('check-providers')" @refresh="action('refresh-models')" />
      </template>
      <AccountSettings v-else-if="section === 'accounts'" :providers="snapshot.providers" :checking="snapshot.checking" @refresh="action('check-providers')" />
      <template v-else>
        <section class="settings-card"><h2>工作區授權</h2><p class="workspace-location">{{ snapshot.workspace }}</p><p class="setting-description">資料分類：{{ snapshot.policy.classification }}<br>允許的 Agent：{{ snapshot.policy.allowedProviders.join('、') || '尚未授權' }}</p><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId" @click="action('authorize-workspace')">設定工作區授權</button></section>
        <section class="settings-card"><h2>本機紀錄</h2><p class="setting-description">{{ snapshot.conversations?.length ?? 0 }} 個對話</p><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId || !snapshot.tasks.length" @click="action('clear-conversation')">刪除目前對話</button></section>
      </template>
      <footer class="settings-footer"><span role="status">{{ settingsSaving ? '儲存中…' : saved ? '已儲存' : dirty ? '有尚未儲存的變更' : '' }}</span><button type="button" class="secondary-button" :disabled="!dirty || settingsSaving" @click="reset">還原</button><button type="submit" class="primary-button" :disabled="!dirty || settingsSaving">儲存設定</button></footer>
    </form>
  </main>
</template>
