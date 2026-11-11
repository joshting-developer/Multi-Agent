<script setup lang="ts">
import type { ApprovalRequest } from '../../../src/bridge/messages';
defineProps<{ request: ApprovalRequest }>();
defineEmits<{ answer: [id: string, allow: boolean] }>();
</script>

<template>
  <section class="approval-card" role="region" :aria-label="request.title">
    <strong>{{ request.provider === 'codex' ? 'Codex' : 'Claude Code' }} · {{ request.title }}</strong>
    <pre>{{ request.detail }}</pre>
    <div class="settings-card-actions"><button type="button" class="secondary-button" @click="$emit('answer', request.id, false)">拒絕</button><button type="button" class="primary-button" @click="$emit('answer', request.id, true)">核准這次</button></div>
  </section>
</template>
