import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一般聊天會保留官方原生 Session；smoke 測試結束時只刪這個臨時工作區留下的紀錄，不動使用者其他 Session。 */
export async function removeSmokeSessions(directory: string, since: number): Promise<void> {
  await rm(join(homedir(), '.claude', 'projects', directory.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await stat(path)).mtimeMs >= since && (await readFile(path, 'utf8')).includes(directory)) await rm(path);
    }
  };
  await walk(join(homedir(), '.codex', 'sessions'));
}
