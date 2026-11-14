// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import Composer from '../webview/src/components/Composer.vue';
import MessageBody from '../webview/src/components/MessageBody.vue';
import ProviderPicker from '../webview/src/components/ProviderPicker.vue';
import Conversation from '../webview/src/components/Conversation.vue';
import DiscussionBar from '../webview/src/components/DiscussionBar.vue';
import { webviewMessageSchema } from '../src/bridge/messages';

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
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: 'Repository Pattern？' } });
    await wrapper.get('button.discussion-toggle').trigger('click');
    expect(wrapper.find('select[aria-label="任務權限"]').exists()).toBe(false);
    await wrapper.get('select[aria-label="討論回合"]').setValue('2');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('discuss')).toEqual([['Repository Pattern？', 2, 'codex', undefined]]);
    await wrapper.get('select[aria-label="審查 Agent"]').setValue('claude'); await wrapper.get('textarea').setValue('跨 Agent'); await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('discuss')?.at(-1)).toEqual(['跨 Agent', 2, 'claude', undefined]); expect(wrapper.emitted('send')).toBeUndefined();
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
  it('shows agent text and tools in their real order with collapsed IN／OUT and a status per tool', async () => {
    const steps = [
      { kind: 'text' as const, text: '先看檔案' },
      { kind: 'tool' as const, id: '1', name: 'Read', status: 'done' as const, input: 'notes.txt\nmore', output: 'body' },
      { kind: 'tool' as const, id: '2', name: 'Bash', status: 'failed' as const, input: 'ls missing' },
      { kind: 'text' as const, text: '結論' },
      { kind: 'tool' as const, id: '3', name: 'Bash', status: 'stopped' as const }
    ];
    const timeline = mount(Conversation, { props: { tasks: [{ id: 't', provider: 'claude' as const, mode: 'read-only' as const, status: 'completed' as const, startedAt: 1, prompt: '問', output: '先看檔案結論', steps }] } });
    const parts = timeline.findAll('.assistant-message > .markdown, .assistant-message > details');
    expect(parts.map(part => part.element.tagName === 'DETAILS' ? part.get('strong').text() : part.text())).toEqual(['先看檔案', 'Read', 'Bash', '結論', 'Bash']);
    const tools = timeline.findAll('details.tool-step');
    expect(tools.map(tool => tool.get('.tool-dot').attributes('aria-label'))).toEqual(['完成', '失敗', '已停止']);
    expect(tools[0]!.get('.tool-summary').text()).toBe('notes.txt'); expect(tools[0]!.attributes('open')).toBeUndefined();
    expect(tools[0]!.findAll('.tool-io pre').map(pre => pre.text())).toEqual(['notes.txt\nmore', 'body']);
    expect(tools[2]!.find('.tool-io').exists()).toBe(false);
    timeline.unmount();
  });
  it('lets the user pick the account for this provider and a different account for the reviewer', async () => {
    const accounts = [{ id: 'a', provider: 'claude' as const, name: '公司', builtIn: true, loggedIn: true }, { id: 'b', provider: 'claude' as const, name: '個人', builtIn: false, loggedIn: false }];
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, initialDraft: '題目', provider: 'claude' as const, accounts, selectedAccounts: { claude: 'a' } } });
    const picker = wrapper.get('select[aria-label="帳號"]');
    expect(picker.findAll('option').map(option => option.text())).toEqual(['公司', '個人（未登入）']);
    await picker.setValue('b'); expect(wrapper.emitted('account')).toEqual([['claude', 'b']]);
    await wrapper.get('button.discussion-toggle').trigger('click');
    await wrapper.get('select[aria-label="審查帳號"]').setValue('b'); await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('discuss')?.at(-1)).toEqual(['題目', 4, 'claude', 'b']);
    await wrapper.setProps({ accounts: accounts.slice(0, 1) });
    expect(wrapper.find('select[aria-label="帳號"]').exists()).toBe(false);
    wrapper.unmount();
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
    expect(timeline.get('[role="alert"]').text()).toBe('找不到原始訊息，可能已刪除。');
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
  it('allows manual switching even if another provider is unavailable', async () => {
    const wrapper = mount(ProviderPicker, { props: { selected: 'claude', busy: false } });
    await wrapper.get('select').setValue('codex'); expect(wrapper.emitted('select')).toEqual([['codex']]); wrapper.unmount();
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
      await wrapper.get('select[aria-label="模型"]').setValue('test-model');
      await wrapper.get('select[aria-label="推理強度"]').setValue('high');
      await wrapper.get('textarea').setValue('讀取 README');
      await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
      expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send-message', provider: 'codex', text: '讀取 README', mode: 'workspace-write', preferences: { model: 'test-model', effort: 'high' } }));
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
