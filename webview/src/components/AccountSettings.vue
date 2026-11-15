<script setup lang="ts">
import { ref } from 'vue';
import type { AccountSummary, AgentId } from '../../../src/bridge/messages';
withDefaults(defineProps<{ accounts?: AccountSummary[]; selected?: Partial<Record<AgentId, string>>; checking: boolean }>(), { accounts: () => [], selected: () => ({}) });
const emit = defineEmits<{ refresh: []; add: [provider: AgentId, apiKey?: string]; rename: [id: string, name: string]; remove: [id: string]; terminal: [id: string, action: 'login' | 'logout']; select: [provider: AgentId, id: string]; reset: [id: string, creditId?: string] }>();
const providers: AgentId[] = ['codex', 'claude'];
const methods = ref<Record<AgentId, 'cli' | 'api-key'>>({ codex: 'cli', claude: 'cli' });
const keys = ref<Record<AgentId, string>>({ codex: '', claude: '' });
const ready = (provider: AgentId) => methods.value[provider] === 'cli' || !!keys.value[provider].trim();
const editing = ref(''); const title = ref('');
function add(provider: AgentId) {
  if (!ready(provider)) return;
  if (methods.value[provider] === 'api-key') emit('add', provider, keys.value[provider].trim());
  else emit('add', provider);
  keys.value[provider] = '';
}
// 同一來源有兩個帳號登入的是同一個帳戶（同一 email）時標出來，避免以為是兩份額度。
const sameAs = (account: AccountSummary, list: AccountSummary[]) => account.account?.email ? list.find(item => item.id !== account.id && item.provider === account.provider && item.account?.email === account.account?.email) : undefined;
const time = (value: number) => new Date(value).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// 官方回報已用比例；介面顯示剩餘，用完時是 0%，避免誤以為還能用。
const day = (value: number) => new Date(value).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
const remaining = (used: number) => Math.max(0, Math.min(100, Math.round(100 - used)));
function rename(id: string) {
  if (title.value.trim()) emit('rename', id, title.value.trim());
  editing.value = '';
}
</script>

<template>
  <!-- 放在最上面：帳號一多時不用捲到底才能重新整理。 -->
  <div class="account-toolbar"><button type="button" class="secondary-button" :disabled="checking" @click="emit('refresh')">{{ checking ? '檢查中…' : '重新整理登入資訊' }}</button></div>
  <section v-for="provider in providers" :key="provider" class="settings-card">
    <h2>{{ provider === 'codex' ? 'Codex' : 'Claude Code' }}</h2>
    <ul class="account-list">
      <li v-for="account in accounts.filter(item => item.provider === provider)" :key="account.id" class="account-row">
        <div class="account-main">
          <form v-if="editing === account.id" class="account-rename" @submit.prevent="rename(account.id)">
            <input v-model="title" maxlength="60" :aria-label="`${account.name} 的名稱`" />
            <button type="submit" class="text-button">儲存</button><button type="button" class="text-button" @click="editing = ''">取消</button>
          </form>
          <strong v-else>{{ account.name }}<span v-if="selected[provider] === account.id" class="account-current"> · 使用中</span></strong>
          <small>{{ account.loggedIn === undefined ? '檢查中' : account.loggedIn ? [account.account?.email, account.account?.plan].filter(Boolean).join(' · ') || (account.method === 'api-key' ? 'API Key' : '已登入') : '未登入' }}<template v-if="sameAs(account, accounts)"> · 與「{{ sameAs(account, accounts)!.name }}」是同一個帳戶</template></small>
          <template v-if="account.loggedIn">
            <ul v-if="account.usage" class="usage-list" :aria-label="`${account.name} 的用量`">
              <li v-for="window in account.usage.windows" :key="window.label"><span>{{ window.label }}</span><meter min="0" max="100" low="20" high="50" optimum="100" :value="remaining(window.usedPercent)" :aria-label="`${window.label} 剩餘 ${remaining(window.usedPercent)}%`"></meter><span>剩 {{ remaining(window.usedPercent) }}%<template v-if="window.resetsAt"> · {{ time(window.resetsAt) }} 重置</template></span></li>
              <li class="usage-note">{{ account.usage.blocked ? '目前額度已用完 · ' : '' }}{{ account.usage.source === 'last-run' ? '最近一次執行' : '更新' }} {{ time(account.usage.updatedAt) }}<template v-if="account.usage.resetCredits"> · 重置券 {{ account.usage.resetCredits }} 張</template></li>
            </ul>
            <ul v-if="account.usage?.resetCreditList?.length" class="credit-list" :aria-label="`${account.name} 的重置券`">
              <li v-for="credit in account.usage.resetCreditList" :key="credit.id"><span>{{ credit.title ?? '重置券' }}<small v-if="credit.expiresAt"> · {{ day(credit.expiresAt) }} 到期</small></span><button type="button" class="text-button" @click="emit('reset', account.id, credit.id)">使用</button></li>
            </ul>
            <small v-if="!account.usage">{{ provider === 'claude' ? '執行一次後顯示用量' : '無法取得用量' }}</small>
          </template>
        </div>
        <div class="account-actions">
          <button v-if="account.loggedIn && account.usage?.resetCredits && !account.usage.resetCreditList?.length" type="button" class="text-button" @click="emit('reset', account.id)">使用重置券</button>
          <button v-if="selected[provider] !== account.id" type="button" class="text-button" :disabled="!account.loggedIn" @click="emit('select', provider, account.id)">設為使用中</button>
          <button v-if="!(provider === 'claude' && account.method === 'api-key')" type="button" class="text-button" @click="emit('terminal', account.id, account.loggedIn ? 'logout' : 'login')">{{ account.loggedIn ? '登出' : '登入' }}</button>
          <button type="button" class="text-button" @click="editing = account.id; title = account.name">重新命名</button>
          <button type="button" class="text-button" @click="emit('remove', account.id)">移除</button>
        </div>
      </li>
    </ul>
    <form class="account-add" @submit.prevent="add(provider)">
      <select v-model="methods[provider]" :aria-label="`${provider === 'codex' ? 'Codex' : 'Claude Code'} 登入方式`"><option value="cli">官方登入</option><option value="api-key">API Key</option></select>
      <input v-if="methods[provider] === 'api-key'" v-model="keys[provider]" type="password" maxlength="400" autocomplete="off" :placeholder="provider === 'claude' ? 'sk-ant-…' : 'sk-…'" :aria-label="`${provider === 'codex' ? 'OpenAI' : 'Anthropic'} API Key`" />
      <button type="submit" class="secondary-button" :disabled="!ready(provider)">{{ methods[provider] === 'api-key' ? '新增' : '新增帳號並登入' }}</button>
    </form>
  </section>
</template>
