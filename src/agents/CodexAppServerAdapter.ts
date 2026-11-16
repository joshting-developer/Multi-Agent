import { toolLabel } from '../bridge/labels';
import type { AgentEvent, AgentRequest } from './AgentAdapter';
import { CodexAdapter } from './CodexAdapter';
import { CodexRpc, readCodexAccount } from './CodexRpc';
import { providerFailure, record, SessionUnavailable, toolText, windowLabel } from './CliAdapter';
import { randomUUID } from 'node:crypto';
import type { AgentFeature, ResetCreditOutcome, UsageSnapshot } from '../bridge/messages';
import { protectedFiles, toolchainPaths } from '../execution/ExecutionPolicy';

/** Codex 官方功能名稱對應到工作區的開關。 */
const codexFeatures: Record<string, AgentFeature> = { multi_agent: 'subagents', apps: 'apps', plugins: 'apps', hooks: 'hooks', browser_use: 'browser', computer_use: 'browser', memories: 'memory' };
export class CodexAppServerAdapter extends CodexAdapter {
  private readonly running = new Map<string, AbortController>();
  // 執行中的 turn：補充訊息用官方 turn/steer 送進同一個 turn。
  private readonly turns = new Map<string, { rpc: CodexRpc; threadId: string; turnId?: string; nextId: number; pending: Map<number, { resolve: () => void; reject: (error: Error) => void }> }>();
  readonly accountEnvKey = 'CODEX_HOME';
  async account(env?: Record<string, string>) {
    if (!this.command) await this.detect();
    if (!this.command) return { loggedIn: false };
    try { const account = await readCodexAccount(this.processes, this.command, this.detectionCwd, env); return account ? { loggedIn: true, account } : { loggedIn: false }; }
    catch { return { loggedIn: false }; }
  }
  authCommand(action: 'login' | 'logout') { return this.command ? [this.command, action] : undefined; }
  /** 官方 codex login --with-api-key：Key 從 stdin 交給 CLI，寫進該帳號自己的 CODEX_HOME。 */
  async apiKeyLogin(key: string, env: Record<string, string>): Promise<void> {
    if (!this.command) await this.detect();
    if (!this.command) throw new Error('找不到 Codex CLI。');
    const result = await this.processes.collect({ command: this.command, args: ['login', '--with-api-key'], cwd: this.detectionCwd, timeoutMs: 20000, input: key, env: { ...process.env, ...env } });
    if (result.code !== 0) throw new Error('Codex 沒有接受這個 API Key，請確認 Key 是否正確。');
  }
  /** 官方 account/rateLimits/read，不建立 thread 或模型推論。 */
  async usage(env?: Record<string, string>): Promise<UsageSnapshot | undefined> {
    if (!this.command) await this.detect();
    if (!this.command) return undefined;
    const rpc = new CodexRpc(this.processes);
    try {
      for await (const message of rpc.messages({ command: this.command, cwd: this.detectionCwd, timeoutMs: 15000, ...(env && { env: { ...process.env, ...env } }) })) {
        if (message.id === 1) rpc.request(2, 'account/rateLimits/read', { excludeResetCreditDetails: false });
        if (message.id !== 2) continue;
        if (message.error) return undefined;
        const result = record(message.result); const limits = record(result.rateLimits);
        const windows = (['primary', 'secondary'] as const).map(key => record(limits[key])).filter(window => typeof window.usedPercent === 'number')
          .map(window => ({ label: windowLabel(typeof window.windowDurationMins === 'number' ? window.windowDurationMins : undefined), usedPercent: Number(window.usedPercent), ...(typeof window.resetsAt === 'number' && { resetsAt: window.resetsAt * 1000 }) }));
        const summary = record(result.rateLimitResetCredits); const credits = summary.availableCount;
        // 明細為 null 時只知道張數；只列出狀態為 available 的券，依到期時間由近到遠。
        const list = Array.isArray(summary.credits) ? summary.credits.map(record).filter(credit => credit.status === 'available' && typeof credit.id === 'string')
          .map(credit => ({ id: String(credit.id), ...(typeof credit.title === 'string' && { title: credit.title.slice(0, 120) }), ...(typeof credit.grantedAt === 'number' && { grantedAt: credit.grantedAt * 1000 }), ...(typeof credit.expiresAt === 'number' && { expiresAt: credit.expiresAt * 1000 }) }))
          .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) : undefined;
        return windows.length ? { windows, updatedAt: Date.now(), source: 'official', ...(result.ordinaryUsageAllowed === false && { blocked: true }), ...(typeof credits === 'number' && { resetCredits: credits }), ...(list && { resetCreditList: list }) } : undefined;
      }
    } catch { return undefined; }
    return undefined;
  }
  /** 官方 account/rateLimitResetCredit/consume：指定 creditId 時用那一張，否則由官方挑下一張；每次使用帶新的 idempotencyKey。 */
  async consumeResetCredit(env?: Record<string, string>, creditId?: string): Promise<ResetCreditOutcome> {
    if (!this.command) await this.detect();
    if (!this.command) throw new Error('找不到 Codex CLI。');
    const rpc = new CodexRpc(this.processes); const idempotencyKey = randomUUID();
    for await (const message of rpc.messages({ command: this.command, cwd: this.detectionCwd, timeoutMs: 30000, ...(env && { env: { ...process.env, ...env } }) })) {
      if (message.id === 1) rpc.request(2, 'account/rateLimitResetCredit/consume', { idempotencyKey, ...(creditId && { creditId }) });
      if (message.id !== 2) continue;
      const outcome = record(message.result).outcome;
      if (message.error || !['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(outcome as string)) throw new Error('Codex 沒有完成重置，請稍後再試或更新 Codex CLI。');
      return outcome as ResetCreditOutcome;
    }
    throw new Error('Codex 沒有回應重置結果，請稍後重新整理確認額度。');
  }
  protected override async inspect(command: string) {
    const status = await super.inspect(command);
    const help = await this.probe(command, ['--help']);
    status.capabilities.toolApproval = true; status.capabilities.resumeSession = status.capabilities.streaming; status.capabilities.steer = status.capabilities.streaming;
    status.approvalModes = help.stdout.includes('--approve-for-me') ? ['ask', 'auto-review', 'full-access'] : ['ask', 'full-access'];
    return status;
  }
  override async *execute(request: AgentRequest): AsyncGenerator<AgentEvent> {
    const status = this.detected ?? await this.detect();
    if (!this.command || status.status !== 'ready') throw new Error(status.reason ?? 'Codex 尚未就緒。');
    const approvalMode = request.approvalMode ?? 'ask';
    if (!status.approvalModes?.includes(approvalMode)) throw new Error('此 Codex 版本不支援所選核准模式，請更新 CLI。');
    if (!request.model || !request.effort) throw new Error('請選擇明確的模型與推理強度。');
    const controller = new AbortController();
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort(); this.running.set(request.taskId, controller);
    const rpc = new CodexRpc(this.processes);
    // 操作這台 Mac（MA-146）：macOS 沙盒內 Chrome 會崩潰、Homebrew 的程式也無法執行，所以改在沙盒外執行；
    // 仍保留核准：要求核准時用 untrusted，非唯讀命令都要使用者核准；代我核准時用 on-request，
    // Codex 要求的核准交給它自己的審查。untrusted 的請求會直接送給使用者、不經審查（MA-148）。
    const host = !!request.features?.includes('host') && request.mode !== 'read-only' && approvalMode !== 'full-access';
    const sandboxed = !host && (approvalMode !== 'full-access' || request.mode === 'read-only');
    const rules = ['"."="' + (request.mode === 'read-only' ? 'read' : 'write') + '"', '".git"="read"', '".agents"="read"', '".vscode"="read"', ...protectedFiles(request.cwd).map(path => `${JSON.stringify(path)}="deny"`)];
    // 工作區外的資料夾只加 read；寫入、網路仍依原本的 profile。
    const toolchain = toolchainPaths();
    const readRoots = [...(request.readRoots ?? []), ...toolchain.read].map(root => `,${JSON.stringify(root)}="read"`).join('') + toolchain.write.map(path => `,${JSON.stringify(path)}="write"`).join('');
    // 工作區開放的功能才打開；其餘維持關閉。MCP 用帳號自己設定資料夾裡的設定。
    const allowed = new Set(request.features ?? []);
    const unlock = [...(allowed.has('mcp') ? ['mcp_servers'] : []), ...(allowed.has('apps') ? ['features.apps', 'features.plugins'] : []), ...(allowed.has('hooks') ? ['features.hooks'] : [])];
    const config = [
      'features.shell_tool=true', ...Object.entries(codexFeatures).filter(([name]) => this.hasFeature(name)).map(([name, feature]) => `features.${name}=${allowed.has(feature)}`),
      'shell_environment_policy.inherit="core"', `web_search="${request.network ? 'live' : 'disabled'}"`,
      ...(sandboxed ? [`permissions.multi_agent={filesystem={":minimal"="read",":workspace_roots"={${rules.join(',')}}${readRoots}},network={enabled=${request.network ? 'true' : 'false'}}}`, 'default_permissions="multi_agent"'] : ['permissions.multi_agent_full={filesystem={":root"="write"},network={enabled=true}}', 'default_permissions="multi_agent_full"'])
    ];
    let threadId: string | undefined;
    const outputs = new Map<string, string>();
    const changes = new Map<string, unknown>();
    try {
      for await (const message of rpc.messages({ command: this.command, cwd: request.cwd, timeoutMs: request.timeoutMs, signal: controller.signal, config, unlock, ...(request.env && { env: { ...process.env, ...request.env } }) })) {
        // 補充訊息的回應另外處理；被拒絕只讓那次補充失敗，不中斷任務。
        const turn = this.turns.get(request.taskId);
        if (turn && typeof message.id === 'number' && !message.method && turn.pending.has(message.id)) {
          const waiting = turn.pending.get(message.id)!; turn.pending.delete(message.id);
          if (message.error) waiting.reject(new Error(`Codex 沒有接受補充：${String(record(message.error).message ?? '請等目前步驟完成再試')}`)); else waiting.resolve();
          continue;
        }
        if (message.error && message.id === 2 && request.resumeSessionId) throw new SessionUnavailable('原生 Session 已無法接續。');
        if (message.error && typeof message.id === 'number') throw providerFailure(JSON.stringify(message.error));
        if (message.id === 1 && !message.method) {
          rpc.request(2, request.resumeSessionId ? 'thread/resume' : 'thread/start', {
            ...(request.resumeSessionId ? { threadId: request.resumeSessionId, excludeTurns: true } : { ephemeral: !request.persist }),
            model: request.model, cwd: request.cwd,
            approvalPolicy: request.mode === 'read-only' || approvalMode === 'full-access' ? 'never' : host && approvalMode === 'ask' ? 'untrusted' : 'on-request',
            approvalsReviewer: approvalMode === 'auto-review' ? 'auto_review' : 'user',
            ...(sandboxed ? {} : { sandbox: 'danger-full-access' }),
            config: sandboxed ? { default_permissions: 'multi_agent' } : {},
            developerInstructions: 'Do not push Git changes, deploy, or perform destructive operations without explicit user authorization. Follow workspace instructions. Approval denials must be respected.'
          });
        } else if (message.id === 2 && !message.method) {
          threadId = String(record(record(message.result).thread).id ?? '');
          if (!threadId) throw new Error('Codex 未建立 Session。');
          this.turns.set(request.taskId, { rpc, threadId, nextId: 100, pending: new Map() });
          rpc.request(3, 'turn/start', { threadId, model: request.model, effort: request.effort, input: [...(request.images ?? []).map(image => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` })), { type: 'text', text: request.prompt, text_elements: [] }] });
        }
        const params = record(message.params);
        if (message.id === 3 && !message.method) { const current = this.turns.get(request.taskId); if (current) current.turnId = String(record(record(message.result).turn).id ?? '') || undefined; }
        if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          const id = String(params.itemId); outputs.set(id, (outputs.get(id) ?? '') + params.delta);
          yield { type: 'text-delta', taskId: request.taskId, text: params.delta };
        }
        if (message.method === 'item/started' || message.method === 'item/completed') {
          const item = record(params.item); const id = String(item.id);
          if (item.type === 'fileChange') changes.set(id, item.changes);
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            const previous = outputs.get(id) ?? '';
            if (item.text.startsWith(previous) && item.text.length > previous.length) yield { type: 'text-delta', taskId: request.taskId, text: item.text.slice(previous.length) };
            outputs.set(id, item.text);
          } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
            if (message.method === 'item/started') yield { type: 'activity', taskId: request.taskId, text: `處理中：${toolLabel(String(item.type ?? 'tool'))}` };
            const done = message.method === 'item/completed';
            yield { type: 'tool', taskId: request.taskId, id, tool: String(item.type ?? 'tool'), phase: done ? 'end' : 'start', input: codexInput(item),
              ...(done && { success: !['failed', 'declined'].includes(String(item.status)), output: toolText(item.aggregatedOutput ?? item.result ?? item.error) }) };
          }
        }
        if (message.method === 'item/autoApprovalReview/started') yield { type: 'activity', taskId: request.taskId, text: 'Codex 正在代你審查動作…' };
        if (message.method === 'item/autoApprovalReview/completed') {
          const review = record(params.review);
          yield { type: 'activity', taskId: request.taskId, text: `自動核准審查：${String(review.status ?? '')} ${String(review.rationale ?? '')}` };
        }
        if (message.method && message.id !== undefined) {
          const method = String(message.method);
          if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
            const title = method.includes('commandExecution') ? '核准執行命令' : method.includes('fileChange') ? '核准修改檔案' : '核准額外權限';
            const detail = JSON.stringify({ command: params.command, cwd: params.cwd, reason: params.reason, network: params.networkApprovalContext, permissions: params.permissions, changes: changes.get(String(params.itemId)), grantRoot: params.grantRoot }, null, 2);
            const allow = request.mode !== 'read-only' && !!request.approve && await request.approve({ title, detail });
            rpc.respond(message.id, method.includes('permissions/') ? { permissions: allow ? params.permissions : {}, scope: 'turn' } : { decision: allow ? 'accept' : 'decline' });
          } else rpc.reject(message.id);
        }
        if (message.method === 'turn/completed') {
          const turn = record(params.turn);
          if (turn.status !== 'completed') throw providerFailure(JSON.stringify(turn.error ?? turn));
          yield { type: 'complete', taskId: request.taskId, sessionId: threadId }; return;
        }
      }
    } finally {
      request.signal.removeEventListener('abort', abort); this.running.delete(request.taskId);
      for (const waiting of this.turns.get(request.taskId)?.pending.values() ?? []) waiting.reject(new Error('任務已結束，補充沒有送出。'));
      this.turns.delete(request.taskId);
    }
  }
  /** 官方 turn/steer：把補充訊息加進執行中的 turn，帶 expectedTurnId 避免送進錯的 turn。 */
  async steer(taskId: string, text: string): Promise<void> {
    const turn = this.turns.get(taskId);
    if (!turn?.turnId) throw new Error('任務還沒開始或已結束，請改為排隊送出。');
    const id = turn.nextId++;
    await new Promise<void>((resolve, reject) => {
      turn.pending.set(id, { resolve, reject });
      turn.rpc.request(id, 'turn/steer', { threadId: turn.threadId, expectedTurnId: turn.turnId, input: [{ type: 'text', text, text_elements: [] }] });
    });
  }
  private hasFeature(name: string): boolean { return this.featureNames.has(name); }
  override async cancel(taskId: string): Promise<void> { this.running.get(taskId)?.abort(); await super.cancel(taskId); }
}
/** 命令、修改的檔案、搜尋或 MCP 工具參數；Codex 各種 item 只取使用者看得懂的部分。 */
function codexInput(item: Record<string, unknown>): string | undefined {
  if (typeof item.command === 'string') return item.command;
  if (Array.isArray(item.changes)) return item.changes.map(change => `${String(record(change).kind ?? '')} ${String(record(change).path ?? '')}`.trim()).join('\n');
  if (typeof item.query === 'string') return item.query;
  if (item.tool) return [`${String(item.server ?? '')} ${String(item.tool)}`.trim(), toolText(item.arguments)].filter(Boolean).join('\n');
  return undefined;
}
