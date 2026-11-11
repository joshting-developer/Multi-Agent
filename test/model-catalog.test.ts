import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ProcessManager, type ProcessRequest } from '../src/execution/ProcessManager';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
class RpcFixture extends ProcessManager {
  constructor(private readonly scenario = 'ok') { super(); }
  override run(request: ProcessRequest) { return super.run({ ...request, command: process.execPath, args: [resolve('test/fixtures/agent.cjs'), 'codex', this.scenario, ...request.args] }); }
}
describe('Codex native model discovery', () => {
  it('initializes the RPC connection, paginates, and closes without starting a turn', async () => {
    const manager = new RpcFixture();
    const models = await new CodexModelCatalog(manager, () => process.execPath, process.cwd()).list();
    expect(models.map(model => model.id)).toEqual(['test-model', 'test-second']);
    expect(models[0]).toMatchObject({ isDefault: true, efforts: ['low', 'high'] });
    await manager.dispose();
  });
  it('reports discovery failure without inventing available models', async () => {
    const manager = new RpcFixture('rpc-error');
    await expect(new CodexModelCatalog(manager, () => process.execPath, process.cwd()).list()).rejects.toThrow(/模型清單/);
    await manager.dispose();
  });
});
