import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentId } from '../bridge/messages';

export async function resolveExecutable(id: AgentId, configured = ''): Promise<string | undefined> {
  if (configured && !isAbsolute(configured)) throw new Error('CLI 設定必須是執行檔的絕對路徑，不接受命令或參數。');
  const names = process.platform === 'win32' ? [`${id}.exe`] : [id];
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const candidates = configured ? [configured] : dirs.flatMap(dir => names.map(name => join(dir, name)));
  if (!configured && id === 'codex') {
    const extensionRoot = join(homedir(), '.vscode/extensions');
    try {
      const entries = (await readdir(extensionRoot)).filter(name => name.startsWith('openai.chatgpt-')).sort().reverse();
      const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      for (const entry of entries) candidates.push(join(extensionRoot, entry, 'bin', `${platform}-${arch}`, names[0]!));
    } catch { /* Official extension is optional. */ }
  }
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try next path. */ }
  }
  return undefined;
}
