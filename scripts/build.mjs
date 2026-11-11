import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true });

await mkdir('dist/sqlite', { recursive: true });
await copyFile('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sqlite/sql-wasm.wasm');
