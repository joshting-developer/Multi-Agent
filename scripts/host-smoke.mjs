import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { captureChat } from './capture-chat.mjs';

await build({ entryPoints: ['test/e2e/run.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: 'dist/e2e.cjs' });
const directory = await mkdtemp(join(tmpdir(), 'multi-agent-host-'));
const workspace = join(directory, 'workspace');
await mkdir(workspace);
await writeFile(join(workspace, 'README.md'), '# Empty smoke-test workspace\n');
await build({ entryPoints: ['test/e2e/seed.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/history-seed.cjs' });
const { seed } = await import('../dist/history-seed.cjs');
await seed(join(directory, 'user-data', 'User', 'globalStorage', 'local-workspace.multi-agent-workspace', 'conversations.sqlite'), await realpath(workspace), resolve('dist/sqlite/sql-wasm.wasm'));
const executable = process.env.VSCODE_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const screenshot = process.env.MULTI_AGENT_SCREENSHOT;
let debugPort;
if (screenshot) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  debugPort = server.address().port;
  await new Promise(resolve => server.close(resolve));
  environment.MULTI_AGENT_CAPTURE_READY = join(directory, 'capture-ready');
  environment.MULTI_AGENT_CAPTURE_DONE = join(directory, 'capture-done');
}
try {
  const child = spawn(executable, [
    '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    '--user-data-dir', join(directory, 'user-data'), '--extensions-dir', join(directory, 'extensions'),
    ...(screenshot ? [`--remote-debugging-port=${debugPort}`] : []),
    '--extensionDevelopmentPath=' + resolve('.'), '--extensionTestsPath=' + resolve('dist/e2e.cjs'), workspace
  ], { env: environment, stdio: 'inherit', shell: false });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 60000);
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  try {
    const capture = screenshot ? (async () => {
      const deadline = Date.now() + 25000;
      while (true) {
        try { await access(environment.MULTI_AGENT_CAPTURE_READY); break; } catch { /* Wait for the webview handshake. */ }
        if (Date.now() > deadline) throw new Error('Extension Host did not become ready for capture');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await captureChat(debugPort, screenshot, process.env.MULTI_AGENT_CAPTURE_SURFACE ?? 'chat');
      if (process.env.MULTI_AGENT_CAPTURE_SURFACE === 'history') await captureChat(debugPort, screenshot.replace(/\.png$/, '.settings.png'), 'settings');
      await writeFile(environment.MULTI_AGENT_CAPTURE_DONE, 'captured');
    })() : Promise.resolve();
    const [code] = await Promise.all([exit, capture]);
    if (code !== 0) throw new Error(`Extension Host smoke test exited with ${code}`);
  } catch (error) { child.kill('SIGTERM'); throw error; }
  finally { clearTimeout(timer); }
} finally { await rm(directory, { recursive: true, force: true }); }
