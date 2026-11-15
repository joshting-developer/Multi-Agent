// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import Composer from '../webview/src/components/Composer.vue';
import MessageBody from '../webview/src/components/MessageBody.vue';
import AgentPanel from '../webview/src/components/AgentPanel.vue';
import Conversation from '../webview/src/components/Conversation.vue';
import DiscussionBar from '../webview/src/components/DiscussionBar.vue';
import { webviewMessageSchema, type AccountSummary } from '../src/bridge/messages';
import type { AccountPreferences } from '../src/bridge/preferences';

const panelAccounts = [
  { id: 'c1', provider: 'codex' as const, name: '工作', loggedIn: true },
  { id: 'c2', provider: 'codex' as const, name: '備用', loggedIn: true },
  { id: 'c3', provider: 'codex' as const, name: '登出', loggedIn: false },
  { id: 'a1', provider: 'claude' as const, name: '個人', loggedIn: true, preferences: { model: 'sonnet', effort: 'medium' as const, approvalMode: 'auto-review' as const } }
];
const panelModels = { codex: [{ id: 'gpt', label: 'GPT', efforts: ['low' as const, 'high' as const] }, { id: 'mini', label: 'Mini', efforts: ['medium' as const] }], claude: [{ id: 'sonnet', label: 'Sonnet', efforts: ['medium' as const] }] };
const panelProviders = [{ id: 'codex' as const, status: 'ready' as const, approvalModes: ['ask' as const, 'auto-review' as const, 'full-access' as const], capabilities: { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: true, toolApproval: true, structuredOutput: true } }, { id: 'claude' as const, status: 'ready' as const, approvalModes: ['ask' as const, 'auto-review' as const], capabilities: { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: true, toolApproval: true, structuredOutput: true } }];
const panelPreferences = (account: AccountSummary): AccountPreferences => account.preferences ?? { model: account.provider === 'codex' ? 'gpt' : 'sonnet', effort: account.provider === 'codex' ? 'high' : 'medium', approvalMode: 'ask' };
const panelProps = { accounts: panelAccounts as AccountSummary[], selectedAccounts: { codex: 'c1', claude: 'a1' }, provider: 'codex' as const, models: panelModels, providers: panelProviders, preferencesOf: panelPreferences, busy: false };
const member = (provider: 'codex' | 'claude', accountId: string, model: string, effort: string, approvalMode: string) => ({ provider, preferences: { model, effort, accountId }, approvalMode });

