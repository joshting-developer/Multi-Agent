<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
const props = defineProps<{ text: string }>();
// Raw HTML and images are disabled. Links are inert text; no command: or external navigation.
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.disable(['image', 'link', 'autolink']);
const rendered = computed(() => markdown.render(props.text));
</script>

<template>
  <!-- HTML is generated exclusively by markdown-it with raw HTML and links disabled. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown" v-html="rendered"></div>
</template>
