<script setup lang="ts">
import { computed } from 'vue';
import type { AccountSummary, AgentId } from '../../../src/bridge/messages';
const props = withDefaults(defineProps<{ selected: AgentId; account?: string; accounts?: AccountSummary[]; busy: boolean; label?: string; prefix?: string }>(), { account: undefined, accounts: () => [], label: '執行 Agent', prefix: '' });
const emit = defineEmits<{ select: [id: AgentId, accountId?: string] }>();
const names: Record<AgentId, string> = { codex: 'Codex', claude: 'Claude Code' };
interface Option { value: string; provider: AgentId; accountId?: string; text: string }
// 來源與帳號合成一個選單：每個帳號一個選項；只有一個帳號時只顯示來源。
const options = computed(() => (['codex', 'claude'] as AgentId[]).flatMap((provider): Option[] => {
  const list = props.accounts.filter(account => account.provider === provider);
  if (list.length <= 1) return [{ value: provider, provider, accountId: list[0]?.id, text: `${props.prefix}${names[provider]}` }];
  return list.map(account => ({ value: `${provider}:${account.id}`, provider, accountId: account.id, text: `${props.prefix}${names[provider]} · ${account.name}${account.loggedIn === false ? '（未登入）' : ''}` }));
}));
const value = computed(() => {
  const own = options.value.filter(option => option.provider === props.selected);
  return (own.find(option => option.accountId === props.account) ?? own[0])?.value ?? props.selected;
});
function change(event: Event) {
  const option = options.value.find(item => item.value === (event.target as HTMLSelectElement).value);
  if (option) emit('select', option.provider, option.accountId);
}
</script>

<template>
  <select class="provider-picker" :aria-label="label" :value="value" :disabled="busy" @change="change">
    <option v-for="option in options" :key="option.value" :value="option.value">{{ option.text }}</option>
  </select>
</template>
