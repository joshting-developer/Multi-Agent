import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../src/settings/SettingsService';
import { defaultSettings } from '../src/bridge/settings';
import { configValues, configuration } from './fixtures/vscode';
const service = () => new SettingsService({ list: async () => [{ id: 'model-a', label: 'Model A', efforts: ['low', 'high'], isDefault: true }] });
beforeEach(() => { configValues.clear(); vi.clearAllMocks(); });
describe('Persistent provider and chat settings', () => {
  it('saves model, effort, timeout and chat preferences to VS Code settings', async () => {
    const settings = service(); await settings.refreshModels();
    await settings.save({ ...defaultSettings, sendShortcut: 'modifier-enter', defaultMode: 'read-only', replyLanguage: 'zh-TW', codex: { model: 'model-a', effort: 'high' } });
    expect(settings.read()).toMatchObject({ sendShortcut: 'modifier-enter', defaultMode: 'read-only', replyLanguage: 'zh-TW', codex: { model: 'model-a', effort: 'high' } });
    expect(configuration.update).toHaveBeenCalledWith('codexModel', 'model-a', 1);
  });
  it('serializes changes so providers cannot overwrite each other', async () => {
    const settings = service();
    await Promise.all([settings.setProvider('codex', { model: 'model-a', effort: 'high' }), settings.setProvider('claude', { model: 'opus', effort: 'medium' })]);
    expect(settings.read().codex).toEqual({ model: 'model-a', effort: 'high' });
    expect(settings.read().claude).toEqual({ model: 'opus', effort: 'medium' });
  });
  it('rejects invalid paths and unsupported efforts before writing any setting', async () => {
    const settings = service(); await settings.refreshModels();
    await expect(settings.save({ ...defaultSettings, codexPath: 'codex --yolo' })).rejects.toThrow(/絕對路徑/);
    await expect(settings.save({ ...defaultSettings, codex: { model: 'model-a', effort: 'ultra' } })).rejects.toThrow(/不支援/);
    expect(configuration.update).not.toHaveBeenCalled();
  });
  it('defaults to GPT-6.1-Sol and Opus 5.5 at medium effort, falling back to the Codex default when that model is gone', async () => {
    const listed = new SettingsService({ list: async () => [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high'], isDefault: true, recommendedEffort: 'low' }] });
    await listed.refreshModels();
    expect(listed.read().codex).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' });
    expect(listed.read().claude).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(listed.models.claude[0]).toMatchObject({ id: 'claude-opus-5-5', label: 'Opus 5.5' });
    const missing = service(); await missing.refreshModels();
    expect(missing.read().codex.model).toBe('model-a');
  });
  it('keeps a manual model ID usable when discovery is unavailable', async () => {
    const settings = new SettingsService({ list: async () => { throw new Error('offline'); } });
    await settings.refreshModels();
    expect(settings.models.error).toBe('offline');
    await settings.setProvider('codex', { model: 'custom-model', effort: 'medium' });
    expect(settings.read().codex.model).toBe('custom-model');
  });
});
