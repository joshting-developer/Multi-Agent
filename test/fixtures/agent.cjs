const { spawn } = require('node:child_process');
const [provider, scenario, ...args] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (args.includes('--version')) {
  console.log(provider === 'claude' ? '2.1.319 (Claude Code)' : 'codex-cli 0.164.0');
} else if (args.includes('--help')) {
  console.log(scenario === 'old' ? '--print --json' : '--restricted --safe-mode --tools --strict-mcp-config --include-partial-messages --settings --no-session-persistence --json --ignore-user-config --ignore-rules --ephemeral --model --effort --approve-for-me --input-format --permission-prompts auto');
} else if (args[0] === 'features') {
  console.log('shell_tool stable true\nmulti_agent stable true\nunified_exec stable true\nhooks stable true\napps stable true\nplugins stable true');
} else if (args[0] === 'auth' || args[0] === 'login') {
  if (provider === 'claude') console.log(JSON.stringify({ loggedIn: scenario !== 'unauthenticated', email: 'claude@example.test', orgName: 'Example Org', authMethod: 'claude.ai', subscriptionType: 'team', accessToken: 'secret-must-not-leak' }));
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
  readline.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: { serverInfo: 'fixture' } });
    else if (message.method === 'initialized') initialized = true;
    else if (message.method === 'account/read') emit({ id: message.id, result: { account: { type: 'chatgpt', email: 'codex@example.test', planType: 'pro', accessToken: 'secret-must-not-leak' } } });
    else if (message.method === 'thread/start') { global.start = message.params; emit({ id: message.id, result: { thread: { id: 'rpc-session' } } }); }
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      if (scenario === 'approval') emit({ id: 99, method: 'item/commandExecution/requestApproval', params: { command: 'echo approval', cwd: requestCwd(), reason: 'Synthetic test' } });
      else if (scenario === 'tools') {
        emit({ method: 'item/started', params: { item: { id: 'r', type: 'reasoning' } } });
        emit({ method: 'item/started', params: { item: { id: 'c', type: 'commandExecution', command: 'ls missing' } } });
        emit({ method: 'item/completed', params: { item: { id: 'c', type: 'commandExecution', command: 'ls missing', status: 'failed', aggregatedOutput: 'No such file' } } });
        finish();
      } else finish();
    } else if (message.id === 99 && message.result) { emit({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: message.result.decision } }); finish(false); }
    else if (message.method === 'model/list') {
      if (!initialized) { emit({ id: message.id, error: { message: 'Initialize first' } }); return; }
      if (scenario === 'rpc-error') { emit({ id: message.id, error: { message: 'unavailable' } }); return; }
      emit({ id: message.id, result: { data: [{ model: message.params.cursor ? 'test-second' : 'test-model', displayName: 'Test Model', isDefault: !message.params.cursor, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: message.params.cursor ? null : 'page-two' } });
    }
  });
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
