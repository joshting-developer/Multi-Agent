import type { AgentId, ProviderStatus } from '../bridge/messages';
import type { AgentAdapter } from './AgentAdapter';
export class AgentRegistry {
  constructor(private readonly adapters: AgentAdapter[]) {}
  get(id: AgentId): AgentAdapter {
    const adapter = this.adapters.find(adapter => adapter.id === id);
    if (!adapter) throw new Error('未知的 Provider。');
    return adapter;
  }
  async detect(): Promise<ProviderStatus[]> { return Promise.all(this.adapters.map(adapter => adapter.detect())); }
}
