import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [vue()], base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  build: { outDir: resolve(__dirname, '../dist/webview'), emptyOutDir: true,
    lib: { entry: resolve(__dirname, 'src/main.ts'), formats: ['iife'], name: 'MultiAgent', fileName: () => 'chat.js' },
    cssCodeSplit: false, rollupOptions: { output: { assetFileNames: 'chat.[ext]' } }
  }
});
