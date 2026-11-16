<script setup lang="ts">
import { classificationLabels, providerLabel, statusLabels } from '../../src/bridge/labels';
import { computed, ref, watch } from 'vue';
import { useHost } from './composables/useHost';
import AccountSettings from './components/AccountSettings.vue';
import ToggleSwitch from './components/ToggleSwitch.vue';
import { approvalModes, approvalLabels, defaultSettings, replyLanguages, replyLanguageLabels, type WorkspaceSettings } from '../../src/bridge/preferences';
import type { AgentFeature, AgentId, WebviewToHost } from '../../src/bridge/messages';
const { snapshot, error, post, saveSettings, settingsSaving, settingsSaved } = useHost();
const section = ref<'general' | 'accounts' | 'workspace'>('general');
const agents: AgentId[] = ['codex', 'claude'];
// 每項標明支援的 Agent；Claude 為了把檔案工具限制在工作區，不讀設定檔，外掛與 hooks 只開放給 Codex。
const featureRows: Array<{ id: AgentFeature; label: string; agents: string }> = [
  { id: 'apps', label: '外掛與 Apps', agents: 'Codex' }, { id: 'mcp', label: 'MCP 伺服器', agents: 'Codex、Claude Code' },
  { id: 'subagents', label: '子 Agent', agents: 'Codex、Claude Code' }, { id: 'browser', label: '瀏覽器與電腦操作', agents: 'Codex' },
  { id: 'memory', label: '記憶', agents: 'Codex、Claude Code' }, { id: 'hooks', label: 'Hooks', agents: 'Codex' },
  { id: 'commands', label: '斜線指令與 Skill', agents: 'Claude Code' }
];
const pathKey = (id: AgentId) => id === 'codex' ? 'codexPath' as const : 'claudePath' as const;
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
function action(type: 'check-providers' | 'refresh-models' | 'authorize-workspace' | 'add-read-root' | 'clear-conversation' | 'backup-history' | 'restore-history') {
  post({ version: 1, type, requestId: crypto.randomUUID() } as WebviewToHost);
}
type AccountMessage = Extract<WebviewToHost, { type: 'add-account' | 'rename-account' | 'remove-account' | 'account-terminal' | 'select-account' | 'use-reset-credit' }>;
function account(message: AccountMessage extends infer M ? M extends AccountMessage ? Omit<M, 'version' | 'requestId'> : never : never) {
  post({ version: 1, requestId: crypto.randomUUID(), ...message } as WebviewToHost);
}
const newId = () => crypto.randomUUID();
</script>

