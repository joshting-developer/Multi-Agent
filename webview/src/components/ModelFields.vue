<script setup lang="ts">
import { computed } from 'vue';
import type { AgentId } from '../../../src/bridge/messages';
import { concretePreferences, effortLabels, type ModelOption, type ProviderPreferences, type ReasoningEffort } from '../../../src/bridge/preferences';
const props = withDefaults(defineProps<{ provider: AgentId; value: ProviderPreferences; models: ModelOption[]; disabled?: boolean; custom?: boolean }>(), { disabled: false, custom: false });
const emit = defineEmits<{ change: [preferences: ProviderPreferences] }>();
const selected = computed(() => props.models.find(model => model.id === props.value.model));
const efforts = computed<ReasoningEffort[]>(() => selected.value?.efforts ?? (props.provider === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh']));
const customModel = computed(() => props.value.model && !props.models.some(model => model.id === props.value.model));
function modelChanged(model: string) {
  emit('change', concretePreferences({ model, effort: props.value.effort }, props.models));
}
</script>

<template>
  <div class="model-fields">
    <label>模型<select aria-label="模型" :value="value.model" :disabled="disabled" @change="modelChanged(($event.target as HTMLSelectElement).value)"><option v-if="!value.model" disabled value="">請選擇模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.label }}</option><option v-if="customModel" :value="value.model">{{ value.model }}（自訂）</option></select></label>
    <details v-if="custom" class="advanced-settings"><summary>自訂模型</summary><label>模型 ID<input aria-label="自訂模型 ID" :value="value.model" :disabled="disabled" placeholder="輸入明確的模型 ID" maxlength="180" @input="modelChanged(($event.target as HTMLInputElement).value)"></label></details>
    <label>推理強度<select aria-label="推理強度" :value="value.effort" :disabled="disabled" @change="$emit('change', { model: value.model, effort: ($event.target as HTMLSelectElement).value as ReasoningEffort })"><option v-for="effort in efforts" :key="effort" :value="effort">{{ effortLabels[effort] }}</option></select></label>
  </div>
</template>