describe('Vue chat', () => {
  it('submits typed messages with the selected permission and keyboard shortcut', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: '' } });
    await wrapper.get('textarea').setValue('hello');
    await wrapper.get('select[aria-label="任務權限"]').setValue('workspace-write');
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(wrapper.emitted('send')).toEqual([['hello', 'workspace-write', 'ask']]);
    wrapper.unmount();
  });
  it('starts a read-only discussion with the chosen round count and labels each speaker', async () => {
    // 討論的帳號與回合在標題列下方的成員面板選；輸入框在討論模式只留送出，不顯示權限。
    const bar = mount(AgentPanel, { props: { ...panelProps, kind: 'discussion' } });
    await bar.get('select[aria-label="討論回合"]').setValue('2');
    expect(bar.emitted('rounds')?.at(-1)).toEqual([2]);
    expect(bar.emitted('team')?.at(-1)).toEqual([[member('codex', 'c1', 'gpt', 'high', 'ask'), member('claude', 'a1', 'sonnet', 'medium', 'auto-review')], 0]);
    expect(bar.get('summary').text()).toBe('提案 Codex · 工作 · 審查 Claude Code · 個人');
    // 討論需要剛好兩個帳號。
    await bar.findAll('.agent-name input')[1]!.setValue(true);
    expect(bar.text()).toContain('討論需要剛好兩個帳號');
    bar.unmount();
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: 'Repository Pattern？', kind: 'discussion' } });
    expect(wrapper.find('select[aria-label="任務權限"]').exists()).toBe(false); expect(wrapper.find('.discussion-toggle').exists()).toBe(false);
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('send')).toEqual([['Repository Pattern？', 'workspace-write', 'ask']]);
    // 執行中不能開始討論。
    await wrapper.setProps({ running: true }); await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('send')).toHaveLength(1);
    wrapper.unmount();
    const base = { provider: 'claude' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, discussionId: 'd' };
    const timeline = mount(Conversation, { props: { tasks: [
      { ...base, id: '1', prompt: '主題', output: '提案', participantId: 'a', participantRole: 'architect' as const, roundNo: 1 },
      { ...base, id: '2', prompt: '內部轉交內容', output: '審查', participantId: 'b', participantRole: 'critic' as const, roundNo: 2 }
    ] } });
    expect(timeline.findAll('.message-label strong').map(label => label.text())).toEqual(['Claude Code A · 提案 · 第 1 輪', 'Claude Code B · 審查 · 第 2 輪']);
    expect(timeline.text()).toContain('主題'); expect(timeline.text()).not.toContain('內部轉交內容');
    timeline.unmount();
  });
  it('shows the current round and offers extension only for a completed discussion under 8 rounds', async () => {
    const bar = mount(DiscussionBar, { props: { busy: false, discussion: { id: 'd', status: 'running' as const, completedRounds: 1, maxRounds: 4 } } });
    expect(bar.text()).toContain('第 2／4 輪'); expect(bar.find('button').exists()).toBe(false);
    await bar.setProps({ discussion: { id: 'd', status: 'completed' as const, completedRounds: 4, maxRounds: 4 } });
    expect(bar.text()).toContain('討論已完成 · 4 輪'); expect(bar.text()).not.toContain('第 4／4 輪');
    expect(bar.findAll('select[aria-label="延長回合"] option').map(option => option.text())).toEqual(['+1 輪', '+2 輪', '+3 輪', '+4 輪']);
    await bar.get('select[aria-label="延長回合"]').setValue('2'); await bar.get('button').trigger('click');
    expect(bar.emitted('extend')).toEqual([[2]]);
    await bar.setProps({ discussion: { id: 'd', status: 'completed' as const, completedRounds: 8, maxRounds: 8 } });
    expect(bar.find('button').exists()).toBe(false);
    await bar.setProps({ discussion: { id: 'd', status: 'cancelled' as const, completedRounds: 3, maxRounds: 4 } });
    expect(bar.get('[role="alert"]').text()).toBe('討論已停止 · 已保留 3 輪'); expect(bar.find('button').exists()).toBe(false);
    bar.unmount();
  });
  it('labels the discussion conclusion and only puts it into the input when the user adopts it', async () => {
    const base = { provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, discussionId: 'd' };
    const timeline = mount(Conversation, { props: { tasks: [{ ...base, id: 's', prompt: '整串輪次轉交內容', output: '共識：(A, R1)', participantId: 's', participantRole: 'summarizer' as const }] } });
    expect(timeline.get('.message-label strong').text()).toBe('Codex · 討論結論'); expect(timeline.text()).not.toContain('整串輪次轉交內容');
    timeline.unmount();
    const bar = mount(DiscussionBar, { props: { busy: false, discussion: { id: 'd', status: 'running' as const, completedRounds: 4, maxRounds: 4 } } });
    expect(bar.text()).toContain('整理結論');
    await bar.setProps({ discussion: { id: 'd', status: 'completed' as const, completedRounds: 4, maxRounds: 4, summaryTaskId: 's' }, summaryReady: true });
    await bar.findAll('button').find(button => button.text() === '帶入結論')!.trigger('click');
    expect(bar.emitted('adopt')).toHaveLength(1);
    bar.unmount();
    const composer = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: '' } });
    await composer.setProps({ insert: { text: '依照下面的討論結論處理：\n\n共識', revision: 1 } });
    expect((composer.get('textarea').element as HTMLTextAreaElement).value).toContain('共識'); expect(composer.emitted('send')).toBeUndefined();
    composer.unmount();
  });
  it('offers retry only for rate limits and names each authorized substitute provider', async () => {
    const waiting = (kind: 'quota' | 'rate-limit') => ({ id: 'd', status: 'waiting' as const, completedRounds: 1, maxRounds: 4, blocked: { kind, provider: 'codex' as const, roundNo: 2 } });
    const bar = mount(DiscussionBar, { props: { busy: true, discussion: waiting('quota'), alternatives: ['claude' as const] } });
    expect(bar.get('[role="alert"]').text()).toContain('Codex 額度已用完 · 第 2 輪');
    expect(bar.findAll('button').map(button => button.text())).toEqual(['改用 Claude Code', '結束']);
    await bar.findAll('button')[0]!.trigger('click'); await bar.findAll('button')[1]!.trigger('click');
    expect(bar.emitted('resolve')).toEqual([['substitute', 'claude'], ['end']]);
    await bar.setProps({ discussion: waiting('rate-limit'), alternatives: [] });
    expect(bar.findAll('button').map(button => button.text())).toEqual(['重試', '結束']);
    bar.unmount();
    const timeline = mount(Conversation, { props: { tasks: [{ id: 't', provider: 'claude' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '轉交', output: '接手', discussionId: 'd', participantId: 'x', participantRole: 'critic' as const, roundNo: 2, substitute: true }] } });
    expect(timeline.get('.message-label strong').text()).toBe('Claude Code B · 審查 · 第 2 輪 · 代替');
    timeline.unmount();
  });
  it('lets the user reject or restore an ordinary answer but not a discussion round', async () => {
    const base = { provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '問', output: '答' };
    const timeline = mount(Conversation, { props: { tasks: [{ ...base, id: 'a' }, { ...base, id: 'b', rejected: true }, { ...base, id: 'c', discussionId: 'd', participantRole: 'architect' as const, roundNo: 1 }] } });
    const buttons = timeline.findAll('.message-label button');
    expect(buttons.map(button => button.text())).toEqual(['不採用', '恢復採用']); expect(timeline.text()).toContain('已不採用');
    await buttons[0]!.trigger('click'); await buttons[1]!.trigger('click');
    expect(timeline.emitted('reject')).toEqual([['a', true], ['b', false]]);
    timeline.unmount();
  });
  it('shows agent text and tools in their real order with collapsed input／output and a status per tool', async () => {
    const steps = [
      { kind: 'text' as const, text: '先看檔案' },
      { kind: 'tool' as const, id: '1', name: 'Read', status: 'done' as const, input: 'notes.txt\nmore', output: 'body' },
      { kind: 'tool' as const, id: '2', name: 'Bash', status: 'failed' as const, input: 'ls missing' },
      { kind: 'text' as const, text: '結論' },
      { kind: 'tool' as const, id: '3', name: 'Bash', status: 'stopped' as const }
    ];
    const timeline = mount(Conversation, { props: { tasks: [{ id: 't', provider: 'claude' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '問', output: '先看檔案結論', steps }] } });
    const parts = timeline.findAll('.assistant-message > .markdown, .assistant-message > details');
    expect(parts.map(part => part.element.tagName === 'DETAILS' ? part.get('strong').text() : part.text())).toEqual(['先看檔案', '讀取檔案', '執行命令', '結論', '執行命令']);
    // 失敗除了紅點也有文字，不只靠顏色。
    expect(timeline.findAll('.tool-step').map(tool => tool.find('summary .failed').exists())).toEqual([false, true, false]);
    const tools = timeline.findAll('details.tool-step');
    expect(tools.map(tool => tool.get('.tool-dot').attributes('aria-label'))).toEqual(['完成', '失敗', '已停止']);
    expect(tools[0]!.get('.tool-summary').text()).toBe('notes.txt'); expect(tools[0]!.attributes('open')).toBeUndefined();
    expect(tools[0]!.findAll('.tool-io pre').map(pre => pre.text())).toEqual(['notes.txt\nmore', 'body']);
    expect(tools[2]!.find('.tool-io').exists()).toBe(false);
    timeline.unmount();
  });
  it('picks one account in normal mode and saves each account own model, effort and approval', async () => {
    const wrapper = mount(AgentPanel, { props: { ...panelProps, kind: 'solo' } });
    // 只列已登入的帳號；摘要寫出目前帳號的模型、強度與核准方式。
    expect(wrapper.findAll('.agent-rows li')).toHaveLength(3);
    expect(wrapper.get('summary').text()).toBe('Codex · 工作 · GPT · 高 · 要求核准');
    await wrapper.findAll('.agent-name input')[2]!.setValue(true);
    expect(wrapper.emitted('solo')).toEqual([['claude', 'a1']]);
    await wrapper.get('select[aria-label="工作 的推理強度"]').setValue('low');
    expect(wrapper.emitted('preferences')?.at(-1)).toEqual(['c1', { model: 'gpt', effort: 'low', approvalMode: 'ask' }]);
    // 換模型時強度改成新模型支援的值；不支援的核准方式不能選。
    await wrapper.get('select[aria-label="工作 的模型"]').setValue('mini');
    expect(wrapper.emitted('preferences')?.at(-1)).toEqual(['c1', { model: 'mini', effort: 'medium', approvalMode: 'ask' }]);
    expect(wrapper.get('select[aria-label="個人 的動作核准"]').findAll('option').map(option => option.attributes('disabled') === undefined)).toEqual([true, true, false]);
    wrapper.unmount();
    const empty = mount(AgentPanel, { props: { ...panelProps, kind: 'solo', accounts: [] as AccountSummary[] } });
    expect(empty.text()).toContain('沒有已登入的帳號'); empty.unmount();
  });
  it('opens a search result at the original message, highlights the keyword and reports a deleted source', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const base = { provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: Date.UTC(2026, 10, 3, 4) };
    const tasks = [{ ...base, id: 'r1', prompt: '第一題', output: '無關' }, { ...base, id: 'r2', prompt: '注入失敗怎麼辦', output: 'Container 注入失敗，要補 bind' }];
    const timeline = mount(Conversation, { props: { tasks, focus: { runId: 'r2', query: '注入失敗', revision: 1 } }, attachTo: document.body });
    await nextTick(); await nextTick();
    const focused = timeline.get('.turn.focused');
    expect(focused.attributes('data-run')).toBe('r2'); expect(focused.findAll('mark').map(item => item.text())).toEqual(['注入失敗', '注入失敗']);
    expect(focused.get('.task-status').text()).not.toBe(''); expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(timeline.find('[role="alert"]').exists()).toBe(false);
    await timeline.setProps({ focus: { runId: 'deleted', query: 'x', revision: 2 } }); await nextTick(); await nextTick();
    expect(timeline.get('[role="alert"]').text()).toBe('找不到原始訊息，可能已刪除');
    timeline.unmount();
  });
  it('offers earlier messages and a reload when another window added messages', async () => {
    const base = { provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '問', output: '答' };
    const timeline = mount(Conversation, { props: { tasks: [{ ...base, id: 'a' }], hasEarlier: true, externalChanges: 2 } });
    expect(timeline.get('[role="status"]').text()).toContain('其他視窗有 2 則新訊息');
    await timeline.get('.load-earlier').trigger('click'); await timeline.findAll('button').find(button => button.text() === '重新載入')!.trigger('click');
    expect(timeline.emitted('earlier')).toHaveLength(1); expect(timeline.emitted('reload')).toHaveLength(1);
    await timeline.setProps({ hasEarlier: false, externalChanges: 0 });
    expect(timeline.find('.load-earlier').exists()).toBe(false); expect(timeline.text()).not.toContain('其他視窗');
    timeline.unmount();
  });
  it('accepts pasted images with preview and removal, sends them with or without text, and leaves text paste alone', async () => {
    URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`); URL.revokeObjectURL = vi.fn();
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: '' } });
    const paste = async (files: File[]) => { const event = new Event('paste', { cancelable: true }) as ClipboardEvent; Object.defineProperty(event, 'clipboardData', { value: { items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })) } }); wrapper.get('textarea').element.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20)); await nextTick(); return event; };
    expect((await paste([])).defaultPrevented).toBe(false);
    await paste([new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }), new File(['x'], 'b.svg', { type: 'image/svg+xml' })]);
    expect(wrapper.findAll('.image-chip')).toHaveLength(1); expect(wrapper.get('[role="alert"]').text()).toContain('只支援');
    await wrapper.get('form').trigger('submit');
    const sent = wrapper.emitted('send') as Array<[string, string, string, Array<{ mime: string; data: string }>]>;
    expect(sent[0]![0]).toBe(''); expect(sent[0]![3].map(image => [image.mime, image.data])).toEqual([['image/png', 'iVBORw==']]);
    await paste([new File(['y'], 'c.png', { type: 'image/png' })]); expect(wrapper.findAll('.image-chip')).toHaveLength(2);
    await wrapper.get('.image-remove').trigger('click'); expect(wrapper.findAll('.image-chip')).toHaveLength(1);
    await wrapper.setProps({ draftRevision: 1 }); expect(wrapper.findAll('.image-chip')).toHaveLength(0);
    wrapper.unmount();
    const timeline = mount(Conversation, { props: { tasks: [{ id: 't', provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '請看', output: '好', attachments: [{ id: 'a', mime: 'image/png', bytes: 2048 }, { id: 'b', mime: 'image/png', bytes: 3 * 1048576 }] }] } });
    expect(timeline.findAll('.attachment-chip').map(chip => chip.text())).toEqual(['圖片 1 · 2 KB', '圖片 2 · 3.0 MB']);
    timeline.unmount();
  });
  it('moves focus to Stop while running and back to the input when the removed control dropped it', async () => {
    const wrapper = mount(Composer, { attachTo: document.body, props: { busy: false, running: false, canSend: true, initialDraft: '' } });
    await wrapper.setProps({ running: true, busy: true }); await nextTick();
    expect(document.activeElement).toBe(wrapper.get('button[aria-label="停止任務"]').element);
    await wrapper.setProps({ running: false, busy: false }); await nextTick();
    expect(document.activeElement).toBe(wrapper.get('textarea').element);
    const outside = document.createElement('input'); document.body.append(outside); outside.focus();
    await wrapper.setProps({ running: true, busy: true }); await nextTick();
    expect(document.activeElement).toBe(outside);
    outside.remove(); wrapper.unmount();
  });
  it('opens workspace read/write by default and keeps a read-only option', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: 'edit file', canWrite: true } });
    expect(wrapper.get<HTMLSelectElement>('select[aria-label="任務權限"]').element.value).toBe('workspace-write');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('send')?.[0]).toEqual(['edit file', 'workspace-write', 'ask']);
    await wrapper.get('select[aria-label="任務權限"]').setValue('read-only');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('send')?.[1]).toEqual(['edit file', 'read-only', 'ask']);
    wrapper.unmount();
  });
  it('preserves an explicit read-only selection when provider detection completes', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: false, initialDraft: 'analyze only', canWrite: false } });
    await wrapper.get('select[aria-label="任務權限"]').setValue('read-only');
    await wrapper.setProps({ canWrite: true, canSend: true });
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('send')?.[0]).toEqual(['analyze only', 'read-only', 'ask']);
    wrapper.unmount();
  });
  it('blocks duplicate sends and exposes Stop while running', async () => {
    const wrapper = mount(Composer, { props: { busy: true, running: true, canSend: true, initialDraft: 'hello' } });
    await wrapper.get('form').trigger('submit'); expect(wrapper.emitted('send')).toBeUndefined();
    await wrapper.get('button[aria-label="停止任務"]').trigger('click'); expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });
  it('clears an accepted draft and disables unsupported provider writes', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: 'retry text', canWrite: false, draftRevision: 0 } });
    expect(wrapper.get('option[value="workspace-write"]').attributes('disabled')).toBeDefined();
    await wrapper.setProps({ draftRevision: 1 });
    expect(wrapper.get('textarea').element.value).toBe('');
    wrapper.unmount();
  });
  it('renders code blocks without executable HTML, links, or remote images', () => {
    const wrapper = mount(MessageBody, { props: { text: '<img src=x onerror="alert(1)">\n[run](command:evil)\n![track](https://evil.example)\n```ts\nconst x = 1\n```' } });
    expect(wrapper.find('img').exists()).toBe(false); expect(wrapper.find('a').exists()).toBe(false);
    expect(wrapper.get('code').text()).toContain('const x = 1');
    expect(wrapper.text()).toContain('<img'); wrapper.unmount();
  });
  it('uses Enter to send while Shift+Enter and IME composition remain input', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: 'hello', canWrite: true } });
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', shiftKey: true });
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', isComposing: true });
    expect(wrapper.emitted('send')).toBeUndefined();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['hello', 'workspace-write', 'ask']]);
    wrapper.unmount();
  });
  it('keeps the main screen compact and only shows authorization when needed', async () => {
    const api = { postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() };
    vi.stubGlobal('acquireVsCodeApi', () => api);
    const { default: App } = await import('../webview/src/App.vue');
    const wrapper = mount(App);
    const snapshot = {
      workspace: '/test-workspace', trusted: true, checking: false, tasks: [],
      policy: { classification: 'unclassified', allowedProviders: [] },
      providers: [{ id: 'codex', status: 'ready', capabilities: { workspaceWrite: true } }],
      accounts: [{ id: 'c1', provider: 'codex', name: '工作', loggedIn: true, preferences: { model: 'test-model', effort: 'high', approvalMode: 'ask' } }], selectedAccounts: { codex: 'c1' },
      models: { codex: [{ id: 'test-model', label: 'Test Model', efforts: ['low', 'high'] }], claude: [], loading: false }
    };
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { version: 1, type: 'snapshot', snapshot } }));
      await nextTick();
      expect(wrapper.text()).not.toMatch(/PROVIDERS|CONVERSATION|Manual|Auto|Dual Review|資料分類|Check connection/);
      expect(wrapper.findAll('.chat-toolbar')).toHaveLength(1);
      expect(wrapper.find('button[aria-label="歷史對話"]').exists()).toBe(true);
      // 視窗重開後 Host 要求先顯示歷史對話；收合後回到原對話。
      expect(wrapper.find('button[aria-label="歷史對話"]').attributes('aria-pressed')).toBe('false');
      window.dispatchEvent(new MessageEvent('message', { data: { version: 1, type: 'show-history' } })); await nextTick();
      expect(wrapper.get('button[aria-label="歷史對話"]').attributes('aria-pressed')).toBe('true');
      await wrapper.get('button[aria-label="歷史對話"]').trigger('click');
      await wrapper.get('.notice button').trigger('click');
      expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'authorize-workspace' }));
      window.dispatchEvent(new MessageEvent('message', { data: { version: 1, type: 'snapshot', snapshot: { ...snapshot, policy: { classification: 'personal', allowedProviders: ['codex'] } } } }));
      await nextTick();
      expect(wrapper.find('.notice').exists()).toBe(false);
      // 模型與強度來自帳號自己記住的設定，摘要列在標題列下方。
      expect(wrapper.get('.agent-menu summary').text()).toBe('Codex · 工作 · Test Model · 高 · 要求核准');
      await wrapper.get('textarea').setValue('讀取 README');
      await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
      expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send-message', provider: 'codex', text: '讀取 README', mode: 'workspace-write', preferences: { model: 'test-model', effort: 'high', accountId: 'c1' }, approvalMode: 'ask' }));
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});
describe('Hybrid mode', () => {
  it('picks members with a lead and shows per-stage speakers and who left', async () => {
    const { default: HybridBar } = await import('../webview/src/components/HybridBar.vue');
    const { default: Conversation } = await import('../webview/src/components/Conversation.vue');
    const wrapper = mount(AgentPanel, { props: { ...panelProps, kind: 'hybrid' } });
    // 預設勾選各 Agent 使用中的帳號，主帳號是目前選定的 Agent；每個成員帶自己的核准方式。
    expect(wrapper.emitted('team')?.at(-1)).toEqual([[member('codex', 'c1', 'gpt', 'high', 'ask'), member('claude', 'a1', 'sonnet', 'medium', 'auto-review')], 0]);
    expect(wrapper.get('summary').text()).toBe('成員 2 · 主帳號 Codex · 工作');
    await wrapper.findAll('.agent-lead input')[2]!.setValue(true);
    expect(wrapper.emitted('team')?.at(-1)?.[1]).toBe(1);
    await wrapper.findAll('.agent-name input')[2]!.setValue(false);
    expect(wrapper.emitted('team')?.at(-1)?.[0]).toHaveLength(1); expect(wrapper.text()).toContain('至少選兩個成員');
    wrapper.unmount();
    const composer = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: '加上匯出', kind: 'hybrid', kindReady: false } });
    // 混合模式由成員決定 Agent 與模型，輸入框不顯示這兩個。
    expect(composer.find('select[aria-label="執行 Agent"]').exists()).toBe(false); expect(composer.find('.model-menu').exists()).toBe(false);
    await composer.get('form').trigger('submit'); expect(composer.emitted('send')).toBeUndefined();
    await composer.setProps({ kindReady: true }); await composer.get('form').trigger('submit'); expect(composer.emitted('send')).toHaveLength(1);
    composer.unmount();
    const bar = mount(HybridBar, { props: { hybrid: { id: 'h', status: 'completed', stage: 'conclusion', members: [{ label: 'Codex · 工作', provider: 'codex', lead: true }, { label: 'Claude Code · 個人', provider: 'claude', left: '環節「補測試」：額度用完' }], steps: [{ title: '寫程式', member: 0, status: 'done' }, { title: '補測試', member: 0, status: 'done' }] } } });
    expect(bar.text()).toContain('混合任務已完成 · 2 個環節'); expect(bar.text()).toContain('Claude Code · 個人 中途離開 · 環節「補測試」：額度用完');
    await bar.setProps({ hybrid: { id: 'h', status: 'running', stage: 'step', members: [{ label: 'Codex · 工作', provider: 'codex', lead: true }], steps: [{ title: '寫程式', member: 0, status: 'running' }] } });
    expect(bar.text()).toBe('混合 · 環節 1／1 · 寫程式 · Codex · 工作');
    const task = { provider: 'codex' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '內部指示', output: 'ok' };
    const timeline = mount(Conversation, { props: { tasks: [{ ...task, id: 'p', hybrid: { id: 'h', stage: 'plan' as const, member: 'Codex · 工作', text: '加上匯出' } }, { ...task, id: 's', hybrid: { id: 'h', stage: 'step' as const, index: 1, title: '寫程式', member: 'Codex · 工作' } }], hasEarlier: false, externalChanges: 0 } });
    // 只顯示一次使用者的原始要求，內部指示不顯示；每則標出成員與階段。
    expect(timeline.findAll('.user-message').map(item => item.text())).toEqual(['加上匯出']); expect(timeline.text()).not.toContain('內部指示');
    expect(timeline.findAll('.message-label strong').map(item => item.text())).toEqual(['Codex · 工作 · 規劃分工', 'Codex · 工作 · 環節 1：寫程式']);
    expect(timeline.findAll('.message-label button')).toHaveLength(0);
    timeline.unmount(); bar.unmount();
  });
});
describe('Queued messages while a task runs', () => {
  it('queues the next message, steers it into a running Codex task and sends the rest after completion', async () => {
    const api = { postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() };
    // useHost 在模組載入時取得 VS Code API；重新載入才會用到這個測試的 mock。
    vi.stubGlobal('acquireVsCodeApi', () => api); vi.resetModules();
    const { default: App } = await import('../webview/src/App.vue');
    const wrapper = mount(App);
    const task = { id: 't1', provider: 'codex', mode: 'read-only', prompt: '修 bug', output: '', status: 'running', startedAt: 1 };
    const base = {
      workspace: '/test-workspace', trusted: true, checking: false, conversationId: 'c1', tasks: [task],
      policy: { classification: 'personal', allowedProviders: ['codex'] },
      providers: [{ id: 'codex', status: 'ready', capabilities: { workspaceWrite: true, steer: true } }],
      accounts: [{ id: 'c1', provider: 'codex', name: '工作', loggedIn: true, preferences: { model: 'test-model', effort: 'high', approvalMode: 'ask' } }], selectedAccounts: { codex: 'c1' },
      models: { codex: [{ id: 'test-model', label: 'Test Model', efforts: ['low', 'high'] }], claude: [], loading: false }
    };
    const deliver = async (data: unknown) => { window.dispatchEvent(new MessageEvent('message', { data })); await nextTick(); };
    const type = async (text: string) => { await wrapper.get('textarea').setValue(text); await wrapper.get('textarea').trigger('keydown', { key: 'Enter' }); };
    const sent = () => api.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'send-message');
    try {
      await deliver({ version: 1, type: 'snapshot', snapshot: { ...base, activeTaskId: 't1', activeConversationId: 'c1' } });
      expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined();
      await type('也補測試'); await type('再整理文件');
      expect(sent()).toHaveLength(0);
      expect(wrapper.findAll('.queued-item').map(item => item.get('.queued-text').text())).toEqual(['也補測試', '再整理文件']);
      expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
      // 立即補充：Host 接受後從清單移除；被拒絕則留著。
      await wrapper.findAll('.queued-item')[0]!.findAll('button').find(button => button.text() === '立即補充')!.trigger('click');
      const steer = api.postMessage.mock.calls.map(([message]) => message).find(message => message.type === 'steer-task');
      expect(steer).toMatchObject({ taskId: 't1', text: '也補測試' });
      await deliver({ version: 1, type: 'request-settled', requestId: steer.requestId }); await nextTick();
      expect(wrapper.findAll('.queued-item')).toHaveLength(1);
      // 輸入框裡正在打的內容不會被自動送出的那則清掉。
      await wrapper.get('textarea').setValue('還在打');
      await deliver({ version: 1, type: 'snapshot', snapshot: { ...base, tasks: [{ ...task, status: 'completed' }] } });
      expect(sent()).toEqual([expect.objectContaining({ provider: 'codex', text: '再整理文件', preferences: expect.objectContaining({ model: 'test-model' }) })]);
      expect(wrapper.findAll('.queued-item')).toHaveLength(0);
      await deliver({ version: 1, type: 'request-accepted', requestId: sent()[0].requestId });
      expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('還在打');
      // 停止或失敗後不自動送出，改由使用者按送出。
      await deliver({ version: 1, type: 'snapshot', snapshot: { ...base, tasks: [{ ...task, id: 't2' }], activeTaskId: 't2', activeConversationId: 'c1' } });
      await type('之後再說');
      await deliver({ version: 1, type: 'snapshot', snapshot: { ...base, tasks: [{ ...task, id: 't2', status: 'cancelled' }] } });
      expect(sent()).toHaveLength(1);
      await wrapper.findAll('.queued-item')[0]!.findAll('button').find(button => button.text() === '送出')!.trigger('click');
      expect(sent().at(-1)).toMatchObject({ text: '之後再說' });
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});
describe('IPC boundary', () => {
  it('rejects arbitrary commands, oversized prompts and unsupported protocol versions', () => {
    expect(webviewMessageSchema.safeParse({ version: 1, requestId: '1', type: 'exec', command: 'rm' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ version: 2, requestId: '1', type: 'ready' }).success).toBe(false);
    expect(webviewMessageSchema.safeParse({ version: 1, requestId: '1', type: 'send-message', provider: 'codex', mode: 'read-only', text: 'x'.repeat(32001) }).success).toBe(false);
  });
  it('accepts a correlated, versioned send', () => {
    expect(webviewMessageSchema.parse({ version: 1, requestId: 'req', type: 'send-message', text: 'hello', provider: 'claude', mode: 'read-only' }).requestId).toBe('req');
  });
});