<template>
  <main class="settings-page">
    <nav class="settings-navigation" aria-label="設定分類"><div class="settings-brand">Multi-Agent</div><button type="button" :aria-current="section === 'general' ? 'page' : undefined" @click="section = 'general'">一般</button><button type="button" :aria-current="section === 'workspace' ? 'page' : undefined" @click="section = 'workspace'">工作區與資料</button><button type="button" :aria-current="section === 'accounts' ? 'page' : undefined" @click="section = 'accounts'">帳號</button></nav>
    <form class="settings-content" @submit.prevent="saveSettings(clone(draft))">
      <h1>{{ { general: '一般', accounts: '帳號', workspace: '工作區與資料' }[section] }}</h1>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="section === 'general'">
        <section class="settings-card"><h2>聊天</h2><label class="setting-row"><span>傳送快捷鍵</span><select v-model="draft.sendShortcut" aria-label="傳送快捷鍵"><option value="enter">Enter</option><option value="modifier-enter">⌘ / Ctrl + Enter</option></select></label><label class="setting-row"><span>新對話檔案權限</span><select v-model="draft.defaultMode" aria-label="預設檔案權限"><option value="workspace-write">可編輯</option><option value="read-only">唯讀</option></select></label><label class="setting-row"><span>回覆語言</span><select v-model="draft.replyLanguage" aria-label="回覆語言"><option v-for="item in replyLanguages" :key="item" :value="item">{{ replyLanguageLabels[item] }}</option></select></label></section>
        <section class="settings-card"><h2>執行</h2><label class="setting-row"><span>新帳號預設核准</span><select v-model="draft.approvalMode" aria-label="動作核准"><option v-for="item in approvalModes" :key="item" :value="item">{{ approvalLabels[item] }}</option></select></label></section>
        <!-- 帳號的模型、強度與核准方式在聊天標題列下方的成員面板設定；這裡只留連線與 CLI 路徑。 -->
        <section class="settings-card">
          <h2>Agent 連線</h2>
          <div v-for="id in agents" :key="id" class="setting-row agent-connection"><span>{{ providerLabel(id) }}<small>{{ snapshot.providers.find(item => item.id === id) ? statusLabels[snapshot.providers.find(item => item.id === id)!.status] : '尚未檢查' }}<template v-if="snapshot.providers.find(item => item.id === id)?.version"> · {{ snapshot.providers.find(item => item.id === id)!.version }}</template><template v-if="snapshot.providers.find(item => item.id === id)?.reason"> · {{ snapshot.providers.find(item => item.id === id)!.reason }}</template></small></span><input v-model="draft[pathKey(id)]" :aria-label="`${providerLabel(id)} CLI 路徑`" placeholder="自動偵測 CLI" /></div>
          <p v-if="snapshot.models?.error" class="setting-description" role="status">{{ snapshot.models.error }}</p>
          <div class="settings-card-actions"><button type="button" class="secondary-button" :disabled="snapshot.checking" @click="action('check-providers')">{{ snapshot.checking ? '檢查中…' : '檢查連線' }}</button><button type="button" class="secondary-button" :disabled="snapshot.models?.loading" @click="action('refresh-models')">{{ snapshot.models?.loading ? '載入中…' : '重新載入 Codex 模型' }}</button></div>
        </section>
      </template>
      <AccountSettings v-else-if="section === 'accounts'" :accounts="snapshot.accounts" :selected="snapshot.selectedAccounts" :checking="snapshot.checking" @refresh="action('check-providers')" @add="(provider, apiKey) => account({ type: 'add-account', provider, ...(apiKey !== undefined && { apiKey }) })" @rename="(accountId, name) => account({ type: 'rename-account', accountId, name })" @remove="accountId => account({ type: 'remove-account', accountId })" @terminal="(accountId, action) => account({ type: 'account-terminal', accountId, action })" @select="(provider, accountId) => account({ type: 'select-account', provider, accountId })" @reset="(accountId, creditId) => account({ type: 'use-reset-credit', accountId, ...(creditId && { creditId }) })" />
      <template v-else>
        <section class="settings-card"><h2>工作區授權</h2><p class="workspace-location">{{ snapshot.workspace }}</p><p class="setting-description">資料分類：{{ classificationLabels[snapshot.policy.classification] }}<br>允許的 Agent：{{ snapshot.policy.allowedProviders.map(providerLabel).join('、') || '尚未授權' }}</p><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId" @click="action('authorize-workspace')">設定工作區授權</button></section>
        <section class="settings-card"><h2>工作區外可讀取</h2><ul v-if="snapshot.policy.readRoots?.length" class="read-roots"><li v-for="root in snapshot.policy.readRoots" :key="root"><span>{{ root }}</span><button type="button" class="text-button" :disabled="!!snapshot.activeTaskId" @click="post({ version: 1, type: 'remove-read-root', requestId: newId(), path: root })">移除</button></li></ul><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId" @click="action('add-read-root')">新增資料夾…</button></section>
        <section class="settings-card"><h2>網路</h2><div class="setting-row"><span>允許 Agent 使用網路<small>命令可連網，並可使用網頁搜尋與讀取網頁</small></span><ToggleSwitch :checked="!!snapshot.policy.network" :disabled="!!snapshot.activeTaskId" label="允許 Agent 使用網路" @change="enabled => post({ version: 1, type: 'set-network', requestId: newId(), enabled })" /></div></section>
        <section class="settings-card">
          <h2>Agent 功能</h2>
          <div v-for="row in featureRows" :key="row.id" class="setting-row"><span>{{ row.label }}<small>{{ row.agents }}</small></span><ToggleSwitch :checked="!!snapshot.policy.features?.includes(row.id)" :disabled="!!snapshot.activeTaskId" :label="row.label" @change="enabled => post({ version: 1, type: 'set-agent-feature', requestId: newId(), feature: row.id, enabled })" /></div>
          <p class="setting-description">外掛與 MCP 讀取各帳號自己的設定，需在該帳號底下安裝</p>
        </section>
        <section class="settings-card"><h2>本機紀錄</h2><p class="setting-description">{{ snapshot.conversations?.length ?? 0 }} 個對話</p><div class="settings-card-actions"><button type="button" class="secondary-button" :disabled="!snapshot.tasks.length" @click="post({ version: 1, type: 'export-conversation', requestId: newId(), format: 'markdown' })">匯出目前對話（Markdown）</button><button type="button" class="secondary-button" :disabled="!snapshot.tasks.length" @click="post({ version: 1, type: 'export-conversation', requestId: newId(), format: 'json' })">匯出目前對話（JSON）</button></div><div class="settings-card-actions"><button type="button" class="secondary-button" @click="action('backup-history')">備份歷史資料庫</button><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId || !!snapshot.discussionId" @click="action('restore-history')">從備份還原</button></div><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId || !snapshot.tasks.length" @click="action('clear-conversation')">刪除目前對話</button></section>
        <section class="settings-card"><h2>此專案的資料</h2><div class="setting-row"><span>保存這個專案的對話</span><ToggleSwitch :checked="snapshot.persistent !== false" label="保存這個專案的對話" @change="enabled => post({ version: 1, type: 'set-persistence', requestId: newId(), enabled })" /></div><button type="button" class="secondary-button" :disabled="!!snapshot.activeTaskId || !!snapshot.discussionId" @click="post({ version: 1, type: 'clear-project', requestId: newId() })">刪除此專案所有紀錄</button></section>
      </template>
      <!-- 帳號與工作區的操作都是立即生效；只有還有未儲存的變更時才在那兩頁顯示儲存列。 -->
      <footer v-if="section === 'general' || dirty" class="settings-footer"><span role="status">{{ settingsSaving ? '儲存中…' : saved ? '已儲存' : dirty ? '有尚未儲存的變更' : '' }}</span><button type="button" class="secondary-button" :disabled="!dirty || settingsSaving" @click="reset">還原</button><button type="submit" class="primary-button" :disabled="!dirty || settingsSaving">儲存設定</button></footer>
    </form>
  </main>
</template>
