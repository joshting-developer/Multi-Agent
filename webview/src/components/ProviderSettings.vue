<script setup lang="ts">
import { statusLabels } from '../../../src/bridge/labels';
import type { AgentId, ProviderStatus } from '../../../src/bridge/messages';
import type { ModelOption, ProviderPreferences } from '../../../src/bridge/preferences';
import ModelFields from './ModelFields.vue';
defineProps<{ provider: AgentId; value: ProviderPreferences; path: string; models: ModelOption[]; status: ProviderStatus | undefined; checking: boolean; loading: boolean }>();
defineEmits<{ change: [value: ProviderPreferences]; pathChange: [path: string]; check: []; refresh: [] }>();
</script>

<template>
  <section class="settings-card provider-settings">
    <div class="settings-card-heading"><h2>{{ provider === 'codex' ? 'Codex' : 'Claude Code' }}</h2><span class="connection-status">{{ status ? statusLabels[status.status] : '尚未檢查' }}</span></div>
    <p v-if="status?.reason" class="setting-description">{{ status.reason }}</p>
    <ModelFields :provider="provider" :value="value" :models="models" custom @change="$emit('change', $event)" />
    <details class="advanced-settings">
      <summary>進階</summary>
      <label>CLI 路徑<input :aria-label="`${provider} CLI 路徑`" :value="path" placeholder="自動偵測" @input="$emit('pathChange', ($event.target as HTMLInputElement).value)" /></label>
      <p v-if="status?.version" class="setting-description">{{ status.version }}</p>
      <p class="setting-description">{{ provider === 'codex' ? '模型來源：Codex App Server' : '模型來源：Claude Code 官方別名；帳號可用性由 CLI 判定。' }}</p>
    </details>
    <div class="settings-card-actions"><button type="button" class="secondary-button" :disabled="checking" @click="$emit('check')">{{ checking ? '檢查中…' : '檢查連線' }}</button><button v-if="provider === 'codex'" type="button" class="secondary-button" :disabled="loading" @click="$emit('refresh')">{{ loading ? '載入中…' : '重新載入模型' }}</button></div>
  </section>
</template>
