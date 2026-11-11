import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { vscode: fileURLToPath(new URL('./test/fixtures/vscode.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 10000 }
});
