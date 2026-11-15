<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AccountSummary, AgentId } from '../../../src/bridge/messages';
import type { ModelOption, ProviderPreferences } from '../../../src/bridge/preferences';
import ProviderPicker from './ProviderPicker.vue';
import HybridPicker from './HybridPicker.vue';
import type { ChatKind, HybridMember } from '../queue';
const props = defineProps<{ kind: ChatKind; accounts: AccountSummary[]; selectedAccounts: Partial<Record<AgentId, string>>; provider: AgentId; models: Record<AgentId, ModelOption[]>; defaults: Record<AgentId, ProviderPreferences>; busy: boolean }>();
const emit = defineEmits<{ discussion: [partner: AgentId, partnerAccountId: string | undefined, rounds: number]; hybrid: [members: HybridMember[], lead: number] }>();
const rounds = ref(4);
// 審查方預設與提案方相同（同 Agent 討論），手動選擇後才固定。
const partner = ref<AgentId>(props.provider);
const partnerChosen = ref(false);
watch(() => props.provider, value => { if (!partnerChosen.value) partner.value = value; });
// 來源與帳號在同一個選單；審查方的來源與帳號可以和提案方不同。
const partnerAccounts = computed(() => props.accounts.filter(account => account.provider === partner.value));
const partnerAccount = ref<string>();
// 沒有明確選過審查帳號時跟著該來源目前使用中的帳號。
watch(() => props.selectedAccounts[partner.value], value => { if (!partnerChosen.value) partnerAccount.value = value; }, { immediate: true });
function choosePartner(provider: AgentId, accountId?: string) { partnerChosen.value = true; partner.value = provider; partnerAccount.value = accountId ?? props.selectedAccounts[provider]; }
watch([partner, partnerAccount, rounds, partnerAccounts], () => emit('discussion', partner.value, partnerAccounts.value.length > 1 ? partnerAccount.value : undefined, rounds.value), { immediate: true });
</script>

<template>
  <!-- 討論與混合的設定放在標題列下方，輸入框只留送出時的選項。 -->
  <div v-if="kind !== 'solo'" class="mode-bar">
    <template v-if="kind === 'discussion'">
      <ProviderPicker class="permission-picker partner-picker" label="審查 Agent" prefix="審查：" :selected="partner" :account="partnerAccount" :accounts="accounts" :busy="busy" @select="choosePartner" />
      <select v-model.number="rounds" class="permission-picker" :disabled="busy" aria-label="討論回合"><option v-for="count in [2, 3, 4, 5, 6, 7, 8]" :key="count" :value="count">{{ count }} 輪</option></select>
    </template>
    <HybridPicker v-else :accounts="accounts" :models="models" :defaults="defaults" :selected-accounts="selectedAccounts" :provider="provider" :busy="busy" @change="(members, lead) => emit('hybrid', members, lead)" />
  </div>
</template>
