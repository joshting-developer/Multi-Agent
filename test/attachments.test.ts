import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentStore, sniffImage } from '../src/storage/AttachmentStore';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function store() { const dir = await mkdtemp(join(tmpdir(), 'multi-agent-attachments-')); dirs.push(dir); return { dir, attachments: new AttachmentStore(dir) }; }

describe('Pasted image attachments', () => {
  it('identifies the real format from file headers rather than the declared type', () => {
    expect(sniffImage(png)).toBe('image/png'); expect(sniffImage(jpeg)).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBe('image/gif'); expect(sniffImage(Buffer.from('RIFF....WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });
  it('stores validated images per conversation with private permissions and removes them with the conversation', async () => {
    const { dir, attachments } = await store(); const conversation = 'c0ffee00-0000-4000-8000-000000000001';
    const saved = await attachments.save(conversation, [{ mime: 'image/jpeg', data: png.toString('base64') }, { mime: 'image/jpeg', data: jpeg.toString('base64') }]);
    expect(saved.map(item => [item.mime, item.bytes])).toEqual([['image/png', png.length], ['image/jpeg', jpeg.length]]);
    expect((await stat(join(dir, conversation, saved[0]!.id))).mode & 0o777).toBe(0o600);
    expect(await attachments.read(conversation, saved[0]!.id)).toBe(png.toString('base64'));
    await attachments.removeConversation(conversation);
    expect(await readdir(dir)).toEqual([]); await expect(attachments.read(conversation, saved[0]!.id)).rejects.toThrow(/不存在/);
  });
  it('rejects non-images, oversized or too many images, and path tricks', async () => {
    const { attachments } = await store(); const id = 'c0ffee00-0000-4000-8000-000000000002';
    await expect(attachments.save(id, [{ mime: 'image/png', data: Buffer.from('not an image').toString('base64') }])).rejects.toThrow(/只支援/);
    await expect(attachments.save(id, [{ mime: 'image/png', data: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]).toString('base64') }])).rejects.toThrow(/5 MB/);
    await expect(attachments.save(id, Array.from({ length: 5 }, () => ({ mime: 'image/png', data: png.toString('base64') })))).rejects.toThrow(/4 張/);
    const three = Buffer.concat([png, Buffer.alloc(3.5 * 1024 * 1024)]).toString('base64');
    await expect(attachments.save(id, [three, three, three].map(data => ({ mime: 'image/png', data })))).rejects.toThrow(/10 MB/);
    await expect(attachments.read('../etc', 'passwd')).rejects.toThrow(/無效/); await expect(attachments.save('../x', [{ mime: 'image/png', data: png.toString('base64') }])).rejects.toThrow(/無效/);
  });
});
