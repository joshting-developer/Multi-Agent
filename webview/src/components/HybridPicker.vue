<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AccountSummary, AgentId } from '../../../src/bridge/messages';
import { providerLabel } from '../../../src/bridge/labels';
import type { ModelOption, ProviderPreferences } from '../../../src/bridge/preferences';
import type { HybridMember } from '../queue';
const props = defineProps<{ accounts: AccountSummary[]; models: Record<AgentId, ModelOption[]>; defaults: Record<AgentId, ProviderPreferences>; selectedAccounts: Partial<Record<AgentId, string>>; provider: AgentId; busy: boolean }>();
const emit = defineEmits<{ change: [members: HybridMember[], lead: number] }>();
const menu = ref<HTMLDetailsElement>();
// 只列已登入的帳號；每個帳號可各自選模型，推理強度沿用該 Agent 的設定。
const rows = computed(() => props.accounts.filter(account => account.loggedIn));
const picked = ref<Record<string, boolean>>({});
const model = ref<Record<string, string>>({});
const lead = ref('');
// 預設勾選各 Agent 目前使用中的帳號，主帳號是輸入框選定的 Agent。
watch(rows, list => {
  for (const account of list) {
    picked.value[account.id] ??= props.selectedAccounts[account.provider] === account.id;
    model.value[account.id] ||= props.defaults[account.provider].model;
  }
  if (!list.some(account => account.id === lead.value && picked.value[account.id])) lead.value = list.find(account => picked.value[account.id] && account.provider === props.provider)?.id ?? list.find(account => picked.value[account.id])?.id ?? '';
}, { immediate: true, deep: true });
const members = computed(() => rows.value.filter(account => picked.value[account.id] && model.value[account.id]));
watch([members, lead, model], () => {
  if (!members.value.some(account => account.id === lead.value)) lead.value = members.value[0]?.id ?? '';
  emit('change', members.value.map(account => ({ provider: account.provider, preferences: { model: model.value[account.id]!, effort: props.defaults[account.provider].effort, accountId: account.id } })), members.value.findIndex(account => account.id === lead.value));
}, { immediate: true, deep: true });
const label = computed(() => `成員 ${members.value.length}`);
</script>

<template>
  <details ref="menu" class="model-menu hybrid-menu" @keydown.esc="menu?.removeAttribute('open')">
    <summary aria-label="混合模式的成員">{{ label }}</summary>
    <div class="model-popover hybrid-popover">
      <ul class="hybrid-members">
        <li v-for="account in rows" :key="account.id">
          <label class="hybrid-member"><input v-model="picked[account.id]" type="checkbox" :disabled="busy" /><span>{{ providerLabel(account.provider) }} · {{ account.name }}</span></label>
          <select v-model="model[account.id]" :disabled="busy || !picked[account.id]" :aria-label="`${account.name} 的模型`"><option v-for="item in models[account.provider]" :key="item.id" :value="item.id">{{ item.label }}</option></select>
          <label class="hybrid-lead"><input v-model="lead" type="radio" name="hybrid-lead" :value="account.id" :disabled="busy || !picked[account.id]" />主帳號</label>
        </li>
      </ul>
      <p v-if="members.length < 2" class="muted">至少選兩個成員</p>
      <p v-else-if="members.length > 4" class="muted">最多四個成員</p>
    </div>
  </details>
</template>
