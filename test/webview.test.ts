// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import Composer from '../webview/src/components/Composer.vue';
import MessageBody from '../webview/src/components/MessageBody.vue';
import ProviderPicker from '../webview/src/components/ProviderPicker.vue';
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
