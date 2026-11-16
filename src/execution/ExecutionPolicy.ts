import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AgentId, WorkspacePolicy } from '../bridge/messages';
export function assertAuthorized(policy: WorkspacePolicy, provider: AgentId, trusted: boolean): void {
  if (!trusted) throw new Error('請先信任此 VS Code 工作區。');
  if (policy.classification === 'unclassified' || policy.classification === 'restricted') throw new Error('此工作區尚未授權傳送資料。請先設定資料分類與 Provider。');
  if (!policy.allowedProviders.includes(provider)) throw new Error('此 Provider 尚未獲得目前工作區的資料使用授權。');
}

export const protectedPatterns = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/.ssh/**', '**/.aws/**', '**/.codex/**', '**/.claude/**', '**/credentials*', '**/secrets*'];

/** 機密檔名（檔案）與機密資料夾；給 protectedFiles 掃描工作區用。 */
const secretFile = /^(\.env(\..+)?|.+\.(pem|key)|credentials.*|secrets.*)$/i;
const secretFolder = /^\.(ssh|aws|codex|claude)$/;
const skipFolders = new Set(['node_modules', '.git', '.venv', 'venv', 'vendor', 'target', '.next', '.nuxt', '.turbo', '.cache']);
/**
 * 列出工作區內實際存在的機密檔與機密資料夾（相對路徑），給 Codex 沙盒逐一設 deny。
 * Codex 沙盒的萬用字元 deny 會讓工作區內所有資料夾都不能刪除或搬移（MA-143），所以改用實際路徑；
 * 執行中才新增的機密檔不在名單內。掃描有深度與數量上限，略過依賴與版本控制資料夾。
 */
export function protectedFiles(root: string, limits = { depth: 8, entries: 20000, results: 200 }): string[] {
  const found: string[] = []; let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > limits.depth || seen > limits.entries || found.length >= limits.results) return;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > limits.entries || found.length >= limits.results) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (secretFolder.test(entry.name)) found.push(relative(root, path));
        else if (!skipFolders.has(entry.name)) walk(path, depth + 1);
      } else if (secretFile.test(entry.name)) found.push(relative(root, path));
    }
  };
  walk(root, 0);
  return found;
}
