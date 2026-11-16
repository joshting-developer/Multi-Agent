<script setup lang="ts">
import { ref } from 'vue';
import type { AccountSummary, AgentId } from '../../../src/bridge/messages';
import { providerLabel } from '../../../src/bridge/labels';
const props = defineProps<{ accounts: AccountSummary[]; busy: boolean }>();
// 官方登入：已有未登入的帳號就登入它，沒有才新增；API Key 交給 Host 存進鑰匙圈，不留在畫面上。
const emit = defineEmits<{ login: [provider: AgentId, accountId?: string]; apiKey: [provider: AgentId, key: string] }>();
const providers: AgentId[] = ['claude', 'codex'];
const keyOpen = ref<AgentId>();
const key = ref('');
const pending = (provider: AgentId) => props.accounts.find(account => account.provider === provider && account.loggedIn === false);
function submitKey(provider: AgentId) {
  if (!key.value.trim()) return;
  emit('apiKey', provider, key.value.trim()); key.value = ''; keyOpen.value = undefined;
}
</script>

<template>
  <section class="login-card" aria-label="登入 Agent">
    <div v-for="provider in providers" :key="provider" class="login-provider">
      <div class="login-row">
        <strong>{{ providerLabel(provider) }}</strong>
        <span class="login-actions">
          <button type="button" class="primary-button" :disabled="busy" @click="emit('login', provider, pending(provider)?.id)">官方登入</button>
          <button type="button" class="secondary-button" :disabled="busy" :aria-expanded="keyOpen === provider" @click="keyOpen = keyOpen === provider ? undefined : provider; key = ''">API Key</button>
        </span>
      </div>
      <form v-if="keyOpen === provider" class="login-key" @submit.prevent="submitKey(provider)">
        <input v-model="key" type="password" maxlength="400" autocomplete="off" :placeholder="provider === 'claude' ? 'sk-ant-…' : 'sk-…'" :aria-label="`${provider === 'claude' ? 'Anthropic' : 'OpenAI'} API Key`" />
        <button type="submit" class="secondary-button" :disabled="busy || !key.trim()">新增</button>
      </form>
    </div>
  </section>
</template>
