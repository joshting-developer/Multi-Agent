import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = typeof imageTypes[number];
/** 單張 5 MB、單則訊息最多 4 張且合計 10 MB；超過時拒絕，不壓縮或裁切。 */
export const imageLimits = { count: 4, bytes: 5 * 1024 * 1024, total: 10 * 1024 * 1024 };
export interface StoredAttachment { id: string; mime: ImageType; bytes: number }

/** 依檔頭判斷實際格式，不相信 MIME 或副檔名。 */
export function sniffImage(data: Buffer): ImageType | undefined {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length > 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

/**
 * 使用者貼上的圖片存在 Extension 儲存區 attachments/<對話>/<id>（0600），檔名只由這裡產生，
 * Agent 收到的是圖片內容本身，不是本機路徑；刪除對話或清除專案時一併刪除。
 */
export class AttachmentStore {
  constructor(private readonly root: string) {}
  validate(items: Array<{ mime: string; data: string }>): Array<{ mime: ImageType; data: Buffer }> {
    if (items.length > imageLimits.count) throw new Error(`一則訊息最多 ${imageLimits.count} 張圖片。`);
    const images = items.map(item => {
      const data = Buffer.from(item.data, 'base64');
      const mime = sniffImage(data);
      if (!mime) throw new Error('只支援 PNG、JPEG、GIF、WebP 圖片。');
      if (data.length > imageLimits.bytes) throw new Error('單張圖片不能超過 5 MB。');
      return { mime, data };
    });
    if (images.reduce((sum, image) => sum + image.data.length, 0) > imageLimits.total) throw new Error('圖片合計不能超過 10 MB。');
    return images;
  }
  async save(conversationId: string, items: Array<{ mime: string; data: string }>): Promise<StoredAttachment[]> {
    const images = this.validate(items);
    const dir = join(this.root, safe(conversationId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return Promise.all(images.map(async image => {
      const id = randomUUID();
      await writeFile(join(dir, id), image.data, { mode: 0o600 });
      return { id, mime: image.mime, bytes: image.data.length };
    }));
  }
  async read(conversationId: string, id: string): Promise<string> {
    const path = join(this.root, safe(conversationId), safe(id));
    try { return (await readFile(path)).toString('base64'); }
    catch { throw new Error('附件已不存在，請重新貼上圖片。'); }
  }
  async removeConversation(conversationId: string): Promise<void> { await rm(join(this.root, safe(conversationId)), { recursive: true, force: true }); }
}
/** 只接受 UUID 形式的名稱，避免路徑跳脫。 */
function safe(name: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) throw new Error('附件識別碼無效。');
  return name;
}
