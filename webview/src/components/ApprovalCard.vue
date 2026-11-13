<script setup lang="ts">
import type { ApprovalRequest } from '../../../src/bridge/messages';
withDefaults(defineProps<{ request: ApprovalRequest; background?: boolean }>(), { background: false });
defineEmits<{ answer: [id: string, allow: boolean] }>();
</script>

<template>
  <section class="approval-card" role="region" :aria-label="request.title">
    <strong>{{ request.provider === 'codex' ? 'Codex' : 'Claude Code' }} · {{ request.title }}<template v-if="background"> · 背景對話</template></strong>
    <pre>{{ request.detail }}</pre>
    <div class="settings-card-actions"><button type="button" class="secondary-button" @click="$emit('answer', request.id, false)">拒絕</button><button type="button" class="primary-button" @click="$emit('answer', request.id, true)">核准這次</button></div>
  </section>
</template>
