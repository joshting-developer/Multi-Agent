<script setup lang="ts">
import type { AgentId } from '../../../src/bridge/messages';
defineProps<{ selected: AgentId; busy: boolean }>();
defineEmits<{ select: [id: AgentId] }>();
</script>

<template>
  <select class="provider-picker" aria-label="執行 Agent" :value="selected" :disabled="busy" @change="$emit('select', ($event.target as HTMLSelectElement).value as AgentId)">
    <option value="codex">Codex</option><option value="claude">Claude Code</option>
  </select>
</template>
