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
    expect(wrapper.emitted('discuss')).toEqual([['Repository Pattern？', 2, 'codex']]);
    await wrapper.get('select[aria-label="審查 Agent"]').setValue('claude'); await wrapper.get('textarea').setValue('跨 Agent'); await wrapper.get('form').trigger('submit');
    expect(wrapper.emitted('discuss')?.at(-1)).toEqual(['跨 Agent', 2, 'claude']); expect(wrapper.emitted('send')).toBeUndefined();
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
