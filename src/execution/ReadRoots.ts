import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Task } from '../bridge/messages';

/** child 是否等於 parent 或在它底下。 */
export function insideOf(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

const denied = /Operation not permitted|Permission denied/i;
const absolutePath = /(?:^|[\s'"=(])(\/[^\s'"`;|&<>():]+)/g;

/**
 * 從這次執行中被 sandbox 擋下的工具步驟，找出工作區外、尚未授權的資料夾。
 * 只看工具輸出中帶有權限錯誤的那幾行提到的路徑，不讀檔案內容；存在的檔案取它所在的資料夾。
 */
export function blockedFolders(task: Task, cwd: string, roots: string[] = []): string[] {
  const folders = new Set<string>();
  for (const step of task.steps ?? []) if (step.kind === 'tool') for (const folder of foldersIn(step.output ?? '', cwd, roots)) folders.add(folder);
  return [...folders].slice(0, 5);
}
/** 一段工具輸出裡被權限擋下、位於工作區外且尚未授權的資料夾。 */
export function foldersIn(output: string, cwd: string, roots: string[] = []): string[] {
  const folders = new Set<string>();
  {
    for (const match of output.split('\n').filter(line => denied.test(line)).join('\n').matchAll(absolutePath)) {
      const path = match[1]!.replace(/[.,]+$/, '');
      if (insideOf(path, cwd) || roots.some(root => insideOf(path, root)) || !existsSync(path)) continue;
      const folder = statSync(path).isDirectory() ? path : dirname(path);
      if (folder !== '/') folders.add(folder);
    }
  }
  return [...folders].slice(0, 5);
}

const offline = /Could not resolve host|Temporary failure in name resolution|nodename nor servname provided|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|Network is unreachable|network access is (?:disabled|blocked)/i;
/** 這次執行的工具輸出是否出現連不上網的錯誤；只看工具輸出，用來提示允許網路。 */
export function networkBlocked(task: Task): boolean {
  return (task.steps ?? []).some(step => step.kind === 'tool' && offline.test(step.output ?? ''));
}
/** 一段工具輸出是否是連不上網的錯誤。 */
export const offlineIn = (output: string): boolean => offline.test(output);

const browserCrash = /browserType\.launch|Target page, context or browser has been closed|Failed to launch the browser process|Chrome(?:ium)? (?:failed to start|crashed)/i;
/** 一段工具輸出是否是瀏覽器（Playwright、Puppeteer）在沙盒內啟動失敗；macOS 沙盒內 Chrome 無法啟動。 */
export const browserBlockedIn = (output: string): boolean => browserCrash.test(output);
/** 執行中被擋下的權限種類，Host 據此詢問使用者。 */
export type Blocked = { kind: 'network' } | { kind: 'read'; folders: string[] } | { kind: 'browser' };
/** 一個命令的輸出被擋下的原因；工作區已允許的就不再回報。 */
export function blockedBy(output: string, cwd: string, policy: { network?: boolean; readRoots?: string[] }): Blocked[] {
  const found: Blocked[] = [];
  if (!policy.network && offlineIn(output)) found.push({ kind: 'network' });
  const folders = foldersIn(output, cwd, policy.readRoots);
  if (folders.length) found.push({ kind: 'read', folders });
  if (browserBlockedIn(output)) found.push({ kind: 'browser' });
  return found;
}

/**
 * 唯讀資料夾裡不屬於工作區的部分（MA-149）。root 不包含工作區時就是 root 本身；
 * root 是工作區的上層時，逐層列出通往工作區那條路以外的項目，讓 Claude 只對這些禁止修改，工作區仍可寫。
 */
export function outsideWorkspace(root: string, cwd: string): string[] {
  if (!insideOf(cwd, root) || root === cwd) return root === cwd ? [] : [root];
  const parts: string[] = []; let dir = root;
  for (const segment of relative(root, cwd).split(sep)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { /* 讀不到就略過這一層 */ }
    for (const entry of entries) if (entry !== segment) parts.push(join(dir, entry));
    dir = join(dir, segment);
  }
  return parts;
}
