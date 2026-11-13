// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ModelFields from '../webview/src/components/ModelFields.vue';
import Composer from '../webview/src/components/Composer.vue';
import { defaultSettings } from '../src/bridge/settings';
describe('Model and settings UI', () => {
  it('applies the configured send shortcut and default file permission', async () => {
    const wrapper = mount(Composer, { props: { busy: false, running: false, canSend: true, canWrite: true, initialDraft: 'analyze', sendShortcut: 'modifier-enter', defaultMode: 'read-only' } });
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toBeUndefined();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true });
    expect(wrapper.emitted('send')?.[0]).toEqual(['analyze', 'read-only', 'ask']);
    wrapper.unmount();
  });
  it('uses model-specific efforts and resets an incompatible previous selection', async () => {
    const wrapper = mount(ModelFields, { props: { provider: 'codex', value: { model: 'large', effort: 'ultra' }, models: [
      { id: 'large', label: 'Large', efforts: ['high', 'ultra'] }, { id: 'small', label: 'Small', efforts: ['low'] }
    ] } });
    expect(wrapper.get('select[aria-label="推理強度"]').text()).toContain('Ultra');
    await wrapper.get('select[aria-label="模型"]').setValue('small');
    expect(wrapper.emitted('change')?.[0]).toEqual([{ model: 'small', effort: 'low' }]);
    wrapper.unmount();
  });
  it('lets users edit and persist real settings in the dedicated editor page', async () => {
    const api = { postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() };
    vi.stubGlobal('acquireVsCodeApi', () => api);
    const { default: SettingsApp } = await import('../webview/src/SettingsApp.vue');
    const wrapper = mount(SettingsApp);
    const snapshot = { workspace: '/workspace', trusted: true, checking: false, tasks: [], providers: [], policy: { classification: 'personal', allowedProviders: ['codex'] }, settings: defaultSettings, models: { codex: [{ id: 'test-model', label: 'Test Model', efforts: ['low', 'high'] }], claude: [], loading: false } };
    try {
      window.dispatchEvent(new MessageEvent('message', { data: { version: 1, type: 'snapshot', snapshot } })); await nextTick();
      await wrapper.get('input[aria-label="任務時間上限"]').setValue(600);
      await wrapper.get('select[aria-label="傳送快捷鍵"]').setValue('modifier-enter');
      await wrapper.findAll('nav button')[1]!.trigger('click');
      await wrapper.get('select[aria-label="模型"]').setValue('test-model');
      await wrapper.get('select[aria-label="推理強度"]').setValue('high');
      await wrapper.get('form').trigger('submit');
      expect(api.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'save-settings', settings: expect.objectContaining({ timeoutSeconds: 600, sendShortcut: 'modifier-enter', codex: { model: 'test-model', effort: 'high' } }) }));
    } finally { wrapper.unmount(); vi.unstubAllGlobals(); }
  });
});

describe('Explicit models, accounts and history controls', () => {
  it('never offers an ambiguous model or reasoning default', () => {
    const wrapper = mount(ModelFields, { props: { provider: 'codex', value: { model: 'model-a', effort: 'high' }, models: [{ id: 'model-a', label: 'Model A', efforts: ['high'] }] } });
    expect(wrapper.text()).not.toContain('預設');
    expect(wrapper.find('option[value=""]').exists()).toBe(false);
    expect(wrapper.find('option[value="default"]').exists()).toBe(false); wrapper.unmount();
  });
  it('displays provider identity and plan information from host metadata', async () => {
    const { default: Accounts } = await import('../webview/src/components/AccountSettings.vue');
    const wrapper = mount(Accounts, { props: { checking: false, providers: [{ id: 'codex', status: 'ready', account: { type: 'chatgpt', email: 'user@example.test', plan: 'pro' }, capabilities: { streaming: true, readOnly: true, workspaceWrite: true, resumeSession: false, toolApproval: true, structuredOutput: true } }] } });
    expect(wrapper.text()).toContain('user@example.test'); expect(wrapper.text()).toContain('pro');
    await wrapper.get('button').trigger('click'); expect(wrapper.emitted('refresh')).toHaveLength(1); wrapper.unmount();
  });
  it('searches and opens saved conversations through the history panel', async () => {
    const { default: History } = await import('../webview/src/components/HistoryPanel.vue');
    const wrapper = mount(History, { props: { conversations: [{ id: 'one', title: '注入失敗修復', createdAt: 1, updatedAt: 1 }], busy: false, searching: false } });
    await wrapper.get('input').setValue('注入'); await new Promise(resolve => setTimeout(resolve, 210));
    expect(wrapper.emitted('search')).toEqual([['注入']]);
    await wrapper.get('.history-open').trigger('click'); expect(wrapper.emitted('open')).toEqual([['one']]);
    await wrapper.setProps({ conversations: [{ id: 'one', title: '背景', createdAt: 1, updatedAt: 1, activity: 'waiting' as const }] });
    expect(wrapper.get('.history-open small').text()).toContain('等待核准'); wrapper.unmount();
  });
  it('round-trips the approval card choice', async () => {
    const { default: Approval } = await import('../webview/src/components/ApprovalCard.vue');
    const wrapper = mount(Approval, { props: { request: { id: 'approve-one', taskId: 'task', provider: 'codex', title: '核准執行命令', detail: 'echo synthetic' } } });
    await wrapper.get('.primary-button').trigger('click'); expect(wrapper.emitted('answer')).toEqual([['approve-one', true]]);
    expect(wrapper.text()).not.toContain('背景對話'); await wrapper.setProps({ background: true }); expect(wrapper.get('strong').text()).toContain('背景對話');
    wrapper.unmount();
  });
});
