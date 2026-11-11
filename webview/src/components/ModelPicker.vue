<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentId } from '../../../src/bridge/messages';
import { effortLabels, type ModelOption, type ProviderPreferences } from '../../../src/bridge/preferences';
import ModelFields from './ModelFields.vue';
const props = defineProps<{ provider: AgentId; value: ProviderPreferences; models: ModelOption[]; busy: boolean; loading: boolean }>();
defineEmits<{ change: [value: ProviderPreferences]; settings: []; refresh: [] }>();
const menu = ref<HTMLDetailsElement>();
const label = computed(() => {
  const model = props.value.model ? props.models.find(model => model.id === props.value.model)?.label ?? props.value.model : '選擇模型';
  return `${model} · ${effortLabels[props.value.effort]}`;
});
</script>

<template>
  <details ref="menu" class="model-menu" @keydown.esc="menu?.removeAttribute('open')">
    <summary aria-label="模型與推理強度" :title="label">{{ label }}</summary>
    <div class="model-popover">
      <ModelFields :provider="provider" :value="value" :models="models" :disabled="busy" @change="$emit('change', $event)" />
      <button v-if="provider === 'codex'" type="button" class="text-button" :disabled="loading" @click="$emit('refresh')">{{ loading ? '載入模型中…' : '重新載入模型' }}</button>
      <button type="button" class="text-button" @click="menu?.removeAttribute('open'); $emit('settings')">開啟設定</button>
    </div>
  </details>
</template>
