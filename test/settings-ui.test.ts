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
  it('lists named accounts per provider with identity, login state and per-account actions', async () => {
    const { default: Accounts } = await import('../webview/src/components/AccountSettings.vue');
    const accounts = [
      { id: 'main-codex', provider: 'codex' as const, name: '主帳號', loggedIn: true, account: { type: 'chatgpt', email: 'user@example.test', plan: 'pro' } },
      { id: 'work', provider: 'claude' as const, name: '公司 Claude', loggedIn: false },
      { id: 'me', provider: 'claude' as const, name: '個人', loggedIn: true, account: { type: 'claude.ai', email: 'me@example.test' } }
    ];
    const wrapper = mount(Accounts, { props: { checking: false, accounts, selected: { codex: 'main-codex', claude: 'me' } } });
    expect(wrapper.text()).toContain('user@example.test · pro'); expect(wrapper.text()).toContain('公司 Claude'); expect(wrapper.text()).toContain('未登入');
    const work = wrapper.findAll('.account-row').find(row => row.text().includes('公司 Claude'))!;
    expect(work.findAll('button').map(button => button.text())).toEqual(['設為使用中', '登入', '重新命名', '移除']);
    expect(work.get('button').attributes('disabled')).toBeDefined();
    await work.findAll('button')[1]!.trigger('click'); await work.findAll('button')[3]!.trigger('click');
    expect(wrapper.emitted('terminal')).toEqual([['work', 'login']]); expect(wrapper.emitted('remove')).toEqual([['work']]);
    const personal = wrapper.findAll('.account-row').find(row => row.text().includes('me@example.test'))!;
    expect(personal.text()).toContain('使用中'); expect(personal.findAll('button').map(button => button.text())).toEqual(['登出', '重新命名', '移除']);
    // 不用先取名：直接新增並登入，名稱在登入後由帳戶帶入。
    expect(wrapper.find('.account-add input').exists()).toBe(false);
    await wrapper.findAll('.account-add')[1]!.trigger('submit');
    expect(wrapper.emitted('add')).toEqual([['claude']]);
    // API Key：選了方式才出現密碼欄位，沒填 Key 不能送出，送出後清空。
    const codexAdd = wrapper.findAll('.account-add')[0]!;
    expect(codexAdd.find('input[type="password"]').exists()).toBe(false);
    await codexAdd.get('select').setValue('api-key');
    expect(codexAdd.get('button').attributes('disabled')).toBeDefined(); expect(codexAdd.get('button').text()).toBe('新增');
    await codexAdd.get('input[type="password"]').setValue(' sk-test '); await codexAdd.trigger('submit');
    expect(wrapper.emitted('add')![1]).toEqual(['codex', 'sk-test']);
    expect((codexAdd.get('input[type="password"]').element as HTMLInputElement).value).toBe('');
    await wrapper.setProps({ accounts: [...accounts, { id: 'key', provider: 'claude' as const, name: 'Claude API', method: 'api-key' as const, loggedIn: true }] });
    const keyRow = wrapper.findAll('.account-row').find(row => row.text().includes('Claude API'))!;
    expect(keyRow.text()).toContain('API Key'); expect(keyRow.findAll('button').map(button => button.text())).toEqual(['設為使用中', '重新命名', '移除']);
    await wrapper.setProps({ accounts: [...accounts, { id: 'twin', provider: 'codex' as const, name: '第二個', loggedIn: true, account: { type: 'chatgpt', email: 'user@example.test' } }] });
    const rows = wrapper.findAll('.account-row').map(row => row.text());
    expect(rows.find(text => text.startsWith('第二個'))).toContain('與「主帳號」是同一個帳戶'); expect(rows.find(text => text.startsWith('主帳號'))).toContain('與「第二個」是同一個帳戶');
    expect(wrapper.findAll('.account-row').find(row => row.text().includes('公司 Claude'))!.text()).not.toContain('同一個帳戶');
    await personal.findAll('button')[1]!.trigger('click'); await wrapper.get('.account-rename input').setValue('私人'); await wrapper.get('.account-rename').trigger('submit');
    expect(wrapper.emitted('rename')).toEqual([['me', '私人']]);
    // 重新整理在所有帳號卡片之前，不用捲到底。
    expect(wrapper.element.firstElementChild?.textContent).toContain('重新整理登入資訊');
    await wrapper.findAll('button').find(button => button.text().includes('重新整理'))!.trigger('click'); expect(wrapper.emitted('refresh')).toHaveLength(1); wrapper.unmount();
  });
  it('shows how much quota is left so an exhausted window reads as 0%', async () => {
    const { default: Accounts } = await import('../webview/src/components/AccountSettings.vue');
    const usage = { source: 'official' as const, updatedAt: 1, blocked: true, windows: [{ label: '5 小時', usedPercent: 100, resetsAt: 2 }, { label: '7 天', usedPercent: 31 }] };
    const wrapper = mount(Accounts, { props: { checking: false, accounts: [{ id: 'a', provider: 'codex' as const, name: 'a', loggedIn: true, usage }], selected: { codex: 'a' } } });
    const rows = wrapper.findAll('.usage-window');
    expect(rows[0]!.text()).toContain('剩 0%'); expect(rows[1]!.text()).toContain('剩 69%');
    expect((rows[0]!.get('meter').element as HTMLMeterElement).getAttribute('aria-label')).toBe('5 小時 剩餘 0%');
    expect(wrapper.text()).not.toContain('最近一次執行'); expect(wrapper.find('.usage-note').text()).toBe('目前額度已用完');
    expect(wrapper.find('.usage-note').text()).not.toContain('重置券'); expect(wrapper.findAll('button').some(button => button.text() === '使用重置券')).toBe(false);
    await wrapper.setProps({ accounts: [{ id: 'a', provider: 'codex' as const, name: 'a', loggedIn: true, usage: { ...usage, resetCredits: 2 } }] });
    expect(wrapper.find('.usage-note').text()).toContain('重置券 2 張');
    await wrapper.findAll('button').find(button => button.text() === '使用重置券')!.trigger('click');
    expect(wrapper.emitted('reset')).toEqual([['a']]);
    await wrapper.setProps({ accounts: [{ id: 'a', provider: 'codex' as const, name: 'a', loggedIn: true, usage: { ...usage, blocked: false } }] });
    expect(wrapper.find('.usage-note').exists()).toBe(false);
    // 有明細時每張券各自一個「使用」，不再顯示由官方挑券的按鈕。
    await wrapper.setProps({ accounts: [{ id: 'a', provider: 'codex' as const, name: 'a', loggedIn: true, usage: { ...usage, resetCredits: 2, resetCreditList: [{ id: 'soon', title: 'Full reset', expiresAt: new Date(2026, 11, 5).getTime() }, { id: 'late', expiresAt: new Date(2026, 11, 12).getTime() }] } }] });
    const credits = wrapper.findAll('.credit-list li');
    expect(credits.map(item => item.text())).toEqual(['Full reset · 12/5 到期使用', '重置券 · 12/12 到期使用']);
    expect(wrapper.findAll('button').some(button => button.text() === '使用重置券')).toBe(false);
    await credits[1]!.get('button').trigger('click');
    expect(wrapper.emitted('reset')).toEqual([['a'], ['a', 'late']]);
    wrapper.unmount();
  });
  it('searches and opens saved conversations through the history panel', async () => {
    const { default: History } = await import('../webview/src/components/HistoryPanel.vue');
    const wrapper = mount(History, { props: { conversations: [{ id: 'one', title: '注入失敗修復', createdAt: 1, updatedAt: 1 }], busy: false, searching: false } });
    await wrapper.get('input').setValue('注入'); await new Promise(resolve => setTimeout(resolve, 210));
    expect(wrapper.emitted('search')).toEqual([['注入', {}]]);
    await wrapper.setProps({ providers: ['codex'] });
    expect(wrapper.findAll('select[aria-label="Agent"] option').map(option => option.text())).toEqual(['全部 Agent', 'Codex']);
    await wrapper.get('select[aria-label="Agent"]').setValue('codex'); await wrapper.get('select[aria-label="類型"]').setValue('discussion'); await wrapper.get('select[aria-label="時間"]').setValue('7');
    await new Promise(resolve => setTimeout(resolve, 210));
    const [, filters] = wrapper.emitted('search')!.at(-1) as [string, { provider: string; mode: string; since: number }];
    expect(filters).toMatchObject({ provider: 'codex', mode: 'discussion' }); expect(Date.now() - filters.since).toBeGreaterThan(6.9 * 86400000);
    await wrapper.setProps({ conversations: [{ id: 'one', title: '注入失敗修復', createdAt: 1, updatedAt: 1, preview: '…注入失敗…', match: { runId: 'r', at: Date.UTC(2026, 10, 3), provider: 'claude' as const, discussion: true } }] });
    expect(wrapper.get('.history-open small').text()).toContain('Claude'); expect(wrapper.get('.history-open small').text()).toContain('討論');
    await wrapper.get('.history-open').trigger('click'); expect(wrapper.emitted('open')).toEqual([['one', { runId: 'r', at: Date.UTC(2026, 10, 3), provider: 'claude', discussion: true }]]);
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
