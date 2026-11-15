import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
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
  for (const step of task.steps ?? []) {
    if (step.kind !== 'tool') continue;
    for (const match of (step.output ?? '').split('\n').filter(line => denied.test(line)).join('\n').matchAll(absolutePath)) {
      const path = match[1]!.replace(/[.,]+$/, '');
      if (insideOf(path, cwd) || roots.some(root => insideOf(path, root)) || !existsSync(path)) continue;
      const folder = statSync(path).isDirectory() ? path : dirname(path);
      if (folder !== '/') folders.add(folder);
    }
  }
  return [...folders].slice(0, 5);
}
