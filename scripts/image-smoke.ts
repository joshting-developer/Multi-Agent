import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { removeSmokeSessions } from './smoke-cleanup';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ProcessManager } from '../src/execution/ProcessManager';
import { AgentRegistry } from '../src/agents/AgentRegistry';
import { ClaudeCodeAdapter } from '../src/agents/ClaudeCodeAdapter';
import { CodexAppServerAdapter } from '../src/agents/CodexAppServerAdapter';
import { CodexModelCatalog } from '../src/settings/CodexModelCatalog';
import { Orchestrator } from '../src/orchestration/Orchestrator';
import { SessionRepository } from '../src/storage/SessionRepository';
import { AttachmentStore } from '../src/storage/AttachmentStore';
import type { AgentId } from '../src/bridge/messages';

/** 合成的 64×64 純紅 PNG；不送出任何專案內容。 */
function redPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data: Buffer) => { let c = 0xffffffff; for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 64 }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, () => [255, 0, 0]).flat())])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const provider = (process.env.TEST_PROVIDER ?? 'codex') as AgentId;
const directory = await realpath(await mkdtemp(join(tmpdir(), 'multi-agent-image-')));
const processes = new ProcessManager();
const startedAt = Date.now();
try {
  const adapter = provider === 'claude' ? new ClaudeCodeAdapter(processes, () => '', directory) : new CodexAppServerAdapter(processes, () => '', directory);
  const model = provider === 'claude' ? 'sonnet' : (await new CodexModelCatalog(processes, () => '', directory).list()).find(item => item.isDefault)?.id;
  assert.ok(model);
  const orchestrator = new Orchestrator(new AgentRegistry([adapter]), new SessionRepository({ get: () => undefined, update: async () => undefined }, directory), directory, () => true, () => 180000);
  orchestrator.attachmentStore = new AttachmentStore(join(directory, 'attachments'));
  await orchestrator.setPolicy({ classification: 'personal', allowedProviders: [provider] }); await orchestrator.checkProviders();
  const attachments = await orchestrator.attachmentStore.save(orchestrator.state.conversationId!, [{ mime: 'image/png', data: redPng().toString('base64') }]);
  const task = await orchestrator.send(provider, 'What single color fills the attached image? Reply with one English word only. Do not use tools.', 'read-only', { model, effort: 'low' }, 'ask', { attachments });
  console.log(JSON.stringify({ provider, status: task.status, output: task.output.slice(0, 80), error: task.error }));
  assert.equal(task.status, 'completed'); assert.match(task.output, /red/i);
  await orchestrator.dispose();
  console.log(`${provider}: image input smoke PASS`);
} finally { await processes.dispose(); await removeSmokeSessions(directory, startedAt); await rm(directory, { recursive: true, force: true }); }
