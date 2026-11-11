<script setup lang="ts">
import type { ProviderStatus } from '../../../src/bridge/messages';
defineProps<{ providers: ProviderStatus[]; checking: boolean }>();
defineEmits<{ refresh: [] }>();
</script>

<template>
  <section v-for="id in ['codex', 'claude']" :key="id" class="settings-card">
    <h2>{{ id === 'codex' ? 'Codex' : 'Claude Code' }}</h2>
    <template v-for="provider in providers.filter(item => item.id === id)" :key="provider.id">
      <dl v-if="provider.account" class="account-details"><dt>帳號</dt><dd>{{ provider.account.email || '官方 CLI 未提供電子郵件' }}</dd><dt>登入方式</dt><dd>{{ provider.account.type }}</dd><template v-if="provider.account.plan"><dt>方案</dt><dd>{{ provider.account.plan }}</dd></template><template v-if="provider.account.organization"><dt>組織</dt><dd>{{ provider.account.organization }}</dd></template></dl>
      <p v-if="provider.account?.detail || provider.reason || !provider.account" class="setting-description">{{ provider.account?.detail || provider.reason || '尚未取得登入資訊' }}</p>
    </template>
    <p v-if="!providers.some(item => item.id === id)" class="setting-description">尚未檢查登入狀態。</p>
    <details class="advanced-settings"><summary>切換帳號</summary><code>{{ id === 'codex' ? 'codex login' : 'claude auth login' }}</code></details>
  </section>
  <button type="button" class="secondary-button" :disabled="checking" @click="$emit('refresh')">{{ checking ? '檢查中…' : '重新整理登入資訊' }}</button>
</template>
