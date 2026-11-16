<script setup lang="ts">
// 只有開關本身可以切換；標題與說明放在外面，點了不會改設定。
defineProps<{ checked: boolean; disabled?: boolean; label: string }>();
const emit = defineEmits<{ change: [value: boolean] }>();
</script>

<template>
  <button type="button" role="switch" class="toggle-switch" :aria-checked="checked" :aria-label="label" :disabled="disabled" @click="emit('change', !checked)"><span class="toggle-knob"></span></button>
</template>
