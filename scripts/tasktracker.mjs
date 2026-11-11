import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Temporary session/CSRF client, scoped to this repository's configured project. */
export class TrackerClient {
  cookies = new Map();
  csrf = '';
  constructor(config) { this.config = config; }
  async request(path, input, retry = true) {
    const headers = { Accept: 'application/json', Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
    if (input !== undefined) {
      headers['Content-Type'] = 'application/json'; headers['X-CSRF-TOKEN'] = this.csrf;
      if (path.startsWith('/api/rpc/') && !path.endsWith('/getWorkspace')) headers['X-Workspace-ID'] = this.config.workspaceId;
    }
    const response = await fetch(new URL(path, this.config.baseUrl), { method: input === undefined ? 'GET' : 'POST', headers, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(30000) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]; const index = pair.indexOf('=');
      if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    this.csrf = response.headers.get('X-CSRF-TOKEN') || this.csrf;
    if (response.status === 419 && retry) { await this.initializeCsrf(); return this.request(path, input, false); }
    let result;
    try { result = await response.json(); } catch { throw new Error(`TaskTracker 回傳非 JSON（HTTP ${response.status}）。`); }
    if (path === '/api/csrf-cookie') return result;
    if (!response.ok || !result.ok) throw new Error(`${result.error?.code || response.status}: ${result.error?.message || 'TaskTracker 操作失敗'}`);
    return result.data;
  }
  async initializeCsrf() { const result = await this.request('/api/csrf-cookie'); this.csrf = result.csrfToken; }
  async connect() {
    await this.initializeCsrf();
    await this.request('/api/auth/login', { email: this.config.email, password: this.config.password });
    let workspace = await this.request('/api/rpc/getWorkspace', {});
    if (workspace.meta.workspace.id !== this.config.workspaceId) {
      await this.request('/api/auth/switchWorkspace', { workspaceId: this.config.workspaceId });
      workspace = await this.request('/api/rpc/getWorkspace', {});
    }
    if (workspace.meta.workspace.id !== this.config.workspaceId || !workspace.projects.some(project => project.id === this.config.projectId)) throw new Error('TaskTracker 工作區或專案資格不符合本機設定。');
    return workspace;
  }
  call(operation, input) { return this.request(`/api/rpc/${operation}`, input); }
  async logout() { await this.request('/api/auth/logout', {}); }
}
const summary = issue => ({ identifier: issue.identifier, id: issue.id, title: issue.title, type: issue.type, state: issue.state, priority: issue.priority, assignee: issue.assignee, epicId: issue.epicId, revision: issue.revision });
async function payload(path) { return JSON.parse(path === '-' ? readFileSync(0, 'utf8') : await readFile(path, 'utf8')); }
async function main() {
  const [command, target, path] = process.argv.slice(2);
  if (!['list', 'get', 'create', 'update', 'comment'].includes(command)) {
    console.log('用法：npm run tracker -- list [state] | get MA-編號 | create JSON檔或- | update MA-編號 JSON檔或- | comment MA-編號 JSON檔或-'); return;
  }
  const config = JSON.parse(await readFile(new URL('../.local/tasktracker.json', import.meta.url), 'utf8'));
  const client = new TrackerClient(config);
  try {
    const workspace = await client.connect();
    const issues = workspace.issues.filter(issue => issue.projectId === config.projectId);
    const existing = issues.find(issue => issue.id === target || issue.identifier === target);
    let result;
    if (command === 'list') result = issues.filter(issue => !target || issue.state === target).map(summary);
    else if (command === 'get') { if (!existing) throw new Error('找不到本專案的工項。'); result = existing; }
    else if (command === 'create') {
      const input = await payload(target);
      if (input.projectId && input.projectId !== config.projectId) throw new Error('拒絕操作其他專案。');
      for (const id of [input.epicId, input.parentIssueId, ...(input.relatedIssueIds || [])].filter(Boolean)) if (!issues.some(issue => issue.id === id)) throw new Error('關聯工項不屬於本專案。');
      result = await client.call('createIssue', { ...input, projectId: config.projectId, assignee: input.assignee ?? workspace.meta.userId, requestId: input.requestId || randomUUID() });
    } else {
      if (!existing) throw new Error('找不到本專案的工項。');
      const input = await payload(path);
      if ((input.id && input.id !== existing.id) || (input.projectId && input.projectId !== config.projectId)) throw new Error('拒絕操作其他工項或專案。');
      result = await client.call(command === 'update' ? 'updateIssue' : 'addComment', { ...input, id: existing.id, expectedRevision: input.expectedRevision ?? existing.revision, requestId: input.requestId || randomUUID() });
    }
    console.log(JSON.stringify(result, null, 2));
  } finally { await client.logout().catch(() => undefined); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.code === 'ENOENT' ? '缺少 .local/tasktracker.json 或輸入 JSON 檔。私有登入設定不可提交。' : error.message); process.exitCode = 1; });
}
