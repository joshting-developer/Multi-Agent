const { spawn } = require('node:child_process');
const [provider, scenario, ...args] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (args.includes('--version')) {
  console.log(provider === 'claude' ? '2.1.319 (Claude Code)' : 'codex-cli 0.164.0');
} else if (args.includes('--help')) {
  console.log(scenario === 'old' ? '--print --json' : '--restricted --safe-mode --tools --strict-mcp-config --include-partial-messages --settings --no-session-persistence --json --ignore-user-config --ignore-rules --ephemeral --model --effort --approve-for-me --input-format --permission-prompts auto --resume --add-dir');
} else if (args[0] === 'features') {
  console.log('shell_tool stable true\nmulti_agent stable true\nunified_exec stable true\nhooks stable true\napps stable true\nplugins stable true');
} else if (args[0] === 'login' && args[1] === '--with-api-key') {
  // 官方 codex login --with-api-key：Key 從 stdin 讀入，寫進 CODEX_HOME；含 rejected 的 Key 視為無效。
  let input = ''; process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
    if (input.includes('rejected')) { console.error('invalid api key'); process.exitCode = 1; return; }
    require('node:fs').writeFileSync(require('node:path').join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: input.trim() }));
  });
} else if (args[0] === 'auth' || args[0] === 'login') {
  // 每個帳號目錄各自的登入狀態：目錄名稱含 logged-out 視為未登入，email 帶目錄名稱以便辨識。
  const accountDir = process.env.CLAUDE_CONFIG_DIR;
  if (provider === 'claude' && accountDir) console.log(JSON.stringify({ loggedIn: !accountDir.includes('logged-out'), email: `${require('node:path').basename(accountDir)}@example.test`, authMethod: 'claude.ai', accessToken: 'secret-must-not-leak' }));
  else if (provider === 'claude') console.log(JSON.stringify({ loggedIn: scenario !== 'unauthenticated', email: 'claude@example.test', orgName: 'Example Org', authMethod: 'claude.ai', subscriptionType: 'team', accessToken: 'secret-must-not-leak' }));
  else console.log(scenario === 'unauthenticated' ? 'Not logged in' : 'Logged in using ChatGPT');
  if (scenario === 'unauthenticated') process.exitCode = 1;
} else if (args[0] === 'app-server') {
  const readline = require('node:readline').createInterface({ input: process.stdin });
  const requestCwd = () => process.cwd();
  const finish = (text = true) => {
    if (text) emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: JSON.stringify(global.start) } });
    emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  };
  let initialized = false;
  // 兩張可用的券（較晚到期的排前面，驗證畫面依到期時間排序）；用掉的 id 記在帳號目錄的 redeemed。
  const credits = () => {
    const fs = require('node:fs'); const file = process.env.CODEX_HOME && require('node:path').join(process.env.CODEX_HOME, 'redeemed');
    const used = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    return [{ id: 'late', resetType: 'codexRateLimits', status: 'available', grantedAt: 1794518416, expiresAt: 1797110416, title: 'Full reset (Weekly + 5 hr)' }, { id: 'soon', resetType: 'codexRateLimits', status: 'available', grantedAt: 1793568435, expiresAt: 1796160435, title: 'Full reset (Weekly + 5 hr)' }].filter(item => !used.includes(item.id));
  };
  readline.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: { serverInfo: 'fixture' } });
    else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'account/rateLimits/read') emit({ id: message.id, result: { ordinaryUsageAllowed: !(process.env.CODEX_HOME && require('node:fs').existsSync(require('node:path').join(process.env.CODEX_HOME, 'exhausted'))), rateLimitResetCredits: (() => { const left = credits(); return { availableCount: left.length, credits: message.params?.excludeResetCreditDetails ? null : [...left, { id: 'used', resetType: 'codexRateLimits', status: 'redeemed', grantedAt: 1 }] }; })(), rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1794632400 }, secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: null } }, accessToken: 'secret-must-not-leak' } });
    else if (message.method === 'account/rateLimitResetCredit/consume') {
      // 額度用完（exhausted）且還有券時重置並用掉券；否則依官方 outcome 回報。
      const fs = require('node:fs'); const path = require('node:path'); const home = process.env.CODEX_HOME;
      const left = credits(); const credit = message.params.creditId ? left.find(item => item.id === message.params.creditId) : left[0];
      const outcome = !message.params.idempotencyKey ? undefined : !credit ? 'noCredit' : fs.existsSync(path.join(home, 'exhausted')) ? 'reset' : 'nothingToReset';
      if (outcome === 'reset') { fs.rmSync(path.join(home, 'exhausted')); fs.appendFileSync(path.join(home, 'redeemed'), credit.id + '\n'); }
      emit(outcome ? { id: message.id, result: { outcome } } : { id: message.id, error: { message: 'idempotencyKey required' } });
    }
    else if (message.method === 'account/read') emit({ id: message.id, result: { account: { type: 'chatgpt', email: 'codex@example.test', planType: 'pro', accessToken: 'secret-must-not-leak' } } });
    else if (message.method === 'thread/start') { global.start = message.params; emit({ id: message.id, result: { thread: { id: 'rpc-session' } } }); }
    else if (message.method === 'thread/resume') {
      global.start = { ...message.params, resumed: true };
      if (message.params.threadId === 'missing') emit({ id: message.id, error: { message: 'thread not found: missing' } });
      else emit({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      if (scenario === 'images') { emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: JSON.stringify(message.params.input.map(item => item.type === 'image' ? item.url.slice(0, 22) : item.type)) } }); emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); }
      else if (scenario === 'approval') emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'echo approval', cwd: requestCwd(), reason: 'Synthetic test' } });
      else if (scenario === 'tools') {
        emit({ method: 'item/started', params: { item: { id: 'r', type: 'reasoning' } } });
        emit({ method: 'item/started', params: { item: { id: 'c', type: 'commandExecution', command: 'ls missing' } } });
        emit({ method: 'item/completed', params: { item: { id: 'c', type: 'commandExecution', command: 'ls missing', status: 'failed', aggregatedOutput: 'No such file' } } });
        finish();
      } else if (scenario === 'steer') emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'working;' } });
      else finish();
    } else if (message.method === 'turn/steer') {
      // 補充訊息：expectedTurnId 對得上才接受；內容為 reject 時模擬官方拒絕，任務繼續。
      const text = message.params.input[0].text;
      if (message.params.expectedTurnId !== 'turn' || text === 'reject') emit({ id: message.id, error: { code: -32600, message: 'no active turn to steer' } });
      else { emit({ id: message.id, result: { turnId: 'turn' } }); emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: `steered:${text}` } }); finish(false); }
    } else if (message.id === 99 && message.result) { emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: message.result.decision } }); finish(false); }
    else if (message.method === 'model/list') {
      if (!initialized) { emit({ id: message.id, error: { message: 'Initialize first' } }); return; }
      if (scenario === 'rpc-error') { emit({ id: message.id, error: { message: 'unavailable' } }); return; }
      emit({ id: message.id, result: { data: [{ model: message.params.cursor ? 'test-second' : 'test-model', displayName: 'Test Model', isDefault: !message.params.cursor, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: message.params.cursor ? null : 'page-two' } });
    }
  });
} else if (scenario === 'unauthenticated') {
  // 帳號目錄沒有登入：執行時官方 CLI 回報未登入。
  console.error('Not logged in. Please run login.'); process.exitCode = 1;
} else if (scenario === 'exit') {
  console.error('quota exceeded: secret-token-should-never-appear'); process.exitCode = 7;
} else if (scenario === 'timeout' || scenario === 'tree') {
  if (scenario === 'tree') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log(child.pid);
  }
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (scenario === 'invalid') {
  console.log('{broken JSON');
} else if (scenario === 'partial') {
  process.stdout.write('{"type":"turn.completed"}');
} else if (scenario === 'utf8') {
  const bytes = Buffer.from('你好\n');
  process.stdout.write(bytes.subarray(0, 2));
  setTimeout(() => process.stdout.write(bytes.subarray(2)), 15);
} else if (scenario === 'flood') {
  for (let i = 0; i < 3000; i++) emit({ type: 'unknown.future.event', value: i });
  emit({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'done' } });
  emit({ type: 'turn.completed' });
} else if (scenario === 'incomplete') {
  emit({ type: 'turn.started' });
} else if (scenario === 'arguments') {
  process.stdin.setEncoding('utf8');
  let text = ''; process.stdin.on('data', value => { text += value; });
  process.stdin.on('end', () => console.log(JSON.stringify({ args, text, cwd: process.cwd() })));
} else if (provider === 'claude' && scenario === 'approval') {
  const readline = require('node:readline').createInterface({ input: process.stdin });
  readline.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'user') emit({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/synthetic/file.txt', content: 'hello' } } });
    if (message.type === 'control_response') { emit({ type: 'result', subtype: 'success', result: message.response.response.behavior }); }
  });
} else if (provider === 'claude' && scenario === 'images') {
  const readline = require('node:readline').createInterface({ input: process.stdin });
  readline.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'user') emit({ type: 'result', subtype: 'success', result: JSON.stringify(Array.isArray(message.message.content) ? message.message.content.map(block => block.type === 'image' ? `${block.source.type}:${block.source.media_type}:${block.source.data.length}` : block.text) : message.message.content) });
  });
} else if (provider === 'claude' && scenario === 'usage') {
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1794632400, status: 'allowed' }, seven_day: { utilization: 0.9, resetsAt: 1794916800, status: 'allowed' }, seven_day_overage_included: { utilization: 0.04, resetsAt: 1794916800, status: 'allowed' } } } });
  emit({ type: 'result', subtype: 'success', result: 'ok' });
} else if (provider === 'claude' && scenario === 'tools') {
  emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'Read', input: {} } } });
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'notes.txt' } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: [{ type: 'text', text: 'file body' }] }] } });
  emit({ type: 'result', subtype: 'success', result: 'done' });
} else if (provider === 'claude') {
  emit({ type: 'system', session_id: 'claude-session' });
  emit({ type: 'stream_event', event: { type: 'message_start' } });
  emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello ' } } });
  setTimeout(() => {
    emit({ type: 'stream_event', event: { delta: { type: 'text_delta', text: '世界' } } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello 世界' }] } });
    emit({ type: 'result', subtype: 'success', result: 'Hello 世界' });
  }, 40);
} else {
  emit({ type: 'thread.started', thread_id: 'codex-session' });
  emit({ type: 'turn.started' });
  emit({ type: 'item.updated', item: { id: '1', type: 'agent_message', text: 'Hello ' } });
  setTimeout(() => {
    emit({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'Hello 世界' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10 } });
  }, 40);
}
