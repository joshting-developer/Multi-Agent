<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AccountSummary, AgentId, ProviderStatus } from '../../../src/bridge/messages';
import { providerLabel } from '../../../src/bridge/labels';
import { approvalLabels, approvalModes, concretePreferences, effortLabels, type AccountPreferences, type ApprovalMode, type ModelOption, type ReasoningEffort } from '../../../src/bridge/preferences';
import type { ChatKind, HybridMember } from '../queue';
import ChatIcon from './ChatIcon.vue';
const props = defineProps<{
  kind: ChatKind; accounts: AccountSummary[]; selectedAccounts: Partial<Record<AgentId, string>>; provider: AgentId;
  models: Record<AgentId, ModelOption[]>; providers: ProviderStatus[]; preferencesOf: (account: AccountSummary) => AccountPreferences; busy: boolean;
}>();
const emit = defineEmits<{ solo: [provider: AgentId, accountId: string]; preferences: [accountId: string, value: AccountPreferences]; team: [members: HybridMember[], lead: number]; rounds: [value: number] }>();
const menu = ref<HTMLDetailsElement>();
// 只列已登入的帳號；每個帳號各自的模型、推理強度與動作核准會記在帳號上。
const rows = computed(() => props.accounts.filter(account => account.loggedIn));
const soloId = computed(() => props.selectedAccounts[props.provider]);
const picked = ref<Record<string, boolean>>({});
const lead = ref('');
const rounds = ref(4);
// 討論與混合預設勾選各 Agent 使用中的帳號，主帳號（討論的提案方）是目前選定的 Agent。
watch(rows, list => {
  for (const account of list) picked.value[account.id] ??= props.selectedAccounts[account.provider] === account.id;
}, { immediate: true });
const team = computed(() => rows.value.filter(account => picked.value[account.id]));
watch([team, () => props.kind], () => {
  if (!team.value.some(account => account.id === lead.value)) lead.value = team.value.find(account => account.provider === props.provider)?.id ?? team.value[0]?.id ?? '';
}, { immediate: true });
const member = (account: AccountSummary): HybridMember => {
  const value = props.preferencesOf(account);
  return { provider: account.provider, preferences: { model: value.model, effort: value.effort, accountId: account.id }, approvalMode: value.approvalMode };
};
watch([team, lead, () => props.accounts], () => emit('team', team.value.map(member), team.value.findIndex(account => account.id === lead.value)), { immediate: true, deep: true });
watch(rounds, value => emit('rounds', value), { immediate: true });
const efforts = (account: AccountSummary): ReasoningEffort[] => props.models[account.provider].find(model => model.id === props.preferencesOf(account).model)?.efforts ?? (account.provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh']);
const supported = (account: AccountSummary): ApprovalMode[] => props.providers.find(item => item.id === account.provider)?.approvalModes ?? ['ask'];
function change(account: AccountSummary, patch: Partial<AccountPreferences>) {
  const current = props.preferencesOf(account);
  // 換模型時推理強度改成該模型支援的值。
  const model = patch.model ? concretePreferences({ model: patch.model, effort: current.effort }, props.models[account.provider]) : undefined;
  emit('preferences', account.id, { ...current, ...patch, ...(model && { effort: model.effort }) });
}
const modelLabel = (account: AccountSummary) => { const id = props.preferencesOf(account).model; return props.models[account.provider].find(model => model.id === id)?.label ?? (id || '選擇模型'); };
const name = (account?: AccountSummary) => account ? `${providerLabel(account.provider)} · ${account.name}` : '';
const summary = computed(() => {
  if (props.kind === 'solo') {
    const account = rows.value.find(item => item.id === soloId.value);
    if (!account) return '選擇帳號';
    const value = props.preferencesOf(account);
    return `${name(account)} · ${modelLabel(account)} · ${effortLabels[value.effort]} · ${approvalLabels[value.approvalMode]}`;
  }
  const head = team.value.find(account => account.id === lead.value);
  if (props.kind === 'discussion') return team.value.length === 2 ? `提案 ${name(head)} · 審查 ${name(team.value.find(account => account.id !== lead.value))}` : `已選 ${team.value.length} 個帳號`;
  return `成員 ${team.value.length}${head ? ` · 主帳號 ${name(head)}` : ''}`;
});
const problem = computed(() => {
  if (props.kind === 'discussion' && team.value.length !== 2) return '討論需要剛好兩個帳號';
  if (props.kind === 'hybrid' && team.value.length < 2) return '至少選兩個成員';
  if (props.kind === 'hybrid' && team.value.length > 4) return '最多四個成員';
  return '';
});
</script>

<template>
  <!-- 三種送出方式都在這裡選帳號；每個帳號的模型、強度、核准方式各自記住。 -->
  <div class="mode-bar">
    <details ref="menu" class="model-menu agent-menu" @keydown.esc="menu?.removeAttribute('open')">
      <summary :aria-label="kind === 'solo' ? '執行的帳號與模型' : kind === 'discussion' ? '討論的帳號' : '混合模式的成員'" :title="summary"><span class="agent-summary">{{ summary }}</span><ChatIcon name="chevron" class="agent-chevron" /></summary>
      <div class="model-popover agent-popover">
        <p v-if="!rows.length" class="muted">沒有已登入的帳號，請到設定 → 帳號登入</p>
        <ul class="agent-rows">
          <li v-for="account in rows" :key="account.id" :class="{ off: kind === 'solo' ? account.id !== soloId : !picked[account.id] }">
            <label class="agent-name">
              <input v-if="kind === 'solo'" type="radio" name="agent-solo" :checked="account.id === soloId" :disabled="busy" @change="emit('solo', account.provider, account.id)" />
              <input v-else v-model="picked[account.id]" type="checkbox" :disabled="busy" />
              <span>{{ name(account) }}</span>
            </label>
            <label v-if="kind !== 'solo'" class="agent-lead"><input v-model="lead" type="radio" name="agent-lead" :value="account.id" :disabled="busy || !picked[account.id]" />{{ kind === 'discussion' ? '提案' : '主帳號' }}</label>
            <div class="agent-fields">
              <select :value="preferencesOf(account).model" :disabled="busy" :aria-label="`${account.name} 的模型`" @change="change(account, { model: ($event.target as HTMLSelectElement).value })"><option v-if="!preferencesOf(account).model" disabled value="">選擇模型</option><option v-for="item in models[account.provider]" :key="item.id" :value="item.id">{{ item.label }}</option></select>
              <select :value="preferencesOf(account).effort" :disabled="busy" :aria-label="`${account.name} 的推理強度`" @change="change(account, { effort: ($event.target as HTMLSelectElement).value as ReasoningEffort })"><option v-for="effort in efforts(account)" :key="effort" :value="effort">{{ effortLabels[effort] }}</option></select>
              <select :value="preferencesOf(account).approvalMode" :disabled="busy" :aria-label="`${account.name} 的動作核准`" @change="change(account, { approvalMode: ($event.target as HTMLSelectElement).value as ApprovalMode })"><option v-for="item in approvalModes" :key="item" :value="item" :disabled="!supported(account).includes(item)">{{ approvalLabels[item] }}</option></select>
            </div>
          </li>
        </ul>
      </div>
    </details>
    <select v-if="kind === 'discussion'" v-model.number="rounds" class="permission-picker" :disabled="busy" aria-label="討論回合"><option v-for="count in [2, 3, 4, 5, 6, 7, 8]" :key="count" :value="count">{{ count }} 輪</option></select>
    <p v-if="problem" class="muted agent-problem" role="status">{{ problem }}</p>
  </div>
</template>
