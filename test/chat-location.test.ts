import { describe, expect, it } from 'vitest';
import { chatLocation } from '../src/views/ChatLocation';
describe('Native chat sidebar location', () => {
  it.each(['1.106.0', '1.135.0', '2.0.0'])('uses the chat-side tabs on VS Code %s', version => {
    expect(chatLocation(version)).toEqual({ legacy: false, containerId: 'multiAgentChat', viewId: 'multiAgent.chatSecondary' });
  });
  it.each(['1.95.0', '1.105.2'])('retains an activity bar fallback on VS Code %s', version => {
    expect(chatLocation(version)).toEqual({ legacy: true, containerId: 'multiAgent', viewId: 'multiAgent.chat' });
  });
});
